import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import type { Server } from '@prisma/client';
import { serverBackupDir, serverDir } from '../config.js';
import { safePath } from '../lib/safePath.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { prisma } from '../db.js';
import * as dockerSvc from './docker.js';
import { rconCommand } from './rcon.js';
import { dirSize } from './files.js';
import { readProperties, saveProperties } from './properties.js';
import { withServerOperation } from './operations.js';
import { createBackup } from './backups.js';
import { invalidateDiskUsage } from './diskUsage.js';
import { assertDiskAvailable } from './quota.js';
import { extractServerZip, inspectServerZip, type ImportPlan } from './serverImport.js';
import type { TaskHandle } from './tasks.js';

/**
 * Weltverwaltung. Eine „Welt“ ist ein Ordner mit level.dat im Serververzeichnis.
 * Bukkit-Server (Paper, Spigot, Purpur) legen Nether und Ende als eigene
 * Ordner `<name>_nether` und `<name>_the_end` daneben – die gehören zur Welt
 * und werden mit ihr verschoben, gepackt und gelöscht.
 */
const DIMENSION_SUFFIXES = ['_nether', '_the_end'];
const OPERATION = 'Die Weltverwaltung';

export const worldNameSchemaRegex = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

export function assertWorldName(name: string): string {
  const clean = name.trim();
  if (!worldNameSchemaRegex.test(clean) || clean.includes('..')) {
    throw badRequest('Ungültiger Weltname – erlaubt sind Buchstaben, Ziffern, Leerzeichen, Punkt, Binde- und Unterstrich (höchstens 64 Zeichen).');
  }
  return clean;
}

export interface WorldInfo {
  name: string;
  /** Zugehörige Dimensionsordner (Bukkit), z. B. world_nether */
  dimensions: string[];
  sizeBytes: number;
  modifiedAt: string | null;
  active: boolean;
  /** false: als aktive Welt eingetragen, aber noch nicht erzeugt */
  exists: boolean;
}

async function hasLevelDat(dir: string): Promise<boolean> {
  const stat = await fs.lstat(path.join(dir, 'level.dat')).catch(() => null);
  return !!stat?.isFile();
}

async function activeWorld(serverId: string): Promise<{ name: string; seed: string }> {
  const { values } = await readProperties(serverId);
  return { name: values['level-name'] || 'world', seed: values['level-seed'] ?? '' };
}

/** Ordner der Welt samt Dimensionsordnern, soweit vorhanden. */
async function worldParts(serverId: string, name: string): Promise<string[]> {
  const parts: string[] = [];
  for (const candidate of [name, ...DIMENSION_SUFFIXES.map((suffix) => name + suffix)]) {
    const stat = await fs.lstat(safePath(serverDir(serverId), candidate)).catch(() => null);
    if (stat?.isDirectory()) parts.push(candidate);
  }
  return parts;
}

export async function listWorlds(server: Server) {
  const dir = serverDir(server.id);
  const active = await activeWorld(server.id);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const levels = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (await hasLevelDat(path.join(dir, entry.name))) levels.add(entry.name);
  }
  const worlds: WorldInfo[] = [];
  for (const name of [...levels].sort((a, b) => a.localeCompare(b))) {
    // Dimensionsordner nur einrechnen, wenn die Hauptwelt daneben liegt.
    const base = DIMENSION_SUFFIXES.map((s) => (name.endsWith(s) ? name.slice(0, -s.length) : null)).find((b) => b && levels.has(b));
    if (base) continue;
    const parts = await worldParts(server.id, name);
    let sizeBytes = 0;
    for (const part of parts) sizeBytes += await dirSize(path.join(dir, part));
    const stat = await fs.stat(path.join(dir, name, 'level.dat')).catch(() => null);
    worlds.push({
      name,
      dimensions: parts.filter((p) => p !== name),
      sizeBytes,
      modifiedAt: stat ? stat.mtime.toISOString() : null,
      active: name === active.name,
      exists: true,
    });
  }
  if (!worlds.some((w) => w.active)) {
    worlds.unshift({ name: active.name, dimensions: [], sizeBytes: 0, modifiedAt: null, active: true, exists: false });
  }
  const { state } = await dockerSvc.getState(server);
  return { active: active.name, seed: active.seed, running: state === 'running' || state === 'starting', worlds };
}

