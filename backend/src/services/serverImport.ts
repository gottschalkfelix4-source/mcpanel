import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import { openPromise, type Entry } from 'yauzl';
import { z } from 'zod';
import { badRequest, conflict } from '../lib/errors.js';
import { archivePath, safePath } from '../lib/safePath.js';
import { byteLimit } from '../lib/byteLimit.js';
import { serverDir } from '../config.js';
import { prisma } from '../db.js';
import { withServerOperation } from './operations.js';
import { commitRestore, finishRestore, recoverInterruptedRestore, restorePaths, saveRestoreMetadata } from './restoreRecovery.js';
import { parseProperties } from './properties.js';
import { invalidateDiskUsage } from './diskUsage.js';
import * as docker from './docker.js';
import { waitForServerReady } from './serverStartup.js';
import type { TaskHandle } from './tasks.js';

export const IMPORT_UPLOAD_LIMIT = 4 * 1024 ** 3;
export const IMPORT_EXPANDED_LIMIT = 64 * 1024 ** 3;
export const importSchema = z.object({
  name: z.string().trim().min(2).max(48),
  type: z.enum(['VANILLA', 'PAPER', 'PURPUR', 'SPIGOT', 'FABRIC', 'FORGE', 'NEOFORGE', 'QUILT']),
  mcVersion: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/, 'Bitte die genaue Minecraft-Version angeben.'),
  loaderVersion: z.string().regex(/^\d[\w.+-]*$/, 'Ungültige Loader-Version').max(80).optional(),
  memoryMb: z.coerce.number().int().min(512).max(65536).default(4096),
  startAfter: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
}).strict().superRefine((value, ctx) => {
  if (['FORGE', 'NEOFORGE', 'FABRIC', 'QUILT'].includes(value.type) && !value.loaderVersion) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['loaderVersion'], message: 'Bitte die bisherige Loader-Version angeben.' });
  }
});
export type ImportRequest = z.infer<typeof importSchema>;

export function importEnvironment(request: ImportRequest): Record<string, string> {
  const keys: Partial<Record<ImportRequest['type'], string>> = { FORGE: 'FORGE_VERSION', NEOFORGE: 'NEOFORGE_VERSION', FABRIC: 'FABRIC_LOADER_VERSION', QUILT: 'QUILT_LOADER_VERSION' };
  const key = keys[request.type];
  return key && request.loaderVersion ? { [key]: request.loaderVersion } : {};
}

export interface ImportPlan { root: string; entries: Entry[]; bytes: number }
const ignored = (name: string) => name.startsWith('__MACOSX/') || name.split('/').pop() === '.DS_Store';

/** ZIP-Metadaten vollständig prüfen, bevor Dateien oder ein Server angelegt werden. */
export async function inspectServerZip(file: string, maxBytes = IMPORT_EXPANDED_LIMIT): Promise<ImportPlan> {
  let zip;
  try {
    zip = await openPromise(file, { lazyEntries: true, autoClose: false });
    const entries: Entry[] = [];
    const seen = new Set<string>();
    const files = new Set<string>();
    let bytes = 0;
    for await (const entry of zip.eachEntry()) {
      if (entries.length >= 100_000) throw badRequest('Das ZIP enthält zu viele Dateien (höchstens 100.000).');
      const name = entry.fileName;
      archivePath(path.dirname(file), name);
      const parts = name.replace(/\/$/, '').split('/');
      if (parts.some(p => !p || p === '.' || /[:\x00-\x1f]/.test(p))) throw badRequest('Das ZIP enthält einen ungültigen Dateipfad.');
      const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (kind && kind !== 0o100000 && kind !== 0o040000) throw badRequest('Links und Spezialdateien sind im Server-ZIP nicht erlaubt.');
      if (entry.isEncrypted()) throw badRequest('Verschlüsselte ZIP-Dateien werden nicht unterstützt.');
      if (/(?:^|\/)server\.properties$/.test(name) && entry.uncompressedSize > 1024 * 1024) throw badRequest('server.properties ist ungewöhnlich groß.');
      const key = parts.join('/').toLowerCase();
      if (seen.has(key)) throw badRequest('Das ZIP enthält doppelte Dateipfade.');
      seen.add(key);
      if (!name.endsWith('/')) files.add(key);
      bytes += entry.uncompressedSize;
      if (!Number.isSafeInteger(bytes) || bytes > maxBytes) throw badRequest('Das entpackte ZIP überschreitet den verfügbaren Speicher oder die Grenze von 64 GiB.');
      entries.push(entry);
    }
    for (const key of seen) {
      const parts = key.split('/');
      while (parts.length > 1) { parts.pop(); if (files.has(parts.join('/'))) throw badRequest('Dateien und Ordner im ZIP haben widersprüchliche Pfade.'); }
    }
    const usable = entries.filter(e => !ignored(e.fileName));
    const properties = usable.filter(e => /(?:^|\/)server\.properties$/.test(e.fileName));
    const direct = properties.find(e => e.fileName === 'server.properties');
    if (!direct && properties.length !== 1) throw badRequest('Das ZIP muss einen eindeutigen Serverordner mit server.properties enthalten.');
    const root = direct ? '' : properties[0].fileName.slice(0, -'server.properties'.length);
    if (usable.some(e => !e.fileName.startsWith(root) && !(e.fileName.endsWith('/') && root.startsWith(e.fileName)))) {
      throw badRequest('Bitte nur den Serverordner oder dessen Inhalt als ZIP hochladen.');
    }
    return { root, entries: usable.filter(e => e.fileName.startsWith(root) && e.fileName !== root), bytes };
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode) throw error;
    throw badRequest('Das ZIP ist beschädigt oder enthält unzulässige Dateien.');
  } finally { zip?.close(); }
}

