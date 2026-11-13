/**
 * Chunks zurücksetzen: alles außerhalb (oder innerhalb) eines Bereichs aus den
 * Regionsdateien entfernen. Minecraft erzeugt diese Chunks beim nächsten
 * Betreten neu – so lässt sich eine zu groß gewordene Welt auf einen Umkreis
 * zurückstutzen oder ein Gebiet neu generieren (etwa nach einem Mod-Update).
 *
 * Gearbeitet wird direkt an den Dateien und nur bei gestopptem Server: der
 * hält die Regionsdateien offen und schriebe seinen Stand sonst zurück. So
 * geht es ohne Mod, auf jeder Version.
 *
 * Aufbau einer Regionsdatei `r.<x>.<z>.mca` (32×32 Chunks): 4 KiB Tabelle mit
 * je 4 Byte (3 Byte Sektor-Offset, 1 Byte Sektorzahl), 4 KiB Zeitstempel,
 * danach die Chunkdaten in 4-KiB-Sektoren. Zu große Chunks liegen extern in
 * `c.<x>.<z>.mcc`. Dieselbe Aufteilung haben `entities/` und `poi/` – die
 * werden mitgekürzt, sonst stünden Tiere und Dorfbewohner in leerer Landschaft.
 *
 * Eine teilweise betroffene Datei wird neu und lückenlos geschrieben (der
 * Platz wird wirklich frei), erst in eine Zwischendatei, dann per rename.
 * Liegt nichts mehr darin, wird sie gelöscht.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from '@prisma/client';
import { z } from 'zod';
import { serverDir } from '../config.js';
import { conflict } from '../lib/errors.js';
import { safePath } from '../lib/safePath.js';
import { levelName, regionDirs, type Dimension } from './regionScan.js';

const SECTOR = 4096;
const HEADER = 2 * SECTOR;
const REGION_NAME = /^r\.(-?\d+)\.(-?\d+)\.mca$/;
const EXTERNAL_NAME = /^c\.(-?\d+)\.(-?\d+)\.mcc$/;

export const trimInputSchema = z.object({
  dimension: z.enum(['overworld', 'nether', 'end']).default('overworld'),
  shape: z.enum(['circle', 'square']).default('circle'),
  centerX: z.number().int().min(-29_999_000).max(29_999_000).default(0),
  centerZ: z.number().int().min(-29_999_000).max(29_999_000).default(0),
  radius: z.number().int().min(16).max(100_000),
  /** `outside`: nur der Bereich bleibt. `inside`: der Bereich wird neu generiert. */
  mode: z.enum(['outside', 'inside']).default('outside'),
});
export type TrimInput = z.infer<typeof trimInputSchema>;

export interface TrimSummary {
  /** Gespeicherte Chunks in der Dimension (Regionsdateien) */
  chunks: number;
  /** Davon entfernt bzw. zu entfernen */
  removed: number;
  /** Frei werdender Platz (Regionen, Entities, POI, externe Chunks) */
  bytes: number;
  /** Regionsdateien, die ganz wegfallen bzw. neu geschrieben werden */
  filesDeleted: number;
  filesRewritten: number;
  /** Dateien, die übersprungen wurden (beschädigt, unlesbar) */
  skipped: string[];
}

/** Liegt der Chunk im Bereich? Maßgeblich ist seine Mitte – wie bei Chunky. */
export function chunkInArea(input: Pick<TrimInput, 'shape' | 'centerX' | 'centerZ' | 'radius'>, chunkX: number, chunkZ: number): boolean {
  const dx = chunkX * 16 + 8 - input.centerX;
  const dz = chunkZ * 16 + 8 - input.centerZ;
  if (input.shape === 'circle') return dx * dx + dz * dz <= input.radius * input.radius;
  return Math.abs(dx) <= input.radius && Math.abs(dz) <= input.radius;
}

/** Soll dieser Chunk weg? */
export function removesChunk(input: TrimInput, chunkX: number, chunkZ: number): boolean {
  const inside = chunkInArea(input, chunkX, chunkZ);
  return input.mode === 'outside' ? !inside : inside;
}

interface ChunkSlot {
  index: number;
  offset: number;
  sectors: number;
}