async function assertStopped(server: Server, what: string) {
  const { state } = await dockerSvc.getState(server);
  if (state === 'running' || state === 'starting') {
    throw conflict(`Bitte den Server zuerst stoppen – ${what} geht nur bei gestopptem Server, sonst überschreibt er die Welt beim Beenden.`);
  }
}

async function assertExists(server: Server, name: string) {
  if (!(await hasLevelDat(safePath(serverDir(server.id), name)))) throw notFound(`Welt „${name}“ nicht gefunden`);
}

async function assertFree(server: Server, name: string) {
  for (const candidate of [name, ...DIMENSION_SUFFIXES.map((s) => name + s)]) {
    if (await fs.lstat(safePath(serverDir(server.id), candidate)).catch(() => null)) {
      throw conflict(`Im Serverordner gibt es bereits „${candidate}“ – bitte einen anderen Namen wählen.`);
    }
  }
}

/** Nur bei einer Änderung schreiben; LEVEL in extraEnv mitziehen, falls gesetzt. */
async function setLevel(server: Server, changes: { name?: string; seed?: string }) {
  const props: Record<string, string> = {};
  if (changes.name !== undefined) props['level-name'] = changes.name;
  if (changes.seed !== undefined) props['level-seed'] = changes.seed;
  await saveProperties(server.id, props);
  const extra = { ...((server.extraEnv ?? {}) as Record<string, string>) };
  let changed = false;
  if (changes.name !== undefined && extra.LEVEL && extra.LEVEL !== changes.name) { extra.LEVEL = changes.name; changed = true; }
  if (changes.seed !== undefined && extra.SEED !== undefined && extra.SEED !== changes.seed) { extra.SEED = changes.seed; changed = true; }
  // Der Container wird beim nächsten Start ohnehin mit den neuen Werten neu aufgesetzt.
  if (changed) await prisma.server.update({ where: { id: server.id }, data: { extraEnv: extra } });
}

/** Andere vorhandene Welt beim nächsten Start laden. */
export function activateWorld(server: Server, rawName: string) {
  return withServerOperation(server.id, OPERATION, async () => {
    const name = assertWorldName(rawName);
    await assertExists(server, name);
    await setLevel(server, { name });
    const { state } = await dockerSvc.getState(server);
    return { active: name, restartRequired: state === 'running' || state === 'starting' };
  });
}

/** Neue Welt anlegen: der Server erzeugt sie beim nächsten Start, die alte bleibt liegen. */
export function createWorld(server: Server, rawName: string, seed: string) {
  return withServerOperation(server.id, OPERATION, async () => {
    const name = assertWorldName(rawName);
    assertSeed(seed);
    await assertFree(server, name);
    await setLevel(server, { name, seed });
    const { state } = await dockerSvc.getState(server);
    return { active: name, restartRequired: state === 'running' || state === 'starting' };
  });
}

function assertSeed(seed: string) {
  if (seed.length > 64 || /[\r\n\0\\]/.test(seed)) throw badRequest('Ungültiger Seed (höchstens 64 Zeichen, keine Zeilenumbrüche).');
}

/**
 * Aktive Welt verwerfen und mit (neuem) Seed neu erzeugen lassen. Vorher wird
 * immer ein Sicherheits-Backup angelegt – das ist der einzige Rückweg.
 */
export function resetWorld(server: Server, seed: string, task: TaskHandle, createdById: string | null) {
  return withServerOperation(server.id, OPERATION, async () => {
    assertSeed(seed);
    await assertStopped(server, 'das Zurücksetzen der Welt');
    const { name } = await activeWorld(server.id);
    await task.update(10, 'Sicherheits-Backup wird erstellt …');
    await createBackup(server, {
      name: `Vor Weltreset ${new Date().toISOString().slice(0, 16)}`,
      note: `Automatisch vor dem Zurücksetzen der Welt „${name}“`,
      createdById,
      origin: 'SAFETY',
    });
    await assertStopped(server, 'das Zurücksetzen der Welt');
    await task.update(70, 'Alte Welt wird entfernt …');
    for (const part of await worldParts(server.id, name)) {
      await fs.rm(safePath(serverDir(server.id), part), { recursive: true, force: true });
    }
    await setLevel(server, { seed });
    invalidateDiskUsage(server.id);
    await task.update(100, seed ? `Welt zurückgesetzt – neuer Seed ${seed}` : 'Welt zurückgesetzt – zufälliger Seed beim nächsten Start');
  });
}