/** Große Welten dateiweise übertragen, Größen und CRC prüfen, niemals Skripte ausführen. */
export async function extractServerZip(file: string, plan: ImportPlan, destination: string, progress: (percent: number) => Promise<void>) {
  const zip = await openPromise(file, { lazyEntries: true, autoClose: false });
  try {
    let completed = 0;
    for (const entry of plan.entries) {
      const relative = entry.fileName.slice(plan.root.length);
      if (entry.fileName.endsWith('/')) {
        await fs.mkdir(archivePath(destination, relative), { recursive: true });
      } else {
        await fs.mkdir(path.dirname(archivePath(destination, relative)), { recursive: true });
        let crc = 0;
        const meter = new Transform({ transform(chunk, _encoding, callback) { crc = crc32(chunk, crc); callback(null, chunk); } });
        const source = await zip.openReadStreamPromise(entry);
        await pipeline(source, byteLimit(entry.uncompressedSize), meter, createWriteStream(archivePath(destination, relative), { flags: 'wx' }));
        if (crc !== entry.crc32) throw badRequest(`Prüfsumme im ZIP stimmt nicht: ${relative}`);
      }
      if (++completed % 100 === 0 || completed === plan.entries.length) await progress(completed / plan.entries.length * 100);
    }
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode) throw error;
    throw badRequest('Das Server-ZIP konnte nicht vollständig entpackt werden. Bitte Archiv und freien Speicher prüfen.');
  } finally { zip.close(); }
}