/** Belegte Einträge aus der Tabelle; ungültige gelten als Beschädigung. */
function slots(header: Buffer, fileSize: number, name: string): ChunkSlot[] {
  const result: ChunkSlot[] = [];
  const totalSectors = Math.ceil(fileSize / SECTOR);
  for (let index = 0; index < 1024; index++) {
    const location = header.readUInt32BE(index * 4);
    if (location === 0) continue;
    const offset = location >>> 8;
    const sectors = location & 0xff;
    if (offset < 2 || sectors === 0 || offset + sectors > totalSectors) {
      throw new Error(`${name}: ungültiger Eintrag für Chunk ${index}`);
    }
    result.push({ index, offset, sectors });
  }
  return result;
}

interface FilePlan {
  absolute: string;
  relative: string;
  size: number;
  keep: ChunkSlot[];
  drop: ChunkSlot[];
}

/** Was mit einer Datei geschähe. `null`: unberührt. */
async function planFile(root: string, relative: string, regionX: number, regionZ: number, input: TrimInput): Promise<FilePlan | null> {
  const absolute = safePath(root, relative);
  const stat = await fs.lstat(absolute);
  if (!stat.isFile()) return null;
  if (stat.size < HEADER) return null; // leere/abgebrochene Datei – Minecraft legt sie neu an
  const handle = await fs.open(absolute, 'r');
  let header: Buffer;
  try {
    header = Buffer.alloc(HEADER);
    await handle.read(header, 0, HEADER, 0);
  } finally {
    await handle.close();
  }
  const keep: ChunkSlot[] = [];
  const drop: ChunkSlot[] = [];
  for (const slot of slots(header, stat.size, relative)) {
    const chunkX = regionX * 32 + (slot.index & 31);
    const chunkZ = regionZ * 32 + (slot.index >> 5);
    (removesChunk(input, chunkX, chunkZ) ? drop : keep).push(slot);
  }
  if (drop.length === 0) return null;
  return { absolute, relative, size: stat.size, keep, drop };
}

/** Datei ohne die entfernten Chunks neu schreiben bzw. löschen. Gibt frei gewordene Bytes zurück. */
async function applyFile(root: string, plan: FilePlan): Promise<number> {
  if (plan.keep.length === 0) {
    await fs.rm(safePath(root, plan.relative), { force: true });
    return plan.size;
  }
  const source = await fs.open(plan.absolute, 'r');
  const temporary = `${plan.relative}.zuruecksetzen-${crypto.randomBytes(4).toString('hex')}.tmp`;
  let written = 0;
  try {
    const header = Buffer.alloc(HEADER);
    await source.read(header, 0, HEADER, 0);
    const fresh = Buffer.alloc(HEADER);
    const target = await fs.open(safePath(root, temporary), 'wx', 0o644);
    try {
      let next = 2;
      // In der bisherigen Reihenfolge – Nachbarn bleiben nah beieinander.
      for (const slot of [...plan.keep].sort((a, b) => a.offset - b.offset)) {
        const data = Buffer.alloc(slot.sectors * SECTOR);
        const length = Math.min(data.length, plan.size - slot.offset * SECTOR);
        let read = 0;
        while (read < length) {
          const { bytesRead } = await source.read(data, read, length - read, slot.offset * SECTOR + read);
          if (bytesRead === 0) throw new Error(`${plan.relative}: Datei endet mitten in Chunk ${slot.index}`);
          read += bytesRead;
        }
        await target.write(data, 0, data.length, next * SECTOR);
        fresh.writeUInt32BE(((next << 8) | slot.sectors) >>> 0, slot.index * 4);
        fresh.writeUInt32BE(header.readUInt32BE(SECTOR + slot.index * 4), SECTOR + slot.index * 4);
        next += slot.sectors;
      }
      await target.write(fresh, 0, HEADER, 0);
      await target.sync();
      written = next * SECTOR;
    } finally {
      await target.close();
    }
    // Nach den Wartezeiten erneut prüfen: kein Link darf untergeschoben worden sein.
    await fs.rename(safePath(root, temporary), safePath(root, plan.relative));
  } catch (err) {
    await fs.rm(safePath(root, temporary), { force: true }).catch(() => {});
    throw err;
  } finally {
    await source.close();
  }
  return Math.max(0, plan.size - written);
}