/** Nicht aktive Welt endgültig löschen. */
export function deleteWorld(server: Server, rawName: string) {
  return withServerOperation(server.id, OPERATION, async () => {
    const name = assertWorldName(rawName);
    await assertExists(server, name);
    if ((await activeWorld(server.id)).name === name) throw badRequest('Die aktive Welt kann nicht gelöscht werden – zuerst eine andere aktivieren oder die Welt zurücksetzen.');
    // Plugins wie Multiverse halten auch weitere Welten geladen.
    await assertStopped(server, 'das Löschen einer Welt');
    for (const part of await worldParts(server.id, name)) {
      await fs.rm(safePath(serverDir(server.id), part), { recursive: true, force: true });
    }
    invalidateDiskUsage(server.id);
  });
}

/**
 * Packt die Welt in eine temporäre Datei. Läuft der Server und ist es die
 * aktive Welt, wird wie beim Backup vorher gespeichert und das Speichern
 * währenddessen pausiert – sonst landen halb geschriebene Regionen im Archiv.
 */
export function exportWorld(server: Server, rawName: string): Promise<{ file: string; filename: string; cleanup: () => Promise<void> }> {
  return withServerOperation(server.id, OPERATION, async () => {
    const name = assertWorldName(rawName);
    await assertExists(server, name);
    const parts = await worldParts(server.id, name);
    const { state } = await dockerSvc.getState(server);
    const running = state === 'running';
    const paused = running && (await activeWorld(server.id)).name === name;
    const dir = serverBackupDir(server.id);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `.world-export-${crypto.randomBytes(6).toString('hex')}.tar.gz`);
    if (paused) {
      try {
        await rconCommand(server, 'save-off');
        await rconCommand(server, 'save-all flush');
      } catch {
        await rconCommand(server, 'save-on').catch(() => {});
        throw badRequest('Die Welt konnte nicht konsistent gespeichert werden – bitte erneut versuchen oder den Server stoppen.');
      }
    }
    try {
      await pipeline(
        tar.create({ gzip: true, cwd: serverDir(server.id), portable: true, filter: (entry) => !/(^|\/)session\.lock$/.test(entry) }, parts),
        fsSync.createWriteStream(file, { flags: 'wx', mode: 0o600 }),
      );
    } catch (err) {
      await fs.rm(file, { force: true });
      throw err;
    } finally {
      if (paused) await rconCommand(server, 'save-on').catch(() => {});
    }
    return {
      file,
      filename: `${name.replace(/[^A-Za-z0-9._-]+/g, '-')}.tar.gz`,
      cleanup: () => fs.rm(file, { force: true }),
    };
  });
}

export const WORLD_ZIP_MARKER = {
  file: 'level.dat',
  missing: 'Das ZIP muss genau eine Welt enthalten – einen Ordner mit level.dat (oder level.dat direkt im ZIP).',
};

export function inspectWorldZip(file: string, maxBytes: number): Promise<ImportPlan> {
  return inspectServerZip(file, maxBytes, WORLD_ZIP_MARKER);
}

/** Hochgeladene Welt unter neuem Namen ablegen, optional gleich aktivieren. */
export function importWorld(server: Server, file: string, plan: ImportPlan, rawName: string, activate: boolean, task: TaskHandle) {
  return withServerOperation(server.id, OPERATION, async () => {
    const name = assertWorldName(rawName);
    await assertFree(server, name);
    await assertDiskAvailable(server, plan.bytes);
    const free = await fs.statfs(serverDir(server.id));
    if (plan.bytes > free.bavail * free.bsize - 64 * 1024 ** 2) throw badRequest('Nicht genügend freier Speicher für diese Welt.');
    const stage = safePath(serverDir(server.id), `.world-import-${crypto.randomBytes(6).toString('hex')}`);
    await fs.mkdir(stage);
    try {
      await extractServerZip(file, plan, stage, (percent) => task.update(5 + percent * 0.85, 'Welt wird geprüft und entpackt …'));
      if (!(await hasLevelDat(stage))) throw badRequest('Nach dem Entpacken fehlt level.dat – die Welt wurde verworfen.');
      // Nach dem Entpacken erneut prüfen: in der Zwischenzeit könnte der Name belegt worden sein.
      await assertFree(server, name);
      await fs.rename(stage, safePath(serverDir(server.id), name));
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
    invalidateDiskUsage(server.id);
    if (activate) await setLevel(server, { name });
    await task.update(100, activate ? `Welt „${name}“ übernommen und aktiviert` : `Welt „${name}“ übernommen`);
  });
}