/** Nur vom Import-Endpunkt für einen frisch angelegten Server aufgerufen. */
export async function importServerZip(id: string, file: string, plan: ImportPlan, request: ImportRequest, task: TaskHandle, actor?: { id: string; isAdmin: boolean }) {
  return withServerOperation(id, 'Ein ZIP-Import', async () => {
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const state = await docker.getState(server);
    const original = await fs.readdir(serverDir(id));
    if (!actor && (!['stopped', 'missing'].includes(state.state) || original.some(name => name !== 'eula.txt'))) {
      throw conflict('ZIP-Import ist nur in einen neuen, leeren Server möglich. Bestehende Daten werden nicht überschrieben.');
    }
    const { stage } = restorePaths(id);
    let committed = false, changing = false;
    let imported = server;
    try {
      const free = await fs.statfs(serverDir(id));
      if (plan.bytes > free.bavail * free.bsize - 64 * 1024 ** 2) throw badRequest('Nicht genügend freier Speicher für den Serverimport.');
      await fs.mkdir(stage);
      await extractServerZip(file, plan, stage, percent => task.update(5 + percent * 0.85, 'Serverdateien werden geprüft und entpackt …'));
      const properties = safePath(stage, 'server.properties');
      const raw = await fs.readFile(properties, 'utf8');
      if (raw.length > 1024 * 1024) throw badRequest('server.properties ist ungewöhnlich groß.');
      const world = parseProperties(raw)['level-name'] || 'world';
      archivePath(stage, world);
      if (!world || /[\\:\r\n\0]/.test(world)) throw badRequest('Ungültiger Weltpfad in server.properties.');
      // Die letzten Java-Properties gewinnen auch bei doppelten/escaped Schlüsseln.
      const managed = `\n\nserver-ip=\nserver-port=25565\nenable-rcon=true\nrcon.port=25575\nrcon.password=${server.rconPassword}\nquery.port=25565\n`;
      await fs.writeFile(safePath(stage, 'server.properties'), raw + managed);
      await fs.writeFile(safePath(stage, 'eula.txt'), 'eula=true\n');
      // Alte Startdateien erhalten, ohne fremde JVM-Argumente beim Start zu verwenden.
      const launchFiles = (await fs.readdir(stage)).filter(name => name === 'user_jvm_args.txt' || /\.(sh|bat|ps1|command)$/i.test(name));
      if (launchFiles.length) {
        const stored = await fs.mkdtemp(path.join(stage, 'import-startdateien-'));
        for (const name of launchFiles) await fs.rename(safePath(stage, name), safePath(stage, path.relative(stage, path.join(stored, name))));
        await task.log('Bisherige Startskripte und JVM-Argumente bleiben im Ordner ' + path.basename(stored) + ' erhalten.');
      }
      if (actor) {
        const { assertMemoryAllowed } = await import('./quota.js');
        const { createBackup } = await import('./backups.js');
        const { dirSize } = await import('./files.js');
        const { serverBackupDir } = await import('../config.js');
        const { reinstallEnvironment, reinstallMetadata } = await import('./reinstallationData.js');
        assertMemoryAllowed(server, request.memoryMb, actor.isAdmin);
        if (server.quotaDiskMb > 0 && plan.bytes > server.quotaDiskMb * 1024 ** 2) throw badRequest('Das ZIP überschreitet das Speicherkontingent des Servers.');
        await docker.ensureImage(docker.imageForServer({ ...server, type: request.type, mcVersion: request.mcVersion }));
        changing = true;
        await docker.stop(server);
        const backup = await createBackup(server, { name: `Vor ZIP-Import ${new Date().toISOString().slice(0, 16)}`, note: 'Automatisch vor ZIP-Import', createdById: actor.id, origin: 'SAFETY' });
        await task.log(`Sicherheitsbackup erstellt: ${backup.name}`);
        if (server.quotaDiskMb > 0 && await dirSize(stage) + await dirSize(serverBackupDir(id)) > server.quotaDiskMb * 1024 ** 2) throw badRequest('Speicherkontingent reicht für ZIP-Import und Sicherheitsbackup nicht aus.');
        await saveRestoreMetadata(id, reinstallMetadata(server));
        imported = await prisma.server.update({ where: { id }, data: {
          name: request.name, type: request.type, mcVersion: request.mcVersion, memoryMb: request.memoryMb,
          extraEnv: { ...reinstallEnvironment(server), ...importEnvironment(request) },
          modpackProvider: null, modpackProjectId: null, modpackVersionId: null, modpackName: null, modpackVersionName: null, modpackIconUrl: null,
        } });
      }
      await commitRestore(id);
      if (actor) await docker.recreateContainer(imported);
      await finishRestore(id);
      committed = true;
      invalidateDiskUsage(id);
      await task.log('Serverdateien einschließlich Welten, Mods, Plugins und Spielerlisten übernommen. Netzwerk und RCON auf das Panel angepasst.');
      if (request.startAfter) {
        await docker.start(imported);
        await waitForServerReady(imported, { onWaiting: message => task.update(95, message) });
      }
      await task.update(100, request.startAfter ? 'Import abgeschlossen – Minecraft antwortet.' : 'Import abgeschlossen – der Server kann gestartet werden.');
    } catch (error) {
      if (!committed) {
        await recoverInterruptedRestore(id);
        if (changing) {
          const recovered = await prisma.server.findUniqueOrThrow({ where: { id } });
          await docker.recreateContainer(recovered);
          if (['running', 'starting'].includes(state.state)) await docker.start(recovered);
        }
      }
      // Nach erfolgreichem Import bleiben Welten auch bei einem Startfehler erhalten.
      throw error;
    }
  });
}
