/**
 * Wo stehen die Spieler gerade?
 *
 * Über RCON mit dem Vanilla-Befehl `data get entity <Name> Pos` bzw.
 * `… Dimension` – funktioniert ab 1.13 auf jedem Loader, ohne Karten-Mod.
 * Mehrere offene Karten teilen sich eine kurz zwischengespeicherte Abfrage.
 */
import type { Server } from '@prisma/client';
import { listPlayers, rconCommand } from './rcon.js';

export interface PlayerPosition {
  name: string;
  x: number;
  y: number;
  z: number;
  /** z. B. "minecraft:overworld", `null` wenn unbekannt */
  dimension: string | null;
}

export interface PositionsResult {
  online: number;
  players: PlayerPosition[];
  /** Positionen nicht lesbar (z. B. vor 1.13 ohne `data`-Befehl) */
  unsupported: boolean;
}

const CACHE_MS = 1500;
const MAX_PLAYERS = 40;
/** Java-Namen, dazu Bedrock-Spieler über Geyser/Floodgate mit Präfix */
const NAME = /^[.*]?[A-Za-z0-9_]{1,32}$/;

const LEGACY_DIMENSIONS: Record<string, string> = {
  '0': 'minecraft:overworld',
  '-1': 'minecraft:the_nether',
  '1': 'minecraft:the_end',
};

/** „Felix has the following entity data: [312.5d, 64.0d, -148.3d]“ */
export function parsePosition(raw: string): { x: number; y: number; z: number } | null {
  const clean = raw.replace(/§./g, '');
  const match = /\[\s*(-?[\d.]+(?:E-?\d+)?)[dDfF]?\s*,\s*(-?[\d.]+(?:E-?\d+)?)[dDfF]?\s*,\s*(-?[\d.]+(?:E-?\d+)?)[dDfF]?\s*\]/.exec(clean);
  if (!match) return null;
  const [x, y, z] = [match[1], match[2], match[3]].map(Number);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

/** „… entity data: "minecraft:the_nether"“, vor 1.16 eine Zahl (0, -1, 1). */
export function parseDimension(raw: string): string | null {
  const clean = raw.replace(/§./g, '');
  const named = /"([a-z0-9_.-]+:[a-z0-9_/.-]+)"/.exec(clean);
  if (named) return named[1];
  const legacy = /entity data:\s*(-?\d+)\s*$/.exec(clean.trim());
  return legacy ? LEGACY_DIMENSIONS[legacy[1]] ?? null : null;
}

const cache = new Map<string, { at: number; value: Promise<PositionsResult> }>();

export function getPlayerPositions(server: Server): Promise<PositionsResult> {
  const hit = cache.get(server.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = readPositions(server);
  cache.set(server.id, { at: Date.now(), value });
  value.catch(() => cache.delete(server.id));
  return value;
}

async function readPositions(server: Server): Promise<PositionsResult> {
  const list = await listPlayers(server);
  const result: PositionsResult = { online: list.online, players: [], unsupported: false };
  for (const name of list.players.slice(0, MAX_PLAYERS)) {
    if (!NAME.test(name)) continue;
    const position = parsePosition(await rconCommand(server, `data get entity ${name} Pos`).catch(() => ''));
    if (!position) {
      // Kein `data`-Befehl (zu alt) oder Spieler gerade weg – nicht weiter fragen.
      if (result.players.length === 0) result.unsupported = true;
      continue;
    }
    result.unsupported = false;
    const dimension = parseDimension(await rconCommand(server, `data get entity ${name} Dimension`).catch(() => ''));
    result.players.push({ name, ...position, dimension });
  }
  return result;
}
