import { waitForServerOperation, withServerOperation } from './operations.js';
import { adjustDiskUsage, invalidateDiskUsage } from './diskUsage.js';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { crc32 } from 'node:zlib';
import { openPromise as openZip, type Entry as ZipEntry } from 'yauzl';
import { serverDir } from '../config.js';
import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { archivePath, safePath } from '../lib/safePath.js';
import { pipeline } from 'node:stream/promises';
import { byteLimit } from '../lib/byteLimit.js';

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: string;
  editable: boolean;
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.properties', '.yml', '.yaml', '.json', '.json5', '.toml', '.cfg', '.conf',
  '.ini', '.log', '.md', '.sh', '.bat', '.xml', '.html', '.css', '.js', '.ts', '.snbt',
  '.mcmeta', '.lang', '.csv', '.env', '.list', '.tsv',
]);

const MAX_EDIT_SIZE = 4 * 1024 * 1024; // 4 MB

/** Löst einen benutzerseitigen Pfad sicher innerhalb des Serververzeichnisses auf. */
export function resolveSafe(serverId: string, relative: string): string {
  const root = path.resolve(serverDir(serverId));
  const cleaned = (relative ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  return safePath(root, cleaned);
}

export function toRelative(serverId: string, absolute: string): string {
  const root = path.resolve(serverDir(serverId));
  const rel = path.relative(root, absolute).replace(/\\/g, '/');
  return rel === '' ? '/' : '/' + rel;
}

export function isEditable(name: string, size: number): boolean {
  if (size > MAX_EDIT_SIZE) return false;
  const ext = path.extname(name).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  // Dateien ohne Endung wie "eula.txt"-Geschwister oder "banned-ips"
  return ext === '' && size < 256 * 1024;
}

export async function listDir(serverId: string, relative: string): Promise<FileEntry[]> {
  const dir = resolveSafe(serverId, relative);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    throw notFound('Ordner nicht gefunden');
  }

  const out: FileEntry[] = [];
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const abs = path.join(dir, e.name);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    out.push({
      name: e.name,
      path: toRelative(serverId, abs),
      isDir: stat.isDirectory(),
      size: stat.isDirectory() ? 0 : stat.size,
      modified: stat.mtime.toISOString(),
      editable: !stat.isDirectory() && isEditable(e.name, stat.size),
    });
  }

  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'de', { numeric: true });
  });
  return out;
}

export async function readFile(serverId: string, relative: string): Promise<string> {
  const abs = resolveSafe(serverId, relative);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || stat.isDirectory()) throw notFound('Datei nicht gefunden');
  if (stat.size > MAX_EDIT_SIZE) throw badRequest('Datei ist zu groß zum Bearbeiten (> 4 MB)');
  return fs.readFile(abs, 'utf8');
}

/**
 * Erst in eine Nachbardatei schreiben, dann umbenennen: ein voller Datenträger
 * oder ein Abbruch mitten im Schreiben hinterlässt sonst eine halbe Konfiguration.
 */
