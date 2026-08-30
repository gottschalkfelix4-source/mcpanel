import fs from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import type { Server } from '@prisma/client';
import { serverBackupDir, serverDir } from '../config.js';
import { prisma } from '../db.js';
import { badRequest, notFound } from '../lib/errors.js';
import * as dockerSvc from './docker.js';
import { rconCommand } from './rcon.js';
import { invalidateDiskUsage } from './diskUsage.js';
import { notify } from './notify.js';
import { fetchBackup, getTarget, isEnabled, putBackup, removeBackup } from './backupTarget.js';
import { assertDiskAvailable, pruneToBackupLimit } from './quota.js';
import type { TaskHandle } from './tasks.js';

export interface CreateBackupOptions {
  name?: string;
  note?: string;
  createdById?: string | null;
  task?: TaskHandle;
}

/**
 * Liefert die Archivdatei – bevorzugt aus der Hauptablage, sonst aus der
 * Zweitablage. Genau dafuer ist sie da: die Hauptdatei kann fehlen.
 * `cleanup` raeumt eine temporaere Kopie weg (bei S3 wird heruntergeladen).
 */
/** Pfad der Sicherung in der Hauptablage. */
const primaryPath = (serverId: string, filename: string) =>
  path.join(serverBackupDir(serverId), filename);

async function resolveArchive(
  serverId: string,
  filename: string,
): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
  const primary = primaryPath(serverId, filename);
  if (await fs.stat(primary).catch(() => null)) {
    return { path: primary, cleanup: async () => {} };
  }
  return fetchBackup(serverId, filename);
}

/** Ordner, die nie in ein Backup wandern. */
const EXCLUDE = new Set(['cache', 'logs', 'crash-reports', '.cache', 'libraries']);

export async function createBackup(server: Server, options: CreateBackupOptions = {}) {
  const { task } = options;
  const dir = serverDir(server.id);
  await fs.mkdir(dir, { recursive: true });

  const backupDir = serverBackupDir(server.id);
  await fs.mkdir(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backup-${stamp}.tar.gz`;
  const target = path.join(backupDir, filename);

  // Kontingent vor dem Packen pruefen - danach laege das Archiv schon da.
  await task?.update(5, 'Speicherplatz wird geprüft …');
  await assertDiskAvailable(server);

  const { state } = await dockerSvc.getState(server);
  const running = state === 'running';

  if (running) {
    await task?.update(10, 'Welt wird gespeichert …');
    try {
      await rconCommand(server, 'save-off');
      await rconCommand(server, 'save-all flush');
    } catch {
      /* RCON evtl. noch nicht bereit – Backup trotzdem versuchen */
    }
  }

  try {
    await task?.update(25, 'Archiv wird erstellt …');
    const entries = (await fs.readdir(dir)).filter((e) => !EXCLUDE.has(e));
    await tar.create({ gzip: true, file: target, cwd: dir, portable: true }, entries);
  } finally {
    if (running) {
      await rconCommand(server, 'save-on').catch(() => {});
    }
  }

  const stat = await fs.stat(target);
  await task?.update(90, 'Backup wird registriert …');

  const backup = await prisma.backup.create({
    data: {
      serverId: server.id,
      name: options.name || `Backup ${new Date().toLocaleString('de-DE')}`,
      note: options.note ?? '',
      filename,
      sizeBytes: BigInt(stat.size),
      createdById: options.createdById ?? null,
    },
  });

  invalidateDiskUsage(server.id);
  const pruned = await pruneToBackupLimit(server);
  const size = `${(stat.size / 1024 / 1024).toFixed(1)} MB`;

  // Zweitablage: fehlschlagen darf das, ohne die Sicherung zu entwerten –
  // die Hauptkopie liegt bereits vollstaendig auf der Platte.
  const store = await getTarget();
  const targetActive = isEnabled(store);
  let mirrored = false;
  let mirrorError: string | null = null;
  if (targetActive) {
    await task?.update(95, 'Zweitkopie wird geschrieben …');
    try {
      await putBackup(server.id, filename, primaryPath(server.id, filename), (percent) => {
        void task?.update(95 + Math.round(percent * 0.04), `Zweitkopie … ${percent} %`);
      });
      mirrored = true;
      await prisma.backup.update({ where: { id: backup.id }, data: { mirrored: true } });
    } catch (err) {
      mirrorError = err instanceof Error ? err.message : String(err);
    }
  }

  await task?.update(
    100,
    mirrorError ? `Backup erstellt (${size}) – Zweitkopie fehlgeschlagen` : `Backup erstellt (${size})`,
  );

  void notify('backup.done', {
    serverId: server.id,
    serverName: server.name,
    title: `Backup von ${server.name}`,
    message: mirrorError ? `${backup.name}

Zweitkopie fehlgeschlagen: ${mirrorError}` : backup.name,
    fields: [
      { name: 'Größe', value: size },
      { name: 'Server lief', value: running ? 'ja' : 'nein' },
      ...(pruned > 0 ? [{ name: 'Alte entfernt', value: String(pruned) }] : []),
      ...(targetActive ? [{ name: 'Zweitablage', value: mirrored ? 'ja' : 'fehlgeschlagen' }] : []),
    ],
  });

  return { ...backup, mirrored };
}

export async function restoreBackup(server: Server, backupId: string, task?: TaskHandle) {
  const backup = await prisma.backup.findFirst({ where: { id: backupId, serverId: server.id } });
  if (!backup) throw notFound('Backup nicht gefunden');

  const source = await resolveArchive(server.id, backup.filename);
  if (!source) throw notFound('Backup-Datei fehlt – weder in der Haupt- noch in der Zweitablage');
  const archive = source.path;

  await task?.update(5, 'Server wird gestoppt …');
  await dockerSvc.stop(server);

  const dir = serverDir(server.id);
  await task?.update(25, 'Alte Daten werden entfernt …');
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (EXCLUDE.has(entry)) continue;
    await fs.rm(path.join(dir, entry), { recursive: true, force: true });
  }

  await task?.update(45, 'Backup wird entpackt …');
  await fs.mkdir(dir, { recursive: true });
  await tar.extract({ file: archive, cwd: dir });

  await task?.update(90, 'Container wird neu aufgesetzt …');
  await dockerSvc.recreateContainer(server);
  invalidateDiskUsage(server.id);
  await source.cleanup();
  await task?.update(100, 'Backup wiederhergestellt');
}

export async function deleteBackup(server: Server, backupId: string) {
  const backup = await prisma.backup.findFirst({ where: { id: backupId, serverId: server.id } });
  if (!backup) throw notFound('Backup nicht gefunden');
  await fs.rm(path.join(serverBackupDir(server.id), backup.filename), { force: true });
  await removeBackup(server.id, backup.filename);
  await prisma.backup.delete({ where: { id: backup.id } });
  invalidateDiskUsage(server.id);
}

export async function backupFilePath(
  server: Server,
  backupId: string,
): Promise<{ path: string; filename: string; cleanup: () => Promise<void> }> {
  const backup = await prisma.backup.findFirst({ where: { id: backupId, serverId: server.id } });
  if (!backup) throw notFound('Backup nicht gefunden');
  const source = await resolveArchive(server.id, backup.filename);
  if (!source) throw badRequest('Backup-Datei fehlt');
  return { ...source, filename: `${slug(backup.name)}.tar.gz` };
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'backup';
}
