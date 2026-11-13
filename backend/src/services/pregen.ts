/**
 * Vorgenerierung über Chunky.
 *
 * Das Panel spricht Chunky ausschließlich über Konsolenbefehle an
 * (`chunky start`, `pause`, `continue`, `cancel`) und liest den Fortschritt
 * mit `chunky progress` per RCON – dieselbe Meldung, die Chunky auch ins
 * Serverprotokoll schreibt („Task running for … Processed: … chunks (…%),
 * ETA: h:mm:ss, Rate: … cps, Current: x, z“, siehe Chunkys en.json).
 *
 * Der Auftrag liegt zusätzlich im Panel (Einstellung `pregen.<serverId>`):
 * - Nach einem Neustart des Servers setzt das Panel ihn selbst fort – Chunky
 *   tut das von sich aus nicht (`continue-on-restart: false`).
 * - Auf Wunsch pausiert es, solange Spieler online sind oder die TPS unter
 *   15 fallen, und macht danach weiter.
 * - Während der Generierung kann BlueMap das Rendern aussetzen
 *   (`bluemap stop`/`bluemap start`), damit beide sich nicht die CPU teilen.
 */
import type { Server } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { badRequest, conflict } from '../lib/errors.js';
import { sendServerCommand } from './consoleCommand.js';
import { contentKindFor } from './content.js';
import * as dockerSvc from './docker.js';
import { acceptBlueMapDownload, installedAddon } from './mapAddons.js';
import { remainingDiskBytes } from './quota.js';
import { listPlayers, rconCommand } from './rcon.js';
import { levelName, type Dimension } from './regionScan.js';
import { withQueuedOperation } from './operations.js';
import { deleteSetting, getSetting, setSetting } from './settings.js';
import { getTickMetrics } from './tickMetrics.js';

const KEY = (serverId: string) => `pregen.${serverId}`;
/** Ungefährer Platzbedarf eines generierten Chunks auf der Platte. */
export const BYTES_PER_CHUNK = 10 * 1024;
const TPS_PAUSE = 15;
const TPS_RESUME = 18;

export const pregenInputSchema = z.object({
  dimension: z.enum(['overworld', 'nether', 'end']).default('overworld'),
  shape: z.enum(['circle', 'square']).default('circle'),
  centerX: z.number().int().min(-29_999_000).max(29_999_000).default(0),
  centerZ: z.number().int().min(-29_999_000).max(29_999_000).default(0),
  radius: z.number().int().min(100).max(50_000),
  onlyWhenEmpty: z.boolean().default(false),
  tpsGuard: z.boolean().default(true),
  pauseRender: z.boolean().default(true),
});
export type PregenInput = z.infer<typeof pregenInputSchema>;

export type PregenStatus = 'running' | 'paused' | 'done' | 'cancelled' | 'failed';
/** Warum ein laufender Auftrag gerade nicht arbeitet */
export type AutoPause = 'players' | 'tps' | 'stopped' | null;

export interface PregenJob extends PregenInput {
  status: PregenStatus;
  autoPaused: AutoPause;
  /** Weltbezeichnung, wie Chunky sie erwartet und meldet */
  world: string;
  processed: number;
  percent: number;
  /** Chunks im Bereich (Schätzung, bis Chunky selbst rechnet) */
  total: number;
  rate: number | null;
  etaSeconds: number | null;
  current: { x: number; z: number } | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  message: string | null;
  startedBy: string;
}

export interface ServerMapSettings {
  job: PregenJob | null;
  /** Zustimmung zum Download der Mojang-Ressourcen für BlueMap */
  bluemapAccepted: boolean;
}

const EMPTY: ServerMapSettings = { job: null, bluemapAccepted: false };

export async function getMapSettings(serverId: string): Promise<ServerMapSettings> {
  try {
    const raw = await getSetting(KEY(serverId), '');
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<ServerMapSettings>) } : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

export async function saveMapSettings(serverId: string, next: ServerMapSettings): Promise<void> {
  await setSetting(KEY(serverId), JSON.stringify(next));
}