async function writeFileUnlocked(serverId: string, relative: string, content: string): Promise<void> {
  const abs = resolveSafe(serverId, relative);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const temporary = `${abs}.mcpanel-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    const mode = await fs.stat(abs).then((st) => st.mode & 0o777).catch(() => null);
    if (mode !== null) await fs.chmod(temporary, mode).catch(() => {});
    await fs.rename(temporary, resolveSafe(serverId, relative));
  } catch (err) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw err;
  }
}

async function createDirUnlocked(serverId: string, relative: string): Promise<void> {
  await fs.mkdir(resolveSafe(serverId, relative), { recursive: true });
}

async function removeUnlocked(serverId: string, relatives: string[]): Promise<void> {
  for (const rel of relatives) {
    const abs = resolveSafe(serverId, rel);
    if (abs === path.resolve(serverDir(serverId))) throw badRequest('Das Serververzeichnis kann nicht gelöscht werden');
    await fs.rm(abs, { recursive: true, force: true });
  }
}

async function renameUnlocked(serverId: string, from: string, to: string): Promise<void> {
  const src = resolveSafe(serverId, from);
  const dst = resolveSafe(serverId, to);
  if ([src, dst].includes(path.resolve(serverDir(serverId)))) throw badRequest('Das Serververzeichnis kann nicht umbenannt werden');
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.rename(src, dst);
}

async function saveUploadUnlocked(
  serverId: string,
  relativeDir: string,
  filename: string,
  stream: NodeJS.ReadableStream,
  maxBytes = Infinity,
): Promise<void> {
  const safeName = path.basename(filename).replace(/[\\/:*?"<>|]/g, '_');
  const dir = resolveSafe(serverId, relativeDir);
  await fs.mkdir(dir, { recursive: true });
  resolveSafe(serverId, path.join(relativeDir, safeName));
  const tempDir = await fs.mkdtemp(path.join(dir, UPLOAD_TEMP_PREFIX));
  const temporary = path.join(tempDir, 'content');
  try {
    // Die Übertragung selbst läuft ohne Serversperre: ein langsamer Client soll
    // weder Backups noch Automationen aufhalten. Gesperrt wird nur das Ersetzen.
    await pipeline(stream, byteLimit(maxBytes), fsSync.createWriteStream(temporary));
    if ((stream as { truncated?: boolean }).truncated) throw badRequest('Upload wurde abgeschnitten');
    await waitForServerOperation(serverId, 'Datei-Upload', async () => {
      // Nach dem Warten neu prüfen – inzwischen kann ein Ordner ersetzt worden sein.
      const abs = resolveSafe(serverId, path.join(relativeDir, safeName));
      resolveSafe(serverId, toRelative(serverId, temporary));
      const before = await fs.stat(abs).then((st) => st.size).catch(() => 0);
      const after = (await fs.stat(temporary)).size;
      await fs.rename(temporary, abs);
      adjustDiskUsage(serverId, after - before);
    });
  } finally { await fs.rm(tempDir, { recursive: true, force: true }); }
}

/** Präfix der Zwischenordner von Uploads – Backups lassen sie aus. */
export const UPLOAD_TEMP_PREFIX = '.upload-';
/** Gehört der Pfad zu einem halbfertigen Upload (Panel oder SFTP)? */
export function isUploadTemp(relative: string): boolean {
  return relative.split(/[\\/]/).some((segment) => /^\.(sftp-)?upload-/.test(segment));
}

export function downloadPath(serverId: string, relative: string): string {
  return resolveSafe(serverId, relative);
}

/** Was beim Entpacken auf dem Datenträger mindestens frei bleiben muss. */
const UNZIP_RESERVE_BYTES = 1024 ** 3;
const UNZIP_MAX_ENTRIES = 100_000;

/** Freier Platz am Datenverzeichnis abzüglich Reserve; unbekannt = keine Grenze. */
async function unzipSpace(dir: string): Promise<number> {
  try {
    const stat = await fs.statfs(dir);
    return Math.max(0, Number(stat.bsize) * Number(stat.bavail) - UNZIP_RESERVE_BYTES);
  } catch {
    return Infinity;
  }
}

/**
 * ZIP-Archiv innerhalb des Serververzeichnisses entpacken.
 *
 * Datei für Datei gestreamt statt komplett in den Speicher geladen. Die im
 * Archiv angegebenen Größen sind nur Behauptungen: gezählt wird, was wirklich
 * herauskommt, und jede Datei wird bei ihrer angegebenen Größe abgeschnitten
 * und per CRC geprüft. So kann eine präparierte ZIP-Bombe weder den
 * Arbeitsspeicher noch den Datenträger füllen – auch ohne Kontingent.
 */
async function unzipUnlocked(serverId: string, relative: string, targetDir: string, maxGrowth = Infinity): Promise<void> {
  const abs = resolveSafe(serverId, relative);
  const dest = resolveSafe(serverId, targetDir);
  await fs.mkdir(dest, { recursive: true });
  const limit = Math.min(maxGrowth, await unzipSpace(dest));

  let zip;
  try {
    zip = await openZip(abs, { lazyEntries: true, autoClose: false, strictFileNames: false, validateEntrySizes: true });
  } catch {
    throw badRequest('Das ZIP ist beschädigt oder kein ZIP-Archiv');
  }
  try {
    // Erst alle Einträge prüfen, bevor auch nur eine Datei geschrieben wird.
    const entries: ZipEntry[] = [];
    let growth = 0;
    for await (const entry of zip.eachEntry()) {
      if (entries.length >= UNZIP_MAX_ENTRIES) throw badRequest('Das ZIP enthält zu viele Dateien (höchstens 100.000)');
      const output = archivePath(dest, entry.fileName);
      const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (kind && kind !== 0o100000 && kind !== 0o040000) throw badRequest('Links und Spezialdateien im ZIP werden nicht entpackt');
      if (entry.isEncrypted()) throw badRequest('Verschlüsselte ZIP-Dateien werden nicht unterstützt');
      if (!entry.fileName.endsWith('/')) {
        const previous = await fs.stat(output).catch(() => null);
        growth += Math.max(0, entry.uncompressedSize - (previous?.size ?? 0));
        if (!Number.isSafeInteger(growth) || growth > limit) throw badRequest('Speicherplatz reicht zum Entpacken nicht aus');
      }
      entries.push(entry);
    }

    let written = 0;
    for (const entry of entries) {
      if (entry.fileName.endsWith('/')) {
        await fs.mkdir(archivePath(dest, entry.fileName), { recursive: true });
        continue;
      }
      await fs.mkdir(path.dirname(archivePath(dest, entry.fileName)), { recursive: true });
      const temporary = archivePath(dest, entry.fileName) + `.mcpanel-${process.pid}-${Date.now()}.tmp`;
      let crc = 0;
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        crc = crc32(chunk, crc);
        written += chunk.length;
        if (written > limit) callback(badRequest('Speicherplatz reicht zum Entpacken nicht aus'));
        else callback(null, chunk);
      } });
      try {
        const source = await zip.openReadStreamPromise(entry);
        await pipeline(source, byteLimit(entry.uncompressedSize), meter, fsSync.createWriteStream(temporary, { flags: 'wx' }));
        if (crc !== entry.crc32) throw badRequest(`Prüfsumme im ZIP stimmt nicht: ${entry.fileName}`);
        // Nach dem Warten erneut prüfen: in der Zwischenzeit könnte ein Link entstanden sein.
        await fs.rename(temporary, archivePath(dest, entry.fileName));
      } catch (err) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // yauzl prüft Namen selbst ("invalid relative path", "absolute path").
    if (err instanceof Error && /relative path|absolute path|invalid characters/i.test(err.message)) {
      throw badRequest('Ungültiger Pfad im ZIP – Einträge außerhalb des Zielordners werden nicht entpackt');
    }
    throw badRequest('Das ZIP konnte nicht vollständig entpackt werden');
  } finally {
    zip.close();
  }
}

/** Gesamtgröße eines Verzeichnisses (rekursiv). */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(current, e.name);
      if (e.isDirectory()) stack.push(abs);
      else {
        const st = await fs.stat(abs).catch(() => null);
        if (st) total += st.size;
      }
    }
  }
  return total;
}

export const writeFile = (...args: Parameters<typeof writeFileUnlocked>) => withServerOperation(args[0], "writeFile", () => writeFileUnlocked(...args));

export const createDir = (...args: Parameters<typeof createDirUnlocked>) => withServerOperation(args[0], "createDir", () => createDirUnlocked(...args));

export const remove = (...args: Parameters<typeof removeUnlocked>) => withServerOperation(args[0], "remove", () => removeUnlocked(...args).finally(() => invalidateDiskUsage(args[0])));

export const rename = (...args: Parameters<typeof renameUnlocked>) => withServerOperation(args[0], "rename", () => renameUnlocked(...args));

/** Sperrt selbst – nur für das Übernehmen der fertigen Datei. */
export const saveUpload = saveUploadUnlocked;

export const unzip = (...args: Parameters<typeof unzipUnlocked>) => withServerOperation(args[0], "unzip", () => unzipUnlocked(...args).finally(() => invalidateDiskUsage(args[0])));
