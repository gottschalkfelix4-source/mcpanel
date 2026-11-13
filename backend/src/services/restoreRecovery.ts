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
  return Boolean(record) || await exists(old) || await exists(stage) || (await legacyStash(dir)) !== null;
}

/**
 * Ausweichordner alter Versionen *im* Serverordner. Alles dort können
 * Mitglieder und der Minecraft-Prozess selbst anlegen, deshalb gilt er nur,
 * wenn er ein echtes Verzeichnis ist: einer Verknüpfung zu folgen, hieße,
 * fremde Ordner (etwa das Datenverzeichnis mit dem JWT-Geheimnis oder einen
 * anderen Server) in diesen Serverordner zu verschieben. Liegt schon eine
 * Bergungskopie daneben, wird nicht erneut geborgen – sonst ließe sich mit
 * einem leeren Ordner dieses Namens bei jedem Start eine Vollkopie erzwingen.
 */
async function legacyStash(dir: string): Promise<string | null> {
  const legacy = path.join(dir, '.restore-old');
  const stat = await fs.lstat(legacy).catch(err => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  });
  if (!stat) return null;
  if (!stat.isDirectory()) {
    console.warn(`[restore] ${legacy} ist kein Verzeichnis und wird nicht als alter Stand behandelt.`);
    return null;
  }
  const parent = path.dirname(dir);
  const prefix = path.basename(dir) + '.recovery-';
  const salvaged = (await fs.readdir(parent).catch(() => [])).some(name => name.startsWith(prefix));
  if (salvaged) {
    console.warn(`[restore] ${legacy} bleibt unangetastet: daneben liegt bereits eine Bergungskopie (${prefix}*). Bitte von Hand prüfen.`);
    return null;
  }
  return legacy;
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

/** Nur einfache Ordnernamen direkt im Serverordner – nie Pfade. */
function movedNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((name): name is string =>
    typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !/[/\\\0]/.test(name));
}

/**
 * Beim Austausch umgehängte Ordner (Welt & Co.) vor dem Zurückrollen wieder
 * an ihren alten Platz legen. Muss vollständig gelingen, bevor der neue
 * Ordner gelöscht wird – sonst ginge die Welt mit ihm verloren.
 */
async function moveBack(dir: string, old: string, names: string[]): Promise<void> {
  for (const name of names) {
    const current = path.join(dir, name);
    if (!(await exists(current))) continue;
    const previous = path.join(old, name);
    if (await exists(previous)) {
      throw new Error(`Wiederherstellung angehalten: „${name}“ liegt im alten und im neuen Stand. Bitte von Hand prüfen (${old}).`);
    }
    await fs.rename(current, previous);
  }
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
    await moveBack(dir, old, movedNames(record?.moved));
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
  const legacy = await legacyStash(dir);
  if (legacy) {
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

/**
 * Call only after the staged contents have been validated and the server is stopped.
 *
 * `moved`: Ordner des bisherigen Stands, die unverändert übernommen werden
 * (Welt, Karten, mod-eigene Sicherungen). Sie wurden nicht in den neuen Stand
 * kopiert, sondern werden hier umgehängt – auf demselben Dateisystem dauert
 * das unabhängig von der Größe nur einen Augenblick. Die Namen stehen vorher
 * im Journal, damit ein Zurückrollen sie wieder an ihren Platz legt.
 */
export async function commitRestore(id: string, moved: string[] = []): Promise<void> {
  const { dir, old, stage, journal } = restorePaths(id);
  const names = movedNames(moved);
  if (names.length !== moved.length) throw new Error('Ungültiger Ordnername beim Übernehmen');
  for (const name of names) {
    if (await exists(path.join(stage, name))) throw new Error(`„${name}“ existiert im neuen Stand bereits – Übernehmen abgebrochen`);
  }
  if (names.length > 0) {
    const record = (await readJournal(journal)) ?? { committed: false, at: Date.now() };
    await writeJournal(id, { ...record, moved: names });
  }
  await fs.rename(dir, old);
  try {
    await fs.rename(stage, dir);
  } catch (err) {
    await fs.rename(old, dir);
    throw err;
  }
  for (const name of names) {
    if (await exists(path.join(old, name))) await fs.rename(path.join(old, name), path.join(dir, name));
  }
}
