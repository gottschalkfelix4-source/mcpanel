/**
 * Welche Chunks einer Welt gibt es schon?
 *
 * Jede Regionsdatei `r.<x>.<z>.mca` fasst 32×32 Chunks. Ihre ersten 4 KiB
 * sind eine Tabelle mit 1024 Einträgen à 4 Byte (Sektor-Offset + Länge) – ein
 * Eintrag ungleich null heißt: dieser Chunk ist gespeichert. Gelesen wird nur
 * dieser Kopf, nie die Chunkdaten selbst; so bleibt auch eine große Welt
 * schnell und die Karte funktioniert ohne Mod, auf jeder Version und bei
 * gestopptem Server.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { serverDir } from '../config.js';
import { badRequest } from '../lib/errors.js';
import { safePath } from '../lib/safePath.js';
import { parseProperties } from './properties.js';

export type Dimension = 'overworld' | 'nether' | 'end';

export const DIMENSION_IDS: Record<Dimension, string> = {
  overworld: 'minecraft:overworld',
  nether: 'minecraft:the_nether',
  end: 'minecraft:the_end',
};

export interface RegionBits {
  x: number;
  z: number;
  /** 1024 Bit (128 Byte) als Base64, Bit i = Chunk (i % 32, i / 32) der Region */
  bits: string;
  count: number;
}

export interface ChunkMap {
  dimension: Dimension;
  regions: RegionBits[];
  chunks: number;
  /** Mehr Regionen als ausgeliefert (sehr große Welt) */
  truncated: boolean;
}

const MAX_REGIONS = 20_000;
const REGION_NAME = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

/** Weltordner laut server.properties (`level-name`), Standard `world`. */
export async function levelName(serverId: string): Promise<string> {
  const root = serverDir(serverId);
  const raw = await fs.readFile(safePath(root, 'server.properties'), 'utf8').catch(() => '');
  const name = parseProperties(raw)['level-name'] || 'world';
  if (['.', '..'].includes(name) || /[/\\\r\n\0]/.test(name)) throw badRequest('Ungültiger Weltname in server.properties');
  return name;
}

/**
 * Mögliche Regionsordner je Dimension. Vanilla, Forge und Fabric legen Nether
 * und End unter die Hauptwelt, Bukkit-Abkömmlinge in eigene Weltordner.
 */
export function regionDirs(level: string, dimension: Dimension): string[] {
  if (dimension === 'overworld') return [`${level}/region`];
  if (dimension === 'nether') return [`${level}/DIM-1/region`, `${level}_nether/DIM-1/region`];
  return [`${level}/DIM1/region`, `${level}_the_end/DIM1/region`];
}

/** Belegte Chunks aus dem 4-KiB-Kopf einer Regionsdatei. */
export function headerBits(header: Buffer): { bits: Buffer; count: number } {
  const bits = Buffer.alloc(128);
  let count = 0;
  for (let i = 0; i < 1024; i++) {
    const offset = i * 4;
    if (offset + 4 > header.length) break;
    if (header.readUInt32BE(offset) !== 0) {
      bits[i >> 3] |= 1 << (i & 7);
      count++;
    }
  }
  return { bits, count };
}

/** Kopfdaten je Datei – neu gelesen nur, wenn sich Größe oder Zeitstempel ändern. */
const cache = new Map<string, { key: string; bits: string; count: number }>();

async function readRegion(file: string): Promise<{ bits: string; count: number } | null> {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.size < 8192) return null;
  const key = `${stat.size}:${stat.mtimeMs}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit;
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(4096);
    await handle.read(header, 0, 4096, 0);
    const { bits, count } = headerBits(header);
    const entry = { key, bits: bits.toString('base64'), count };
    cache.set(file, entry);
    if (cache.size > 50_000) cache.delete(cache.keys().next().value!);
    return entry;
  } finally {
    await handle.close();
  }
}

export async function scanChunks(serverId: string, dimension: Dimension): Promise<ChunkMap> {
  const root = serverDir(serverId);
  const level = await levelName(serverId);
  const result: ChunkMap = { dimension, regions: [], chunks: 0, truncated: false };

  for (const relative of regionDirs(level, dimension)) {
    let names: string[];
    try {
      names = await fs.readdir(safePath(root, relative));
    } catch {
      continue;
    }
    for (const name of names) {
      const match = REGION_NAME.exec(name);
      if (!match) continue;
      if (result.regions.length >= MAX_REGIONS) {
        result.truncated = true;
        break;
      }
      // Symlinks in jeder Pfadkomponente ablehnen – safePath je Datei.
      const file = safePath(root, path.posix.join(relative, name));
      const region = await readRegion(file).catch(() => null);
      if (!region || region.count === 0) continue;
      result.regions.push({ x: Number(match[1]), z: Number(match[2]), bits: region.bits, count: region.count });
      result.chunks += region.count;
    }
    if (result.regions.length > 0) break; // erste vorhandene Variante gewinnt
  }
  return result;
}