async function updateJob(serverId: string, change: (job: PregenJob) => void): Promise<PregenJob | null> {
  const settings = await getMapSettings(serverId);
  if (!settings.job) return null;
  change(settings.job);
  settings.job.updatedAt = new Date().toISOString();
  await saveMapSettings(serverId, settings);
  return settings.job;
}

// ---------------------------------------------------------------------------
// Chunkys Meldungen lesen
// ---------------------------------------------------------------------------

export interface ChunkyUpdate {
  world: string;
  processed: number;
  percent: number;
  etaSeconds: number | null;
  rate: number | null;
  current: { x: number; z: number } | null;
  finished: boolean;
}

const UPDATE = /Task running for (\S+)\. Processed: ([\d.,']+) chunks \(([\d.,]+)%\), ETA: (\d+):(\d+):(\d+), Rate: ([\d.,]+) cps, Current: (-?\d+), (-?\d+)/;
const DONE = /Task finished for (\S+)\. Processed: ([\d.,']+) chunks \(([\d.,]+)%\)/;

const decimal = (value: string) => Number(value.replace(',', '.'));
const integer = (value: string) => Number(value.replace(/[^\d]/g, ''));

/** Alle Fortschrittsmeldungen eines Textes (RCON-Antwort oder Protokoll). */
export function parseChunky(text: string): ChunkyUpdate[] {
  const updates: ChunkyUpdate[] = [];
  for (const raw of text.replace(/§./g, '').split(/\r?\n/)) {
    const update = UPDATE.exec(raw);
    if (update) {
      updates.push({
        world: update[1], processed: integer(update[2]), percent: decimal(update[3]),
        etaSeconds: Number(update[4]) * 3600 + Number(update[5]) * 60 + Number(update[6]),
        rate: decimal(update[7]), current: { x: Number(update[8]), z: Number(update[9]) }, finished: false,
      });
      continue;
    }
    const done = DONE.exec(raw);
    if (done) {
      updates.push({ world: done[1], processed: integer(done[2]), percent: decimal(done[3]), etaSeconds: 0, rate: null, current: null, finished: true });
    }
  }
  return updates;
}

/** Letzte Meldung für genau diese Welt. */
export function latestFor(world: string, updates: ChunkyUpdate[]): ChunkyUpdate | null {
  for (let i = updates.length - 1; i >= 0; i--) if (updates[i].world === world) return updates[i];
  return null;
}

/**
 * Weltname für Chunky. Mod-Loader nennen Dimensionen beim Schlüssel
 * („minecraft:the_nether“), Bukkit-Abkömmlinge beim Ordner („world_nether“).
 */
export async function chunkyWorld(server: Server, dimension: Dimension): Promise<string> {
  if (contentKindFor(server.type) === 'plugin') {
    const level = await levelName(server.id);
    return dimension === 'overworld' ? level : dimension === 'nether' ? `${level}_nether` : `${level}_the_end`;
  }
  return { overworld: 'minecraft:overworld', nether: 'minecraft:the_nether', end: 'minecraft:the_end' }[dimension];
}

export function estimateChunks(shape: PregenInput['shape'], radius: number): number {
  const chunkRadius = radius / 16;
  return Math.round(shape === 'circle' ? Math.PI * chunkRadius * chunkRadius : 4 * chunkRadius * chunkRadius);
}

// ---------------------------------------------------------------------------
// Befehle
// ---------------------------------------------------------------------------

async function command(server: Server, line: string): Promise<string> {
  return (await sendServerCommand(server, line)).response.replace(/§./g, '');
}

async function assertRunning(server: Server): Promise<void> {
  const { state } = await dockerSvc.getState(server);
  if (state !== 'running') throw conflict('Der Server muss laufen, damit Chunky Befehle annimmt.');
}

async function startPregenUnlocked(server: Server, input: PregenInput, userId: string): Promise<PregenJob> {
  const settings = await getMapSettings(server.id);
  if (settings.job && settings.job.status === 'running') {
    throw conflict('Es läuft bereits eine Vorgenerierung. Erst pausieren oder abbrechen.');
  }
  if (!(await installedAddon(server, 'chunky'))) throw badRequest('Chunky ist auf diesem Server nicht installiert.');
  await assertRunning(server);

  const total = estimateChunks(input.shape, input.radius);
  const remaining = await remainingDiskBytes(server);
  if (Number.isFinite(remaining) && total * BYTES_PER_CHUNK > remaining) {
    const needed = (total * BYTES_PER_CHUNK / 1024 ** 3).toFixed(1);
    throw badRequest(`Das passt nicht ins Speicherkontingent: geschätzt ${needed} GB nötig. Radius verkleinern oder Kontingent anheben.`);
  }

  const world = await chunkyWorld(server, input.dimension);
  const shape = input.shape === 'circle' ? 'circle' : 'square';
  // Fortschrittsmeldungen im Protokoll ausdünnen – das Panel fragt selbst nach.
  await command(server, 'chunky quiet 30').catch(() => '');
  let response = await command(server, `chunky start ${world} ${shape} ${input.centerX} ${input.centerZ} ${input.radius}`);
  if (/not found/i.test(response)) throw badRequest(`Chunky kennt die Welt nicht: ${response.trim()}`);
  if (/Task already started for/i.test(response)) throw conflict('Chunky arbeitet für diese Welt bereits an einem Auftrag. Erst abbrechen.');
  // Liegt noch ein gespeicherter Auftrag vor (oder warnt Chunky wegen Platz – das
  // hat das Panel eben selbst geprüft), fragt Chunky nach einer Bestätigung.
  if (/type '/i.test(response)) response = await command(server, 'chunky confirm');
  if (/limited the maximum/i.test(response)) throw badRequest(response.trim());

  if (input.pauseRender && await installedAddon(server, 'bluemap')) await command(server, 'bluemap stop').catch(() => '');

  const now = new Date().toISOString();
  const job: PregenJob = {
    ...input, world, status: 'running', autoPaused: null, processed: 0, percent: 0, total,
    rate: null, etaSeconds: null, current: null, startedAt: now, updatedAt: now, finishedAt: null,
    message: null, startedBy: userId,
  };
  await saveMapSettings(server.id, { ...settings, job });
  return job;
}

async function pausePregenUnlocked(server: Server): Promise<PregenJob> {
  const settings = await getMapSettings(server.id);
  const job = settings.job;
  if (!job || job.status !== 'running') throw conflict('Es läuft keine Vorgenerierung.');
  if (!job.autoPaused) {
    await assertRunning(server);
    await command(server, `chunky pause ${job.world}`);
  }
  return (await updateJob(server.id, (j) => { j.status = 'paused'; j.autoPaused = null; j.rate = null; j.etaSeconds = null; }))!;
}

async function resumePregenUnlocked(server: Server): Promise<PregenJob> {
  const settings = await getMapSettings(server.id);
  const job = settings.job;
  if (!job || job.status !== 'paused') throw conflict('Es gibt keine pausierte Vorgenerierung.');
  await assertRunning(server);
  const response = await command(server, `chunky continue ${job.world}`);
  if (/No tasks to continue/i.test(response)) {
    await updateJob(server.id, (j) => { j.status = 'failed'; j.message = 'Chunky hat den Auftrag nicht mehr gespeichert – bitte neu starten.'; });
    throw conflict('Chunky hat den Auftrag nicht mehr gespeichert – bitte neu starten.');
  }
  return (await updateJob(server.id, (j) => { j.status = 'running'; j.autoPaused = null; j.message = null; }))!;
}

async function cancelPregenUnlocked(server: Server): Promise<PregenJob | null> {
  const settings = await getMapSettings(server.id);
  const job = settings.job;
  if (!job) return null;
  const { state } = await dockerSvc.getState(server);
  if (state === 'running' && (job.status === 'running' || job.status === 'paused')) {
    const response = await command(server, `chunky cancel ${job.world}`);
    if (/type '/i.test(response)) await command(server, 'chunky confirm');
    if (job.pauseRender && await installedAddon(server, 'bluemap')) await command(server, 'bluemap start').catch(() => '');
  }
  return updateJob(server.id, (j) => {
    if (j.status === 'running' || j.status === 'paused') {
      j.status = 'cancelled';
      j.finishedAt = new Date().toISOString();
    }
    j.autoPaused = null; j.rate = null; j.etaSeconds = null;
  });
}

/** Erledigten oder abgebrochenen Auftrag aus der Anzeige nehmen. */
export async function clearPregen(serverId: string): Promise<void> {
  const settings = await getMapSettings(serverId);
  if (settings.job && (settings.job.status === 'running' || settings.job.status === 'paused')) {
    throw conflict('Ein laufender Auftrag lässt sich nur abbrechen.');
  }
  await saveMapSettings(serverId, { ...settings, job: null });
}

// ---------------------------------------------------------------------------
// Überwachung
// ---------------------------------------------------------------------------

const lastResume = new Map<string, number>();
const busy = new Set<string>();
const acceptApplied = new Set<string>();

/** Ein Durchlauf für einen Server: Fortschritt lesen, automatische Pausen, Fortsetzen nach Neustart. */
async function monitorServerUnlocked(server: Server): Promise<void> {
  if (busy.has(server.id)) return;
  busy.add(server.id);
  try {
    const settings = await getMapSettings(server.id);
    const { state } = await dockerSvc.getState(server);

    // Zustimmung eintragen, sobald BlueMap seine Konfiguration angelegt hat –
    // danach nicht mehr bei jedem Durchlauf nachsehen.
    if (state === 'running' && settings.bluemapAccepted && !acceptApplied.has(server.id)) {
      const result = await acceptBlueMapDownload(server);
      if (result === 'changed') await command(server, 'bluemap reload').catch(() => '');
      if (result !== 'missing') acceptApplied.add(server.id);
    }

    const job = settings.job;
    if (!job || job.status !== 'running') return;

    if (state !== 'running') {
      if (job.autoPaused !== 'stopped') await updateJob(server.id, (j) => { j.autoPaused = 'stopped'; j.rate = null; j.etaSeconds = null; });
      return;
    }

    // Fortschritt lesen – erst per RCON, notfalls aus dem Protokoll.
    const reply = await rconCommand(server, 'chunky progress').catch(() => '');
    let update = latestFor(job.world, parseChunky(reply));
    const idle = /No tasks running/i.test(reply);
    if (!update && !idle) update = latestFor(job.world, parseChunky(await dockerSvc.tailLogs(server, 200).catch(() => '')));

    if (update?.finished || (update && update.percent >= 100)) {
      await finish(server, job, update);
      return;
    }
    if (update && !update.finished) {
      await updateJob(server.id, (j) => {
        j.processed = update!.processed;
        j.percent = update!.percent;
        if (update!.percent > 0.5) j.total = Math.round(update!.processed / (update!.percent / 100));
        j.rate = update!.rate;
        j.etaSeconds = update!.etaSeconds;
        j.current = update!.current;
        if (j.autoPaused === 'stopped') j.autoPaused = null;
      });
    }

    if (idle && (job.autoPaused === null || job.autoPaused === 'stopped')) {
      await resumeAfterIdle(server, job);
      return;
    }

    await applyAutoPause(server, (await getMapSettings(server.id)).job!);
  } catch (err) {
    console.warn(`[pregen] ${server.name}: ${err instanceof Error ? err.message : err}`);
  } finally {
    busy.delete(server.id);
  }
}

async function finish(server: Server, job: PregenJob, update: ChunkyUpdate | null): Promise<void> {
  await updateJob(server.id, (j) => {
    j.status = 'done';
    j.percent = 100;
    if (update) { j.processed = update.processed; j.total = update.processed; }
    j.rate = null; j.etaSeconds = null; j.autoPaused = null;
    j.finishedAt = new Date().toISOString();
  });
  if (job.pauseRender && await installedAddon(server, 'bluemap')) await command(server, 'bluemap start').catch(() => '');
}

/** Chunky meldet nichts – neu gestartet (fortsetzen) oder fertig geworden (abschließen)? */
async function resumeAfterIdle(server: Server, job: PregenJob): Promise<void> {
  const logs = await dockerSvc.tailLogs(server, 400).catch(() => '');
  const done = latestFor(job.world, parseChunky(logs));
  if (done?.finished || job.percent >= 99.9) {
    await finish(server, job, done ?? null);
    return;
  }
  // Höchstens alle 30 s versuchen – der Server braucht nach dem Start etwas.
  if (Date.now() - (lastResume.get(server.id) ?? 0) < 30_000) return;
  lastResume.set(server.id, Date.now());
  const response = await command(server, `chunky continue ${job.world}`);
  if (/No tasks to continue/i.test(response)) {
    await updateJob(server.id, (j) => {
      j.status = 'failed';
      j.message = 'Chunky hat keinen gespeicherten Auftrag mehr. Bitte neu starten.';
      j.autoPaused = null;
    });
    return;
  }
  if (job.pauseRender && await installedAddon(server, 'bluemap')) await command(server, 'bluemap stop').catch(() => '');
  await updateJob(server.id, (j) => { j.autoPaused = null; });
}

async function applyAutoPause(server: Server, job: PregenJob): Promise<void> {
  if (job.onlyWhenEmpty) {
    const online = (await listPlayers(server).catch(() => null))?.online ?? null;
    if (online !== null && online > 0 && !job.autoPaused) {
      await command(server, `chunky pause ${job.world}`);
      await updateJob(server.id, (j) => { j.autoPaused = 'players'; j.rate = null; j.etaSeconds = null; });
      return;
    }
    if (online === 0 && job.autoPaused === 'players') {
      await command(server, `chunky continue ${job.world}`);
      await updateJob(server.id, (j) => { j.autoPaused = null; });
      return;
    }
  }
  if (job.tpsGuard) {
    const { tps } = await getTickMetrics(server).catch(() => ({ tps: null }));
    if (tps === null) return;
    if (tps < TPS_PAUSE && !job.autoPaused) {
      await command(server, `chunky pause ${job.world}`);
      await updateJob(server.id, (j) => { j.autoPaused = 'tps'; j.rate = null; j.etaSeconds = null; });
    } else if (tps >= TPS_RESUME && job.autoPaused === 'tps') {
      await command(server, `chunky continue ${job.world}`);
      await updateJob(server.id, (j) => { j.autoPaused = null; });
    }
  }
}

// Überwachung und Bedienung desselben Servers laufen nacheinander. Sonst
// überschriebe ein gerade laufender Prüfdurchlauf ein „Pausieren“ mit seinem
// veralteten Stand und schickte Chunky wieder los.
const queued = <T>(serverId: string, fn: () => Promise<T>) => withQueuedOperation(`pregen:${serverId}`, 'Die Vorgenerierung', fn);

export const startPregen = (server: Server, input: PregenInput, userId: string) => queued(server.id, () => startPregenUnlocked(server, input, userId));
export const pausePregen = (server: Server) => queued(server.id, () => pausePregenUnlocked(server));
export const resumePregen = (server: Server) => queued(server.id, () => resumePregenUnlocked(server));
export const cancelPregen = (server: Server) => queued(server.id, () => cancelPregenUnlocked(server));
export const monitorServer = (server: Server) => queued(server.id, () => monitorServerUnlocked(server));

let timer: NodeJS.Timeout | null = null;

/** Alle 5 s die Server mit Auftrag bzw. offener BlueMap-Zustimmung durchgehen. */
export function startPregenMonitor(log: (msg: string) => void): void {
  if (timer) return;
  // Ein Durchlauf nach dem anderen: antwortet ein Server nicht, dauert einer
  // länger als das Intervall. Ohne diese Bremse stauten sich die Durchläufe in
  // der Warteschlange, und „Pausieren“ käme erst nach allen an die Reihe.
  let sweeping = false;
  timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void (async () => {
      const rows = await prisma.setting.findMany({ where: { key: { startsWith: 'pregen.' } } });
      for (const row of rows) {
        const serverId = row.key.slice('pregen.'.length);
        const server = await prisma.server.findUnique({ where: { id: serverId } });
        if (!server) {
          await deleteSetting(row.key).catch(() => {});
          continue;
        }
        await monitorServer(server);
      }
    })().catch((err) => log(`Vorgenerierung: ${err instanceof Error ? err.message : err}`))
      .finally(() => { sweeping = false; });
  }, 5000);
  timer.unref();
}
