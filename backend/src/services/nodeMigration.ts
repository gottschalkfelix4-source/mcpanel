/**
 * Umzug eines Servers auf eine andere Node (oder zurück auf den Hauptserver).
 *
 * Läuft unter der Serversperre (über `runTask`). Ablauf:
 *
 *   1. Server stoppen, falls er läuft
 *   2. Dateien in einen Zwischenordner auf dem Ziel kopieren und prüfen
 *   3. Zwischenordner an seinen endgültigen Platz umbenennen
 *   4. alten Container entfernen, Standort umschalten, neuen Container anlegen
 *   5. wieder starten, alte Dateien entfernen
 *
 * Bis einschließlich Schritt 3 bleibt die Quelle unangetastet – scheitert
 * etwas, läuft der Server dort weiter, als wäre nichts gewesen. Die alten
 * Dateien verschwinden erst, wenn das Ziel vollständig übernommen hat.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Server } from '@prisma/client';
import { nodeMountDir, serverDir, serversDir } from '../config.js';
import { prisma } from '../db.js';
import { badRequest, conflict } from '../lib/errors.js';
import { nodeIdOf, nodeLocation, setServerNode } from '../lib/serverLocation.js';
import * as dockerSvc from './docker.js';
import { invalidateDiskUsage } from './diskUsage.js';
import { isUploadTemp } from './files.js';
import { assertNodeReady } from './nodeClients.js';
import { syncProxyRoutes } from './proxy.js';
import { closeRconConnection } from './rcon.js';
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

async function copyTree(
  source: string,
  target: string,
  onProgress: (bytes: number, file: string) => void,
): Promise<void> {
  let copied = 0;
  const walk = async (from: string, to: string, relative: string) => {
    await fsp.mkdir(to, { recursive: true });
    for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (isUploadTemp(rel)) continue;
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        await walk(src, dst, rel);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(src);
        const reader = fs.createReadStream(src, { highWaterMark: 1024 * 1024 });
        reader.on('data', (chunk) => {
          copied += chunk.length;
          onProgress(copied, rel);
        });
        await pipeline(reader, fs.createWriteStream(dst, { highWaterMark: 1024 * 1024 }));
        await fsp.utimes(dst, stat.atime, stat.mtime).catch(() => {});
      }
    }
  };
  await walk(source, target, '');
}

const formatGb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
const locationName = (nodeId: string | null) => (nodeId ? nodeLocation(nodeId)?.name ?? nodeId : 'Hauptserver');

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
  await task.update(2, 'Größe wird ermittelt …');
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
  if (wasRunning) {
    await task.update(4, 'Server wird gestoppt …');
    await dockerSvc.stop(server);
  }

  // --- Kopieren -----------------------------------------------------------
  try {
    await fsp.rm(tempDir, { recursive: true, force: true });
    let lastReport = 0;
    await task.update(5, 'Dateien werden kopiert …');
    await copyTree(sourceDir, tempDir, (bytes, file) => {
      const now = Date.now();
      if (now - lastReport < 1500) return;
      lastReport = now;
      const share = before.bytes > 0 ? bytes / before.bytes : 1;
      void task.update(5 + share * 80, `Kopiere ${formatGb(bytes)} von ${formatGb(before.bytes)} – ${file}`);
    });

    await task.update(86, 'Kopie wird geprüft …');
    const after = await inventory(tempDir);
    if (after.files !== before.files || after.bytes !== before.bytes) {
      throw new Error(`Kopie unvollständig: ${after.files}/${before.files} Dateien, ${after.bytes}/${before.bytes} Bytes. Läuft noch etwas auf dem Server?`);
    }

    if (fs.existsSync(targetDir)) {
      // Reste eines früheren Aufenthalts nicht löschen, nur beiseitelegen.
      const aside = path.join(targetRoot, `.migrate-alt-${server.id}-${Date.now()}`);
      await fsp.rename(targetDir, aside);
      await task.log(`Vorhandener Ordner auf dem Ziel beiseitegelegt: ${path.basename(aside)}`);
    }
    await fsp.rename(tempDir, targetDir);

    // --- Umschalten -------------------------------------------------------
    await task.update(88, 'Alter Container wird entfernt …');
    await dockerSvc.removeContainer(server);
    await prisma.server.update({ where: { id: server.id }, data: { nodeId: targetNodeId } });
    setServerNode(server.id, targetNodeId);
  } catch (err) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (wasRunning) {
      await task.log('Server wird auf der Quelle wieder gestartet');
      await dockerSvc.start(server).catch(() => {});
    }
    throw err;
  } finally {
    closeRconConnection(server);
    invalidateDiskUsage(server.id);
  }

  // --- Ziel in Betrieb nehmen --------------------------------------------
  const moved = await prisma.server.findUniqueOrThrow({ where: { id: server.id } });
  try {
    await task.update(90, 'Abbild wird auf dem Ziel geladen …');
    await dockerSvc.ensureServerImage(moved, (line) => void task.log(line));
    await task.update(94, 'Container wird angelegt …');
    await dockerSvc.recreateContainer(moved);
    if (wasRunning) {
      await task.update(96, 'Server wird gestartet …');
      await dockerSvc.start(moved);
    }
  } catch (err) {
    // Die Daten sind schon am Ziel; die Quelle bleibt als Rückfallebene liegen.
    await task.log(`Alte Dateien bleiben auf „${sourceName}“ erhalten, bis der Server am Ziel läuft.`);
    throw new Error(`Daten sind umgezogen, aber der Container auf „${targetName}“ ließ sich nicht einrichten: ${err instanceof Error ? err.message : err}. Ein Start legt ihn erneut an.`);
  }

  await task.update(98, 'Alte Dateien werden entfernt …');
  await fsp.rm(sourceDir, { recursive: true, force: true }).catch((err) =>
    task.log(`Alte Dateien konnten nicht entfernt werden: ${err instanceof Error ? err.message : err}`));
  await syncProxyRoutes().catch(() => {});
  await prisma.auditLog.create({
    data: { userId, serverId: server.id, action: 'server.migrate', detail: `${sourceName} → ${targetName}` },
  }).catch(() => {});
  await task.update(100, `Server läuft jetzt auf „${targetName}“`);
}
