import fsSync from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { byteLimit } from '../lib/byteLimit.js';
import { dirSize } from './files.js';
import { commitRestore, finishRestore, recoverInterruptedRestore, restorePaths } from './restoreRecovery.js';
import { archivePath } from '../lib/safePath.js';
import { withServerOperation } from './operations.js';
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
import { fetchBackup, getTarget, isEnabled, putBackup, removeBackup, registerTarget } from './backupTarget.js';
import { assertDiskAvailable, pruneToBackupLimit, remainingDiskBytes } from './quota.js';
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
  targetId?: string | null,
): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
  const primary = primaryPath(serverId, filename);
  if (await fs.stat(primary).catch(() => null)) {
    return { path: primary, cleanup: async () => {} };
  }
  return fetchBackup(serverId, filename, targetId);
}

/** Ausweichordner, in den die Wiederherstellung den alten Stand beiseitelegt. */
const RESTORE_OLD = '.restore-old';

/** Ordner, die nie in ein Backup wandern. */
const EXCLUDE = new Set(['cache', 'logs', 'crash-reports', '.cache', 'libraries', RESTORE_OLD]);

async function createBackupUnlocked(server: Server, options: CreateBackupOptions = {}) {
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
    } catch (err) {
      await rconCommand(server, 'save-on').catch(() => {});
      throw badRequest('Welt konnte nicht konsistent gespeichert werden; Backup wurde abgebrochen');
    }
  }

  try {
    await task?.update(25, 'Archiv wird erstellt …');
    const entries = (await fs.readdir(dir)).filter((e) => !EXCLUDE.has(e));
    const budget = await remainingDiskBytes(server);
    try {
      await pipeline(tar.create({ gzip: true, cwd: dir, portable: true }, entries), byteLimit(budget), fsSync.createWriteStream(target));
    } catch (err) {
      await fs.rm(target, { force: true });
      throw err;
    }
  } finally {
    if (running) {
      await rconCommand(server, 'save-on').catch(() => {});
    }
  }

  const stat = await fs.stat(target);
  await task?.update(90, 'Backup wird registriert …');

  const store = await getTarget();
  const targetActive = isEnabled(store);
  const targetId = targetActive ? await registerTarget(store) : null;
  const backup = await prisma.backup.create({
    data: {
      serverId: server.id,
      targetId,
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
  let mirrored = false;
  let mirrorError: string | null = null;
  if (targetActive) {
    await task?.update(95, 'Zweitkopie wird geschrieben …');
    try {
      await putBackup(server.id, filename, primaryPath(server.id, filename), (percent) => {
        void task?.update(95 + Math.round(percent * 0.04), `Zweitkopie … ${percent} %`);
      }, targetId);
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

/**
 * Laeuft das Archiv einmal durch, ohne etwas zu schreiben. `strict` laesst auch
 * Warnungen (abgeschnittenes Archiv) als Fehler durchschlagen.
 */
async function assertArchiveIntact(archive: string) {
  let entries = 0;
  try {
    await tar.list({
      file: archive,
      strict: true,
      onReadEntry: () => {
        entries += 1;
      },
    });
  } catch {
    throw badRequest('Das Backup-Archiv ist beschädigt oder unvollständig – es wurde nichts verändert.');
  }
  if (entries === 0) {
    throw badRequest('Das Backup-Archiv ist leer – es wurde nichts verändert.');
  }
}

/**
 * Holt den beiseitegelegten Stand zurück: alles, was seit dem Beiseitelegen im
 * Serververzeichnis entstanden ist, stammt aus einem halben Entpackvorgang und
 * fliegt raus. Wird sowohl beim Fehlschlag als auch beim Aufräumen eines
 * abgebrochenen früheren Laufs benutzt – nach einem Neustart mitten in der
 * Wiederherstellung ist der Ausweichordner die einzige vollständige Kopie.
 */
async function restoreBackupUnlocked(server: Server, backupId: string, task?: TaskHandle) {
  const backup = await prisma.backup.findFirst({ where: { id: backupId, serverId: server.id } });
  if (!backup) throw notFound('Backup nicht gefunden');

  const source = await resolveArchive(server.id, backup.filename, backup.targetId);
  if (!source) throw notFound('Backup-Datei fehlt – weder in der Haupt- noch in der Zweitablage');
  const archive = source.path;

  try {
    // Vor dem Stoppen pruefen: ein kaputtes Archiv soll den laufenden Server
    // gar nicht erst unterbrechen.
    await task?.update(5, 'Backup-Archiv wird geprüft …');
    await assertArchiveIntact(archive);

    await task?.update(20, 'Server wird gestoppt …');
    await dockerSvc.stop(server);

    await recoverInterruptedRestore(server.id);
    const { dir, old, stage } = restorePaths(server.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(stage);
    try {
      await task?.update(35, 'Backup wird in einen separaten Ordner entpackt …');
      await tar.extract({ file: archive, cwd: stage, strict: true, filter: (name, entry) => {
        archivePath(stage, name);
        if ('type' in entry && ['SymbolicLink', 'Link'].includes(entry.type)) throw badRequest('Links sind in Sicherungen nicht erlaubt');
        return !EXCLUDE.has(name.split('/')[0]);
      } });
      for (const name of EXCLUDE) {
        if (name === RESTORE_OLD) continue;
        const source = path.join(dir, name);
        if (await fs.stat(source).catch(() => null)) await fs.cp(source, path.join(stage, name), { recursive: true });
      }
      if (server.quotaDiskMb > 0 && await dirSize(stage) + await dirSize(serverBackupDir(server.id)) > server.quotaDiskMb * 1024 * 1024) throw badRequest('Wiederherstellung überschreitet das Speicherkontingent');
      await task?.update(80, 'Geprüfter Stand wird übernommen …');
      await commitRestore(server.id);
      await dockerSvc.recreateContainer(server);
      await finishRestore(server.id);
    } catch (err) {
      await recoverInterruptedRestore(server.id);
      throw err;
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
    invalidateDiskUsage(server.id);
    await task?.update(100, 'Backup wiederhergestellt');
  } finally {
    await source.cleanup();
  }
}

async function deleteBackupUnlocked(server: Server, backupId: string) {
  const backup = await prisma.backup.findFirst({ where: { id: backupId, serverId: server.id } });
  if (!backup) throw notFound('Backup nicht gefunden');
  await fs.rm(path.join(serverBackupDir(server.id), backup.filename), { force: true });
  await removeBackup(server.id, backup.filename, backup.targetId);
  await prisma.backup.delete({ where: { id: backup.id } });
  invalidateDiskUsage(server.id);
}

export async function backupFilePath(
  server: Server,
  backupId: string,
): Promise<{ path: string; filename: string; cleanup: () => Promise<void> }> {
  const backup = await prisma.backup.findFirst({ where: { id: backupId, serverId: server.id } });
  if (!backup) throw notFound('Backup nicht gefunden');
  const source = await resolveArchive(server.id, backup.filename, backup.targetId);
  if (!source) throw badRequest('Backup-Datei fehlt');
  return { ...source, filename: `${slug(backup.name)}.tar.gz` };
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'backup';
}

export const createBackup = (...args: Parameters<typeof createBackupUnlocked>) => withServerOperation(args[0].id, "createBackup", () => createBackupUnlocked(...args));

export const restoreBackup = (...args: Parameters<typeof restoreBackupUnlocked>) => withServerOperation(args[0].id, "restoreBackup", () => restoreBackupUnlocked(...args));

export const deleteBackup = (...args: Parameters<typeof deleteBackupUnlocked>) => withServerOperation(args[0].id, "deleteBackup", () => deleteBackupUnlocked(...args));
