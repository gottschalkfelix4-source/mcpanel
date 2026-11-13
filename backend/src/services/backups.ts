import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import { openPromise } from 'yauzl';
import { collectSources, writeZip, writeZipStream } from '../lib/zipWriter.js';
import { dirSize, isUploadTemp } from './files.js';
import { extractServerZip, readZipEntries } from './serverImport.js';
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
import { restoreAutosave } from './autosave.js';
import { rconCommand, SAVE_FLUSH_TIMEOUT_MS } from './rcon.js';
import { invalidateDiskUsage } from './diskUsage.js';
import { notify } from './notify.js';
import { fetchBackup, getTarget, isEnabled, openBackupSink, putBackup, removeBackup, registerTarget, type BackupSink } from './backupTarget.js';
import { assertDiskAvailable, pruneToBackupLimit, remainingDiskBytes } from './quota.js';
import type { TaskHandle } from './tasks.js';

export interface CreateBackupOptions {
  name?: string;
  note?: string;
  createdById?: string | null;
  task?: TaskHandle;
  /** Herkunft – entscheidet, was die Aufräumregeln löschen dürfen. */
  origin?: BackupOrigin;
  /** Bei Automationen: zu welcher Regel die Sicherung gehört. */
  automationId?: string | null;
  /** Sicherungen, die das Kontingent-Aufräumen dabei nicht löschen darf. */
  protect?: string[];
}

export type BackupOrigin = 'MANUAL' | 'AUTOMATIC' | 'SAFETY';

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

const PARTIAL_SUFFIX = '.part';

/** Halbe Archive eines abgebrochenen Panel-Laufs entfernen. */
export async function cleanupPartialBackups(serverId: string): Promise<number> {
  const dir = serverBackupDir(serverId);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(PARTIAL_SUFFIX)) continue;
    await fs.rm(path.join(dir, name), { force: true });
    removed++;
  }
  return removed;
}

