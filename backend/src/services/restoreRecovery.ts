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
  await writeJournal(id, { data, committed: false });
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
  if (!record?.committed && await exists(old)) {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(old, dir);
  }
  if (!record?.committed && record?.data) {
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
