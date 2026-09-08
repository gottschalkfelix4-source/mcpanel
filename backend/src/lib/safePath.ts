import fs from 'node:fs';
import path from 'node:path';
import { badRequest } from './errors.js';

/** Bound paths by components, and refuse links (including a linked root).
 * Call again immediately before a filesystem mutation after awaiting other work.
 */
export function safePath(root: string, relative: string): string {
  root = path.resolve(root);
  if (relative.includes('\0')) throw badRequest('Ungültiger Pfad');
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) throw badRequest('Ungültiger Pfad');
  let current = root;
  const parts = ['', ...path.relative(root, target).split(path.sep).filter(Boolean)];
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw badRequest('Symbolische Links sind nicht erlaubt');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return target;
}

/** Archive paths must not use traversal, drive letters or absolute roots. */
export function archivePath(root: string, entry: string): string {
  const normalized = entry.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').includes('..')) {
    throw badRequest('Archiv enthält einen ungültigen Pfad');
  }
  return safePath(root, normalized);
}
