import fs from 'node:fs/promises';
import path from 'node:path';
import { serverDir } from '../config.js';

export const restorePaths = (id: string) => ({
  dir: serverDir(id),
  old: serverDir(id) + '.restore-old',
  stage: serverDir(id) + '.restore-stage',
  journal: serverDir(id) + '.restore-journal.json',
});
const exists = (file: string) => fs.lstat(file).then(() => true, err => {
  if (err.code === 'ENOENT') return false;
  throw err;
});
const readJournal = (file: string) => fs.readFile(file, 'utf8').then(text => JSON.parse(text), err => {
  if (err.code === 'ENOENT') return null;
  throw err;
});

/** A rollback must stop/recreate a possibly newer container before autostart. */
export async function hasInterruptedRestore(id: string): Promise<boolean> {
  const { dir, old, stage, journal } = restorePaths(id);
  const record = await readJournal(journal);
  if (record?.committed) return false;
  return Boolean(record) || await exists(old) || await exists(stage) || await exists(path.join(dir, '.restore-old'));
}

async function writeJournal(id: string, value: unknown): Promise<void> {
  const { journal } = restorePaths(id);
  await fs.writeFile(journal + '.tmp', JSON.stringify(value), { mode: 0o600 });
  await fs.rename(journal + '.tmp', journal);
}

export async function saveRestoreMetadata(id: string, data: Record<string, unknown>): Promise<void> {
  await writeJournal(id, { data, committed: false, at: Date.now() });
}

/**
 * Ab diesem Alter wird ein unterbrochener Vorgang nicht mehr zurückgerollt.
 * Die Wiederherstellung beim Panel-Start kann ausfallen (Docker oder die Node
 * noch nicht erreichbar). Läuft der Server danach tagelang auf dem neuen
 * Stand, würde ein spätes Zurückrollen genau diese Tage löschen.
 */
export const STALE_RESTORE_MS = 2 * 3600_000;

/** Wann der unterbrochene Vorgang begann – aus dem Journal, sonst vom Ausweichordner. */
async function interruptedSince(record: { at?: number } | null, old: string): Promise<number | null> {
  if (typeof record?.at === 'number') return record.at;
  const stat = await fs.lstat(old).catch(() => null);
  return stat ? stat.ctimeMs : null;
}

export async function finishRestore(id: string): Promise<void> {
  const { old, journal } = restorePaths(id);
  await writeJournal(id, { committed: true });
  await fs.rm(old, { recursive: true, force: true });
  await fs.rm(journal, { force: true });
}

/** Directory renames are atomic. Presence of old means the commit was interrupted. */
export async function recoverInterruptedRestore(id: string): Promise<void> {
  const { dir, old, stage, journal } = restorePaths(id);
  const record = await readJournal(journal);
  const since = await interruptedSince(record, old);
  const stale = !record?.committed && since !== null && Date.now() - since > STALE_RESTORE_MS && await exists(dir);
  if (stale) {
    // Zu alt: den aktuellen Stand behalten, den alten nur beiseitelegen.
    if (await exists(old)) {
      const kept = `${dir}.restore-verwaist-${new Date(since!).toISOString().slice(0, 10)}-${Date.now()}`;
      await fs.rename(old, kept);
      console.warn(`[restore] ${id}: unterbrochener Vorgang vom ${new Date(since!).toISOString()} wird nicht mehr zurückgerollt – alter Stand liegt unter ${kept}`);
    }
  } else if (!record?.committed && await exists(old)) {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(old, dir);
  }
  if (!stale && !record?.committed && record?.data) {
    const { prisma } = await import('../db.js');
    await prisma.server.update({ where: { id }, data: record.data });
  }
  await fs.rm(old, { recursive: true, force: true });
  await fs.rm(journal, { force: true });
  await fs.rm(stage, { recursive: true, force: true });
  // Legacy versions moved entries individually. Preserve everything outside
  // the stash before recovering it: it might still be original data.
  const legacy = path.join(dir, '.restore-old');
  if (await exists(legacy)) {
    const salvage = await fs.mkdtemp(dir + '.recovery-');
    for (const name of await fs.readdir(dir)) {
      if (name !== '.restore-old') await fs.rename(path.join(dir, name), path.join(salvage, name));
    }
    // Preserve entries not moved before the old process died. Copies remain
    // in salvage too because old versions did not journal their extraction phase.
    for (const name of await fs.readdir(salvage)) await fs.cp(path.join(salvage, name), path.join(dir, name), { recursive: true });
    for (const name of await fs.readdir(legacy)) {
      await fs.rm(path.join(dir, name), { recursive: true, force: true });
      await fs.rename(path.join(legacy, name), path.join(dir, name));
    }
    await fs.rmdir(legacy);
  }
}

/** Call only after the staged contents have been validated and the server is stopped. */
export async function commitRestore(id: string): Promise<void> {
  const { dir, old, stage } = restorePaths(id);
  await fs.rename(dir, old);
  try {
    await fs.rename(stage, dir);
  } catch (err) {
    await fs.rename(old, dir);
    throw err;
  }
}