async function createBackupUnlocked(server: Server, options: CreateBackupOptions = {}) {
  const { task } = options;
  const dir = serverDir(server.id);
  await fs.mkdir(dir, { recursive: true });

  const backupDir = serverBackupDir(server.id);
  await fs.mkdir(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backup-${stamp}.zip`;
  const target = path.join(backupDir, filename);

  // Kontingent vor dem Packen pruefen - danach laege das Archiv schon da.
  await task?.update(5, 'Speicherplatz wird geprüft …');
  await assertDiskAvailable(server);

  // Ist ein Speicherziel eingerichtet, entsteht das Archiv direkt dort – ohne
  // lokale Kopie und ohne zweiten Durchgang zum Hochladen. Klappt das nicht
  // (Ziel nicht erreichbar, Server nimmt keinen Upload unbekannter Länge an),
  // wird wie früher lokal gepackt und danach hochgeladen.
  const store = await getTarget();
  const targetActive = isEnabled(store);
  const targetId = targetActive ? await registerTarget(store) : null;
  // (Vor „save-off“ ermittelt: ein Datenbankfehler hier darf den Server nicht
  // ohne automatisches Speichern zurücklassen.)

  const { state } = await dockerSvc.getState(server);
  const running = state === 'running';

  if (running) {
    await task?.update(10, 'Welt wird gespeichert …');
    try {
      await rconCommand(server, 'save-off');
      await rconCommand(server, 'save-all flush', { timeoutMs: SAVE_FLUSH_TIMEOUT_MS });
    } catch (err) {
      await rconCommand(server, 'save-on').catch(() => {});
      throw badRequest('Welt konnte nicht konsistent gespeichert werden; Backup wurde abgebrochen');
    }
  }

  let direct: { size: number; entries: number } | null = null;
  let directError: string | null = null;

  let entries: string[] = [];
  try {
    await task?.update(15, 'Dateien werden gesammelt …');
    entries = (await fs.readdir(dir)).filter((e) => !EXCLUDE.has(e));
    const sources = await collectSources(dir, entries, (relative) => !isUploadTemp(relative));

    if (targetActive && !store.keepLocal) {
      let sink: BackupSink | null = null;
      try {
        sink = await openBackupSink(server.id, filename, targetId);
        const result = await writeZipStream(sink.stream, sources, {
          onProgress: (done, total) => {
            const percent = total > 0 ? Math.round((done / total) * 100) : 100;
            void task?.update(20 + Math.round(percent * 0.7), `Archiv wird direkt ins Speicherziel geschrieben … ${percent} %`);
          },
        });
        await task?.update(92, 'Speicherziel schließt die Datei ab …');
        await sink.finish();
        if (result.entries === 0 && entries.length > 0) throw new Error('Archiv ist leer');
        direct = { size: result.size, entries: result.entries };
      } catch (err) {
        await sink?.abort().catch(() => {});
        directError = err instanceof Error ? err.message : String(err);
        await task?.log(`Direktes Schreiben ins Speicherziel fehlgeschlagen (${directError}) – es wird lokal gesichert.`);
      }
    }

    if (!direct) {
    const budget = await remainingDiskBytes(server);
    // Erst unter einem vorläufigen Namen: bricht das Panel mittendrin ab,
    // räumt der nächste Start die halbe Datei weg (`cleanupPartialBackups`).
    const partial = target + PARTIAL_SUFFIX;
    try {
      await writeZip(partial, sources, {
        maxBytes: budget,
        onProgress: (done, total) => {
          const percent = total > 0 ? Math.round((done / total) * 100) : 100;
          void task?.update(20 + Math.round(percent * 0.6), `Archiv wird erstellt … ${percent} %`);
        },
      });
      await fs.rename(partial, target);
    } catch (err) {
      await fs.rm(partial, { force: true });
      await fs.rm(target, { force: true });
      throw err;
    }
    }
  } finally {
    if (running) await restoreAutosave(server);
  }

  const stat = direct ?? await fs.stat(target);

  // Lokales Archiv einmal komplett durchlesen: eines, das sich nicht entpacken
  // ließe, soll gar nicht erst als Sicherung in der Liste stehen. Ein direkt
  // ins Speicherziel geschriebenes wird nicht zurückgeladen – das kostete die
  // gesparte Zeit wieder; Prüfsummen und Längen hat der Schreiber selbst
  // gebildet, „Prüfen“ in der Liste liest es auf Wunsch nach.
  let check: ArchiveCheck | null = null;
  if (!direct) {
    await task?.update(80, 'Archiv wird geprüft …');
    try {
      check = await inspectArchive(target, (percent) => task?.update(80 + Math.round(percent * 0.1), `Archiv wird geprüft … ${percent} %`));
      if (check.entries === 0 && entries.length > 0) throw new Error('Archiv ist leer');
    } catch (err) {
      await fs.rm(target, { force: true });
      throw badRequest(`Das neue Archiv ist fehlerhaft und wurde verworfen: ${err instanceof Error ? err.message : err}`);
    }
  }
  await task?.update(direct ? 95 : 90, 'Backup wird registriert …');

  const backup = await prisma.backup.create({
    data: {
      serverId: server.id,
      targetId,
      name: options.name || `Backup ${new Date().toLocaleString('de-DE')}`,
      note: options.note ?? '',
      filename,
      sizeBytes: BigInt(stat.size),
      createdById: options.createdById ?? null,
      origin: options.origin ?? 'MANUAL',
      automationId: options.automationId ?? null,
      mirrored: Boolean(direct),
      ...(check
        ? { verifiedAt: new Date(), verifyStatus: 'OK', verifyMessage: describeCheck(check) }
        : { verifyMessage: `${direct!.entries} Einträge direkt ins Speicherziel geschrieben – noch nicht nachgelesen` }),
    },
  });

  invalidateDiskUsage(server.id);
  const pruned = await pruneToBackupLimit(server, [backup.id, ...(options.protect ?? [])]);
  const size = `${(stat.size / 1024 / 1024).toFixed(1)} MB`;

  // Zweitablage: fehlschlagen darf das, ohne die Sicherung zu entwerten –
  // die Hauptkopie liegt bereits vollstaendig auf der Platte.
  let mirrored = Boolean(direct);
  let mirrorError: string | null = null;
  if (targetActive && !direct) {
    await task?.update(95, 'Zweitkopie wird geschrieben …');
    try {
      await putBackup(server.id, filename, primaryPath(server.id, filename), (percent) => {
        void task?.update(95 + Math.round(percent * 0.04), `Zweitkopie … ${percent} %`);
      }, targetId);
      mirrored = true;
      await prisma.backup.update({ where: { id: backup.id }, data: { mirrored: true } });
      // Liegt sicher im Speicherziel – die lokale Kopie wird nicht gebraucht.
      if (!store.keepLocal) {
        await fs.rm(primaryPath(server.id, filename), { force: true });
        invalidateDiskUsage(server.id);
      }
    } catch (err) {
      mirrorError = err instanceof Error ? err.message : String(err);
    }
  }

  await task?.update(
    100,
    mirrorError
      ? `Backup erstellt (${size}) – liegt nur lokal, das Speicherziel war nicht erreichbar`
      : `Backup erstellt (${size})${mirrored && !store.keepLocal ? ' – im Speicherziel' : ''}`,
  );

  void notify('backup.done', {
    serverId: server.id,
    serverName: server.name,
    title: `Backup von ${server.name}`,
    message: mirrorError ? `${backup.name}

Speicherziel nicht erreichbar – die Sicherung liegt nur lokal: ${mirrorError}` : backup.name,
    fields: [
      { name: 'Größe', value: size },
      { name: 'Server lief', value: running ? 'ja' : 'nein' },
      ...(pruned > 0 ? [{ name: 'Alte entfernt', value: String(pruned) }] : []),
      ...(targetActive ? [{ name: 'Speicherziel', value: mirrored ? (direct ? 'direkt geschrieben' : 'ja') : 'fehlgeschlagen' }] : []),
    ],
  });

  return { ...backup, mirrored };
}

/**
 * Laeuft das Archiv einmal durch, ohne etwas zu schreiben. `strict` laesst auch
 * Warnungen (abgeschnittenes Archiv) als Fehler durchschlagen.
 */
async function assertArchiveIntact(archive: string) {
  let check: ArchiveCheck;
  try {
    check = await inspectArchive(archive);
  } catch {
    throw badRequest('Das Backup-Archiv ist beschädigt oder unvollständig – es wurde nichts verändert.');
  }
  if (check.entries === 0) {
    throw badRequest('Das Backup-Archiv ist leer – es wurde nichts verändert.');
  }
}

export interface ArchiveCheck {
  entries: number;
  /** Summe der entpackten Dateigrößen */
  bytes: number;
  /** Enthält eine Welt (level.dat) */
  hasWorld: boolean;
}

export type ArchiveFormat = 'zip' | 'tar.gz';

/**
 * Seit Fassung 1.1 sind Backups ZIPs, ältere tar.gz. Erkannt wird am Inhalt,
 * nicht am Namen – Kopien aus der Zweitablage liegen unter festem Namen.
 */
export async function archiveFormat(archive: string): Promise<ArchiveFormat> {
  const fh = await fs.open(archive, 'r');
  try {
    const head = Buffer.alloc(4);
    await fh.read(head, 0, 4, 0);
    return head[0] === 0x50 && head[1] === 0x4b ? 'zip' : 'tar.gz';
  } finally {
    await fh.close();
  }
}

/** Eigene Backups dürfen beliebig groß sein und beliebig viele Dateien haben. */
const BACKUP_ZIP_LIMITS = { maxBytes: Number.MAX_SAFE_INTEGER, maxEntries: Number.MAX_SAFE_INTEGER };

/** Jede Datei im ZIP einmal entpacken und gegen ihre CRC-Prüfsumme halten. */
async function inspectZip(archive: string, onProgress?: (percent: number) => unknown): Promise<ArchiveCheck> {
  const { entries, bytes } = await readZipEntries(archive, BACKUP_ZIP_LIMITS);
  const check: ArchiveCheck = { entries: entries.length, bytes, hasWorld: false };
  const zip = await openPromise(archive, { lazyEntries: true, autoClose: false });
  try {
    let read = 0;
    let lastReport = 0;
    for (const entry of entries) {
      if (/(^|\/)level\.dat$/.test(entry.fileName)) check.hasWorld = true;
      if (entry.fileName.endsWith('/')) continue;
      let crc = 0;
      const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          crc = crc32(chunk, crc);
          read += chunk.length;
          callback();
        },
      });
      await pipeline(await zip.openReadStreamPromise(entry), sink);
      if (crc !== entry.crc32) throw new Error(`Prüfsumme stimmt nicht: ${entry.fileName}`);
      const now = Date.now();
      if (onProgress && now - lastReport > 250) {
        lastReport = now;
        await onProgress(bytes > 0 ? Math.round((read / bytes) * 100) : 100);
      }
    }
  } finally {
    zip.close();
  }
  return check;
}

/** Liest das ganze Archiv (Prüfsummen inklusive), ohne etwas zu schreiben. */
export async function inspectArchive(archive: string, onProgress?: (percent: number) => unknown): Promise<ArchiveCheck> {
  if ((await archiveFormat(archive)) === 'zip') return inspectZip(archive, onProgress);
  const check: ArchiveCheck = { entries: 0, bytes: 0, hasWorld: false };
  await tar.list({
    file: archive,
    strict: true,
    onReadEntry: (entry) => {
      check.entries += 1;
      check.bytes += entry.size ?? 0;
      if (/(^|\/)level\.dat$/.test(entry.path)) check.hasWorld = true;
    },
  });
  return check;
}

function describeCheck(check: ArchiveCheck): string {
  const size = check.bytes >= 1024 ** 3 ? `${(check.bytes / 1024 ** 3).toFixed(1)} GB` : `${(check.bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${check.entries} Einträge, ${size} entpackt${check.hasWorld ? ', Welt enthalten' : ''}`;
}

/**
 * Prüft eine bestehende Sicherung vollständig (Hauptablage, sonst Zweitablage)
 * und merkt sich das Ergebnis. Liest nur – braucht keine Serversperre.
 */
export async function verifyBackup(server: Server, backupId: string, task?: TaskHandle) {
  const backup = await prisma.backup.findFirst({ where: { id: backupId, serverId: server.id } });
  if (!backup) throw notFound('Backup nicht gefunden');
  await task?.update(5, 'Archiv wird gesucht …');
  const fromPrimary = !!(await fs.stat(primaryPath(server.id, backup.filename)).catch(() => null));
  const source = await resolveArchive(server.id, backup.filename, backup.targetId);
  let status: 'OK' | 'FEHLER';
  let message: string;
  if (!source) {
    status = 'FEHLER';
    message = 'Archiv fehlt – weder in der Haupt- noch in der Zweitablage';
  } else {
    try {
      await task?.update(20, 'Archiv wird vollständig gelesen …');
      const check = await inspectArchive(source.path, (percent) => task?.update(20 + Math.round(percent * 0.75), `Archiv wird vollständig gelesen … ${percent} %`));
      if (check.entries === 0) throw new Error('Archiv ist leer');
      status = 'OK';
      message = `${describeCheck(check)}${fromPrimary ? '' : ' (aus der Zweitablage)'}`;
    } catch (err) {
      status = 'FEHLER';
      message = `Archiv beschädigt: ${err instanceof Error ? err.message : err}`;
    } finally {
      await source.cleanup();
    }
  }
  const updated = await prisma.backup.update({
    where: { id: backup.id },
    data: { verifiedAt: new Date(), verifyStatus: status, verifyMessage: message.slice(0, 500) },
  });
  if (status === 'FEHLER') {
    void notify('backup.failed', {
      serverId: server.id,
      serverName: server.name,
      title: `Backup-Prüfung fehlgeschlagen: ${server.name}`,
      message: `${backup.name}

${message}`,
    });
  }
  await task?.update(100, status === 'OK' ? `Backup in Ordnung – ${message}` : message);
  return updated;
}

/**
 * Holt den beiseitegelegten Stand zurück: alles, was seit dem Beiseitelegen im
 * Serververzeichnis entstanden ist, stammt aus einem halben Entpackvorgang und
 * fliegt raus. Wird sowohl beim Fehlschlag als auch beim Aufräumen eines
 * abgebrochenen früheren Laufs benutzt – nach einem Neustart mitten in der
 * Wiederherstellung ist der Ausweichordner die einzige vollständige Kopie.
 */
export interface RestoreOptions {
  /** Vorher den aktuellen Stand sichern (Standard: ja). */
  safetyBackup?: boolean;
  createdById?: string | null;
}

async function restoreBackupUnlocked(server: Server, backupId: string, task?: TaskHandle, options: RestoreOptions = {}) {
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

    // Ein abgebrochener Lauf zuerst zurück – sonst sicherte die Kopie unten nur
    // die Bruchstücke statt des vollständigen Altbestands.
    await recoverInterruptedRestore(server.id);

    // Ohne diese Kopie wäre ein versehentlich gewähltes altes Backup endgültig:
    // der aktuelle Stand wird beim Übernehmen verworfen.
    if (options.safetyBackup !== false) {
      await task?.update(10, 'Aktueller Stand wird vorher gesichert …');
      try {
        await createBackupUnlocked(server, {
          name: `Vor Wiederherstellung ${new Date().toISOString().slice(0, 16)}`,
          note: `Automatisch vor dem Einspielen von „${backup.name}“`,
          createdById: options.createdById ?? null,
          origin: 'SAFETY',
          protect: [backup.id],
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw badRequest(`Sicherheits-Backup vor der Wiederherstellung fehlgeschlagen: ${reason}`);
      }
    }

    const { state } = await dockerSvc.getState(server);
    const wasRunning = state === 'running' || state === 'starting';
    if (wasRunning) {
      await rconCommand(server, 'say Der Server wird für eine Wiederherstellung neu gestartet.').catch(() => '');
    }
    await task?.update(20, 'Server wird gestoppt …');
    await dockerSvc.stop(server);

    await recoverInterruptedRestore(server.id);
    const { dir, old, stage } = restorePaths(server.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(stage);
    try {
      await task?.update(35, 'Backup wird in einen separaten Ordner entpackt …');
      if ((await archiveFormat(archive)) === 'zip') {
        // Derselbe abgesicherte Entpacker wie beim Welt- und Server-Import:
        // Pfadgrenzen, keine Links, CRC je Datei.
        const { entries, bytes } = await readZipEntries(archive, BACKUP_ZIP_LIMITS);
        const plan = { root: '', bytes, entries: entries.filter((e) => !EXCLUDE.has(e.fileName.split('/')[0])) };
        await extractServerZip(archive, plan, stage, (percent) =>
          task ? task.update(35 + Math.round(percent * 0.45), `Backup wird entpackt … ${Math.round(percent)} %`) : Promise.resolve(),
        );
      } else {
        await tar.extract({ file: archive, cwd: stage, strict: true, filter: (name, entry) => {
          archivePath(stage, name);
          if ('type' in entry && ['SymbolicLink', 'Link'].includes(entry.type)) throw badRequest('Links sind in Sicherungen nicht erlaubt');
          return !EXCLUDE.has(name.split('/')[0]);
        } });
      }
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
      // Der alte Stand liegt wieder da – ein vorher laufender Server soll
      // nicht bis zum nächsten Blick ins Panel aus bleiben.
      if (wasRunning) {
        await dockerSvc.recreateContainer(server).then(() => dockerSvc.start(server)).catch((startError) => {
          console.error(`[restore] ${server.name}: Neustart nach fehlgeschlagener Wiederherstellung misslungen – ${startError instanceof Error ? startError.message : startError}`);
        });
      }
      throw err;
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
    invalidateDiskUsage(server.id);
    if (wasRunning) {
      await task?.update(95, 'Server wird wieder gestartet …');
      await dockerSvc.start(server);
    }
    await task?.update(100, wasRunning ? 'Backup wiederhergestellt, Server läuft wieder' : 'Backup wiederhergestellt');
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
): Promise<{ path: string; filename: string; contentType: string; cleanup: () => Promise<void> }> {
  const backup = await prisma.backup.findFirst({ where: { id: backupId, serverId: server.id } });
  if (!backup) throw notFound('Backup nicht gefunden');
  const source = await resolveArchive(server.id, backup.filename, backup.targetId);
  if (!source) throw badRequest('Backup-Datei fehlt');
  const zip = (await archiveFormat(source.path)) === 'zip';
  return {
    ...source,
    filename: `${slug(backup.name)}.${zip ? 'zip' : 'tar.gz'}`,
    contentType: zip ? 'application/zip' : 'application/gzip',
  };
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'backup';
}

export const createBackup = (...args: Parameters<typeof createBackupUnlocked>) => withServerOperation(args[0].id, "createBackup", () => createBackupUnlocked(...args));

export const restoreBackup = (...args: Parameters<typeof restoreBackupUnlocked>) => withServerOperation(args[0].id, "restoreBackup", () => restoreBackupUnlocked(...args));

export const deleteBackup = (...args: Parameters<typeof deleteBackupUnlocked>) => withServerOperation(args[0].id, "deleteBackup", () => deleteBackupUnlocked(...args));
