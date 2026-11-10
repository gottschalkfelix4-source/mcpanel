/**
 * Umzug eines Servers auf eine andere Node (oder zurück auf den Hauptserver).
 *
 * Läuft unter der Serversperre (über `runTask`) – Backups, Dateiänderungen und
 * Neustarts warten so lange; Spieler und Konsole nicht. Ablauf als Live-Umzug,
 * damit die Auszeit nicht an der Weltgröße hängt:
 *
 *   1. Vorkopie im laufenden Betrieb in einen Zwischenordner auf dem Ziel,
 *      Abbild auf dem Ziel laden
 *   2. `save-all`, dann zweiter Abgleich – noch online, nur Geändertes
 *   3. Ankündigung, Server stoppen, letzter Abgleich (geänderte und gelöschte
 *      Dateien), Vollständigkeit prüfen
 *   4. Zwischenordner an seinen Platz, alten Container entfernen, Standort
 *      umschalten, neuen Container anlegen und starten
 *   5. alte Dateien entfernen
 *
 * Offline ist der Server nur in Schritt 3 und 4. Bis einschließlich Schritt 3
 * bleibt die Quelle unangetastet – scheitert etwas, läuft der Server dort
 * weiter. Die alten Dateien verschwinden erst, wenn das Ziel übernommen hat.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Server } from '@prisma/client';
import type Docker from 'dockerode';
import { nodeMountDir, serverDir, serversDir } from '../config.js';
import { prisma } from '../db.js';
import { badRequest, conflict } from '../lib/errors.js';
import { nodeIdOf, nodeLocation, setServerNode } from '../lib/serverLocation.js';
import * as dockerSvc from './docker.js';
import { invalidateDiskUsage } from './diskUsage.js';
import { isUploadTemp } from './files.js';
import { assertNodeReady, nodeDocker } from './nodeClients.js';
import { syncProxyRoutes } from './proxy.js';
import { closeRconConnection, rconCommand, SAVE_FLUSH_TIMEOUT_MS } from './rcon.js';
import type { TaskHandle } from './tasks.js';

interface Inventory { files: number; bytes: number; skipped: string[] }

async function inventory(root: string): Promise<Inventory> {
  const result: Inventory = { files: 0, bytes: 0, skipped: [] };
  const walk = async (dir: string, relative: string) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (isUploadTemp(rel)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs, rel);
      else if (entry.isFile()) {
        result.files++;
        result.bytes += (await fsp.stat(abs)).size;
      } else {
        // Verknüpfungen und Sonderdateien wandern nicht mit – die Pfadprüfung
        // des Panels lässt Symlinks ohnehin nicht zu.
        result.skipped.push(rel);
      }
    }
  };
  await walk(root, '');
  return result;
}

export interface SyncResult {
  /** Kopierte Dateien und Bytes in diesem Durchgang */
  files: number;
  bytes: number;
  /** Am Ziel entfernte Dateien/Ordner, die es an der Quelle nicht mehr gibt */
  removed: number;
  /** Unverändert gebliebene Dateien */
  unchanged: number;
}

/**
 * Bringt `target` auf den Stand von `source`, wie `rsync -a --delete`:
 * kopiert nur, was neu ist oder sich in Größe oder Änderungszeit
 * unterscheidet, und entfernt am Ziel, was an der Quelle fehlt.
 *
 * Die Änderungszeit wird *vor* dem Lesen festgehalten und am Ziel gesetzt.
 * Schreibt der laufende Server während des Kopierens in die Datei, ist ihre
 * Zeit an der Quelle danach neuer – der nächste Durchgang holt sie erneut.
 */
export async function syncTree(
  source: string,
  target: string,
  onProgress?: (bytes: number, file: string) => void,
): Promise<SyncResult> {
  const result: SyncResult = { files: 0, bytes: 0, removed: 0, unchanged: 0 };
  const walk = async (from: string, to: string, relative: string) => {
    await fsp.mkdir(to, { recursive: true });
    const wanted = new Set<string>();
    for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (isUploadTemp(rel)) continue;
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        wanted.add(entry.name);
        const existing = await fsp.lstat(dst).catch(() => null);
        if (existing && !existing.isDirectory()) await fsp.rm(dst, { recursive: true, force: true });
        await walk(src, dst, rel);
      } else if (entry.isFile()) {
        wanted.add(entry.name);
        // Eine Datei kann zwischen Auflisten und Lesen verschwinden (Logrotation).
        const stat = await fsp.stat(src).catch(() => null);
        if (!stat) continue;
        const existing = await fsp.lstat(dst).catch(() => null);
        if (existing?.isFile() && existing.size === stat.size && Math.abs(existing.mtimeMs - stat.mtimeMs) < 1) {
          result.unchanged++;
          continue;
        }
        if (existing && !existing.isFile()) await fsp.rm(dst, { recursive: true, force: true });
        const reader = fs.createReadStream(src, { highWaterMark: 1024 * 1024 });
        reader.on('data', (chunk) => {
          result.bytes += chunk.length;
          onProgress?.(result.bytes, rel);
        });
        try {
          await pipeline(reader, fs.createWriteStream(dst, { highWaterMark: 1024 * 1024 }));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(src)) continue;
          throw err;
        }
        // Als Zahl in Sekunden, damit Bruchteile von Millisekunden erhalten bleiben.
        await fsp.utimes(dst, stat.atimeMs / 1000, stat.mtimeMs / 1000);
        result.files++;
      }
    }
    for (const entry of await fsp.readdir(to)) {
      if (wanted.has(entry)) continue;
      await fsp.rm(path.join(to, entry), { recursive: true, force: true });
      result.removed++;
    }
  };
  await walk(source, target, '');
  return result;
}

