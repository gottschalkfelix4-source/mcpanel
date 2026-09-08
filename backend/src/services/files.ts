import { withServerOperation } from './operations.js';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { serverDir } from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';
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

async function writeFileUnlocked(serverId: string, relative: string, content: string): Promise<void> {
  const abs = resolveSafe(serverId, relative);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
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
  const abs = resolveSafe(serverId, path.join(relativeDir, safeName));
  const tempDir = await fs.mkdtemp(path.join(dir, '.upload-'));
  const temporary = path.join(tempDir, 'content');
  try {
    await pipeline(stream, byteLimit(maxBytes), fsSync.createWriteStream(temporary));
    if ((stream as { truncated?: boolean }).truncated) throw badRequest('Upload wurde abgeschnitten');
    resolveSafe(serverId, path.join(relativeDir, safeName));
    await fs.rename(temporary, abs);
  } finally { await fs.rm(tempDir, { recursive: true, force: true }); }
}

export function downloadPath(serverId: string, relative: string): string {
  return resolveSafe(serverId, relative);
}

/** ZIP-Archiv innerhalb des Serververzeichnisses entpacken. */
async function unzipUnlocked(serverId: string, relative: string, targetDir: string, maxGrowth = Infinity): Promise<void> {
  const abs = resolveSafe(serverId, relative);
  const dest = resolveSafe(serverId, targetDir);
  await fs.mkdir(dest, { recursive: true });
  const zip = new AdmZip(abs);
  // Validate the entire archive before writing even its first entry.
  let growth = 0;
  for (const entry of zip.getEntries()) {
    const output = archivePath(dest, entry.entryName);
    if (entry.isDirectory) continue;
    const previous = await fs.stat(output).catch(() => null);
    growth += Math.max(0, entry.header.size - (previous?.size ?? 0));
    if (growth > maxGrowth) throw badRequest('Speicherkontingent reicht zum Entpacken nicht aus');
  }
  for (const entry of zip.getEntries()) {
    const outPath = archivePath(dest, entry.entryName);
    if (entry.isDirectory) {
      await fs.mkdir(outPath, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, entry.getData());
    }
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

export const remove = (...args: Parameters<typeof removeUnlocked>) => withServerOperation(args[0], "remove", () => removeUnlocked(...args));

export const rename = (...args: Parameters<typeof renameUnlocked>) => withServerOperation(args[0], "rename", () => renameUnlocked(...args));

export const saveUpload = (...args: Parameters<typeof saveUploadUnlocked>) => withServerOperation(args[0], "saveUpload", () => saveUploadUnlocked(...args));

export const unzip = (...args: Parameters<typeof unzipUnlocked>) => withServerOperation(args[0], "unzip", () => unzipUnlocked(...args));