/** Region-, Entity- und POI-Ordner einer Dimension, soweit vorhanden. */
async function dimensionDirs(serverId: string, dimension: Dimension): Promise<string[]> {
  const root = serverDir(serverId);
  const level = await levelName(serverId);
  const dirs: string[] = [];
  for (const regionDir of regionDirs(level, dimension)) {
    const base = path.posix.dirname(regionDir);
    for (const kind of ['region', 'entities', 'poi']) {
      const relative = path.posix.join(base, kind);
      const stat = await fs.lstat(safePath(root, relative)).catch(() => null);
      if (stat?.isDirectory()) dirs.push(relative);
    }
  }
  return dirs;
}

/**
 * Plant (`apply = false`) oder führt aus. Beim Ausführen muss der Aufrufer die
 * Serversperre halten und der Server gestoppt sein.
 */
export async function trimChunks(
  server: Pick<Server, 'id'>,
  input: TrimInput,
  options: { apply: boolean; onProgress?: (done: number, total: number) => unknown },
): Promise<TrimSummary> {
  const root = serverDir(server.id);
  const summary: TrimSummary = { chunks: 0, removed: 0, bytes: 0, filesDeleted: 0, filesRewritten: 0, skipped: [] };
  const dirs = await dimensionDirs(server.id, input.dimension);

  const work: { dir: string; name: string; x: number; z: number }[] = [];
  const external: { dir: string; name: string; x: number; z: number }[] = [];
  for (const dir of dirs) {
    for (const name of await fs.readdir(safePath(root, dir)).catch(() => [] as string[])) {
      const region = REGION_NAME.exec(name);
      if (region) { work.push({ dir, name, x: Number(region[1]), z: Number(region[2]) }); continue; }
      const chunk = EXTERNAL_NAME.exec(name);
      if (chunk) external.push({ dir, name, x: Number(chunk[1]), z: Number(chunk[2]) });
    }
  }

  let done = 0;
  for (const item of work) {
    const relative = path.posix.join(item.dir, item.name);
    const isRegion = path.posix.basename(item.dir) === 'region';
    try {
      const plan = await planFile(root, relative, item.x, item.z, input);
      if (isRegion) {
        // Gespeicherte Chunks zählen nur einmal – aus den Regionsdateien.
        const total = plan ? plan.keep.length + plan.drop.length : await countChunks(root, relative);
        summary.chunks += total;
        summary.removed += plan?.drop.length ?? 0;
      }
      if (plan) {
        if (options.apply) {
          summary.bytes += await applyFile(root, plan);
        } else {
          summary.bytes += plan.keep.length === 0 ? plan.size : plan.drop.reduce((sum, slot) => sum + slot.sectors * SECTOR, 0);
        }
        if (isRegion) {
          if (plan.keep.length === 0) summary.filesDeleted += 1;
          else summary.filesRewritten += 1;
        }
      }
    } catch (err) {
      summary.skipped.push(`${relative}: ${err instanceof Error ? err.message : String(err)}`);
    }
    done += 1;
    await options.onProgress?.(done, work.length);
  }

  // Ausgelagerte große Chunks der entfernten Positionen gleich mit.
  for (const item of external) {
    if (!removesChunk(input, item.x, item.z)) continue;
    const relative = path.posix.join(item.dir, item.name);
    const stat = await fs.lstat(safePath(root, relative)).catch(() => null);
    if (!stat?.isFile()) continue;
    summary.bytes += stat.size;
    if (options.apply) await fs.rm(safePath(root, relative), { force: true });
  }
  return summary;
}

async function countChunks(root: string, relative: string): Promise<number> {
  const absolute = safePath(root, relative);
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat?.isFile() || stat.size < HEADER) return 0;
  const handle = await fs.open(absolute, 'r');
  try {
    const header = Buffer.alloc(SECTOR);
    await handle.read(header, 0, SECTOR, 0);
    let count = 0;
    for (let i = 0; i < 1024; i++) if (header.readUInt32BE(i * 4) !== 0) count++;
    return count;
  } finally {
    await handle.close();
  }
}

/** Der Server hält die Regionsdateien offen – nur im gestoppten Zustand. */
export function assertStopped(state: string): void {
  if (state === 'running' || state === 'starting') throw conflict('Chunks lassen sich nur bei gestopptem Server zurücksetzen. Bitte zuerst stoppen.');
  if (state === 'unreachable') throw conflict('Die Node dieses Servers ist gerade nicht erreichbar.');
}