const formatGb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
const formatMb = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
const locationName = (nodeId: string | null) => (nodeId ? nodeLocation(nodeId)?.name ?? nodeId : 'Hauptserver');

/** Docker des Ziels – um das Abbild schon vor dem Stopp dort zu haben. */
const targetDocker = (nodeId: string | null): Docker => (nodeId ? nodeDocker(nodeId) : dockerSvc.docker);

async function say(server: Server, text: string): Promise<void> {
  await rconCommand(server, `say ${text}`).catch(() => {});
}

export async function migrateServer(server: Server, targetNodeId: string | null, task: TaskHandle, userId?: string): Promise<void> {
  const sourceNodeId = nodeIdOf(server.id);
  if (sourceNodeId === targetNodeId) throw badRequest('Der Server liegt bereits dort.');
  if (targetNodeId) assertNodeReady(targetNodeId);
  const sourceName = locationName(sourceNodeId);
  const targetName = locationName(targetNodeId);

  const sourceDir = serverDir(server.id);
  const targetRoot = targetNodeId ? path.join(nodeMountDir(targetNodeId), 'servers') : serversDir();
  const targetDir = path.join(targetRoot, server.id);
  const tempDir = path.join(targetRoot, `.migrate-${server.id}`);
  await task.log(`Umzug von „${sourceName}“ nach „${targetName}“`);

  // --- Vorbereitung -------------------------------------------------------
  await task.update(1, 'Größe wird ermittelt …');
  await fsp.mkdir(sourceDir, { recursive: true });
  const before = await inventory(sourceDir);
  await task.log(`${before.files} Dateien, ${formatGb(before.bytes)}`);
  for (const skipped of before.skipped.slice(0, 20)) await task.log(`Übersprungen (keine normale Datei): ${skipped}`);

  await fsp.mkdir(targetRoot, { recursive: true });
  const disk = await fsp.statfs(targetRoot).catch(() => null);
  if (disk) {
    const free = disk.bavail * disk.bsize;
    // Etwas Luft lassen: der Server soll auf dem Ziel auch noch schreiben können.
    if (free < before.bytes * 1.1 + 512 * 1024 ** 2) {
      throw conflict(`Auf „${targetName}“ ist zu wenig Platz frei (${formatGb(free)} frei, ${formatGb(before.bytes)} nötig).`);
    }
  }

  const { state } = await dockerSvc.getState(server);
  const wasRunning = state === 'running' || state === 'starting';
  let stopped = false;
  let downSince = 0;

  try {
    // --- 1. Vorkopie, Server läuft weiter ----------------------------------
    // Ein Zwischenordner aus einem abgebrochenen Versuch wird nicht verworfen,
    // sondern abgeglichen – ein zweiter Anlauf geht dann deutlich schneller.
    let lastReport = 0;
    await task.update(2, wasRunning ? 'Vorkopie im laufenden Betrieb …' : 'Dateien werden kopiert …');
    const first = await syncTree(sourceDir, tempDir, (bytes, file) => {
      const now = Date.now();
      if (now - lastReport < 1500) return;
      lastReport = now;
      const share = before.bytes > 0 ? Math.min(1, bytes / before.bytes) : 1;
      void task.update(2 + share * 58, `${wasRunning ? 'Vorkopie (Server online)' : 'Kopie'}: ${formatGb(bytes)} von ${formatGb(before.bytes)} – ${file}`);
    });
    await task.log(`Vorkopie: ${first.files} Dateien (${formatGb(first.bytes)}) übertragen, ${first.unchanged} schon aktuell`);

    // Das Abbild jetzt laden, nicht erst während der Auszeit.
    await task.update(61, 'Abbild wird auf dem Ziel geladen …');
    await dockerSvc.ensureImage(dockerSvc.imageForServer(server), (line) => void task.log(line), targetDocker(targetNodeId));

    // --- 2. zweiter Abgleich, noch online -----------------------------------
    if (wasRunning) {
      await task.update(65, 'Welt wird gespeichert und abgeglichen (Server online) …');
      await rconCommand(server, 'save-all flush', { timeoutMs: SAVE_FLUSH_TIMEOUT_MS }).catch(() => {});
      const second = await syncTree(sourceDir, tempDir);
      await task.log(`Zweiter Abgleich: ${second.files} geänderte Dateien (${formatMb(second.bytes)}), ${second.removed} entfernt`);

      // --- 3. kurze Auszeit -------------------------------------------------
      await say(server, `Der Server zieht auf „${targetName}“ um und ist gleich wieder da.`);
      await task.update(72, 'Server wird gestoppt – ab hier offline …');
      downSince = Date.now();
      await dockerSvc.stop(server);
      stopped = true;
    }

    await task.update(76, 'Letzter Abgleich …');
    const last = await syncTree(sourceDir, tempDir);
    if (wasRunning) await task.log(`Letzter Abgleich: ${last.files} geänderte Dateien (${formatMb(last.bytes)}), ${last.removed} entfernt`);

    await task.update(82, 'Kopie wird geprüft …');
    const [source, copy] = await Promise.all([inventory(sourceDir), inventory(tempDir)]);
    if (copy.files !== source.files || copy.bytes !== source.bytes) {
      throw new Error(`Kopie unvollständig: ${copy.files}/${source.files} Dateien, ${copy.bytes}/${source.bytes} Bytes.`);
    }

    if (fs.existsSync(targetDir)) {
      // Reste eines früheren Aufenthalts nicht löschen, nur beiseitelegen.
      const aside = path.join(targetRoot, `.migrate-alt-${server.id}-${Date.now()}`);
      await fsp.rename(targetDir, aside);
      await task.log(`Vorhandener Ordner auf dem Ziel beiseitegelegt: ${path.basename(aside)}`);
    }
    await fsp.rename(tempDir, targetDir);

    // --- 4. Umschalten -------------------------------------------------------
    await task.update(86, 'Alter Container wird entfernt …');
    await dockerSvc.removeContainer(server);
    await prisma.server.update({ where: { id: server.id }, data: { nodeId: targetNodeId } });
    setServerNode(server.id, targetNodeId);
  } catch (err) {
    // Der Zwischenordner bleibt für einen zweiten Anlauf liegen; der Server
    // läuft an der alten Stelle weiter.
    if (stopped) {
      await task.log('Server wird auf der Quelle wieder gestartet');
      await dockerSvc.start(server).catch(() => {});
    }
    await task.log(`Abgebrochen. Ein erneuter Umzug setzt auf dem bisherigen Zwischenstand auf.`);
    throw err;
  } finally {
    closeRconConnection(server);
    invalidateDiskUsage(server.id);
  }

  // --- Ziel in Betrieb nehmen --------------------------------------------
  const moved = await prisma.server.findUniqueOrThrow({ where: { id: server.id } });
  try {
    await task.update(90, 'Container wird angelegt …');
    await dockerSvc.recreateContainer(moved);
    if (wasRunning) {
      await task.update(94, 'Server wird gestartet …');
      await dockerSvc.start(moved);
    }
  } catch (err) {
    // Die Daten sind schon am Ziel; die Quelle bleibt als Rückfallebene liegen.
    await task.log(`Alte Dateien bleiben auf „${sourceName}“ erhalten, bis der Server am Ziel läuft.`);
    throw new Error(`Daten sind umgezogen, aber der Container auf „${targetName}“ ließ sich nicht einrichten: ${err instanceof Error ? err.message : err}. Ein Start legt ihn erneut an.`);
  }
  if (downSince) {
    await task.log(`Auszeit bis zum Start am Ziel: ${Math.round((Date.now() - downSince) / 1000)} s (dazu kommt der Minecraft-Start)`);
  }

  await task.update(97, 'Alte Dateien werden entfernt …');
  await fsp.rm(sourceDir, { recursive: true, force: true }).catch((err) =>
    task.log(`Alte Dateien konnten nicht entfernt werden: ${err instanceof Error ? err.message : err}`));
  await syncProxyRoutes().catch(() => {});
  await prisma.auditLog.create({
    data: { userId, serverId: server.id, action: 'server.migrate', detail: `${sourceName} → ${targetName}` },
  }).catch(() => {});
  await task.update(100, `Server läuft jetzt auf „${targetName}“`);
}
