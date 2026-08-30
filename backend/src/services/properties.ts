import fs from 'node:fs/promises';
import path from 'node:path';
import { serverDir } from '../config.js';

export type FieldType = 'string' | 'boolean' | 'number' | 'select';

export interface PropertyField {
  key: string;
  label: string;
  type: FieldType;
  group: string;
  options?: string[];
  min?: number;
  max?: number;
  hint?: string;
}

/**
 * Kuratierte Felder für den Config-Tab. Alles was hier nicht steht,
 * bleibt in der Datei erhalten und ist über den "Erweitert"-Bereich erreichbar.
 */
export const PROPERTY_FIELDS: PropertyField[] = [
  { key: 'motd', label: 'MOTD (Serverbeschreibung)', type: 'string', group: 'Allgemein' },
  { key: 'max-players', label: 'Maximale Spieler', type: 'number', group: 'Allgemein', min: 1, max: 1000 },
  { key: 'gamemode', label: 'Spielmodus', type: 'select', group: 'Gameplay', options: ['survival', 'creative', 'adventure', 'spectator'] },
  { key: 'force-gamemode', label: 'Spielmodus erzwingen', type: 'boolean', group: 'Gameplay' },
  { key: 'difficulty', label: 'Schwierigkeit', type: 'select', group: 'Gameplay', options: ['peaceful', 'easy', 'normal', 'hard'] },
  { key: 'hardcore', label: 'Hardcore', type: 'boolean', group: 'Gameplay' },
  { key: 'pvp', label: 'PvP erlaubt', type: 'boolean', group: 'Gameplay' },
  { key: 'allow-flight', label: 'Fliegen erlauben', type: 'boolean', group: 'Gameplay', hint: 'Bei Mods mit Flug-Items nötig' },
  { key: 'allow-nether', label: 'Nether erlauben', type: 'boolean', group: 'Gameplay' },
  { key: 'spawn-monsters', label: 'Monster spawnen', type: 'boolean', group: 'Gameplay' },
  { key: 'spawn-animals', label: 'Tiere spawnen', type: 'boolean', group: 'Gameplay' },
  { key: 'spawn-npcs', label: 'Dorfbewohner spawnen', type: 'boolean', group: 'Gameplay' },
  { key: 'level-name', label: 'Weltname', type: 'string', group: 'Welt' },
  { key: 'level-seed', label: 'Seed', type: 'string', group: 'Welt' },
  { key: 'level-type', label: 'Weltart', type: 'string', group: 'Welt', hint: 'z. B. minecraft:normal, minecraft:flat' },
  { key: 'generate-structures', label: 'Strukturen generieren', type: 'boolean', group: 'Welt' },
  { key: 'max-world-size', label: 'Maximale Weltgröße', type: 'number', group: 'Welt' },
  { key: 'view-distance', label: 'Sichtweite (Chunks)', type: 'number', group: 'Performance', min: 3, max: 32 },
  { key: 'simulation-distance', label: 'Simulationsdistanz', type: 'number', group: 'Performance', min: 3, max: 32 },
  { key: 'max-tick-time', label: 'Max. Tick-Zeit (ms)', type: 'number', group: 'Performance', hint: '-1 deaktiviert den Watchdog' },
  { key: 'sync-chunk-writes', label: 'Chunks synchron schreiben', type: 'boolean', group: 'Performance' },
  { key: 'online-mode', label: 'Online-Modus (Mojang-Auth)', type: 'boolean', group: 'Sicherheit', hint: 'Ausschalten nur hinter einem Proxy!' },
  { key: 'white-list', label: 'Whitelist aktiv', type: 'boolean', group: 'Sicherheit' },
  { key: 'enforce-whitelist', label: 'Whitelist erzwingen', type: 'boolean', group: 'Sicherheit' },
  { key: 'enable-command-block', label: 'Befehlsblöcke', type: 'boolean', group: 'Sicherheit' },
  { key: 'op-permission-level', label: 'OP-Level', type: 'number', group: 'Sicherheit', min: 1, max: 4 },
  { key: 'player-idle-timeout', label: 'Idle-Timeout (Min.)', type: 'number', group: 'Sicherheit' },
  { key: 'enable-query', label: 'Query aktiv', type: 'boolean', group: 'Netzwerk' },
  { key: 'network-compression-threshold', label: 'Kompressionsschwelle', type: 'number', group: 'Netzwerk' },
  { key: 'resource-pack', label: 'Resourcepack-URL', type: 'string', group: 'Netzwerk' },
  { key: 'require-resource-pack', label: 'Resourcepack erzwingen', type: 'boolean', group: 'Netzwerk' },
];

/** Diese Schlüssel verwaltet das Panel selbst und blendet sie aus. */
const MANAGED_KEYS = new Set([
  'server-port',
  'rcon.port',
  'rcon.password',
  'enable-rcon',
  'query.port',
]);

const propsPath = (serverId: string) => path.join(serverDir(serverId), 'server.properties');

export function parseProperties(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return out;
}

/** Schreibt Änderungen zurück und behält Kommentare/Reihenfolge bei. */
export function mergeProperties(raw: string, changes: Record<string, string>): string {
  const lines = raw.split(/\r?\n/);
  const remaining = { ...changes };

  const merged = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq < 0) return line;
    const key = trimmed.slice(0, eq).trim();
    if (key in remaining) {
      const value = remaining[key];
      delete remaining[key];
      return `${key}=${value}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(remaining)) {
    merged.push(`${key}=${value}`);
  }

  return merged.join('\n').replace(/\n+$/, '\n');
}

export async function readProperties(serverId: string) {
  let raw = '';
  try {
    raw = await fs.readFile(propsPath(serverId), 'utf8');
  } catch {
    return { exists: false, values: {} as Record<string, string>, extra: {} as Record<string, string> };
  }
  const values = parseProperties(raw);
  const known = new Set(PROPERTY_FIELDS.map((f) => f.key));
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (!known.has(k) && !MANAGED_KEYS.has(k)) extra[k] = v;
  }
  return { exists: true, values, extra };
}

export async function saveProperties(serverId: string, changes: Record<string, string>) {
  const filtered = Object.fromEntries(
    Object.entries(changes).filter(([k]) => !MANAGED_KEYS.has(k)),
  );
  let raw = '';
  try {
    raw = await fs.readFile(propsPath(serverId), 'utf8');
  } catch {
    raw = '#Minecraft server properties\n';
  }
  await fs.writeFile(propsPath(serverId), mergeProperties(raw, filtered), 'utf8');
}

/** Liest eine JSON-Liste wie ops.json / whitelist.json / banned-players.json. */
export async function readJsonList<T = Record<string, unknown>>(
  serverId: string,
  file: string,
): Promise<T[]> {
  try {
    const raw = await fs.readFile(path.join(serverDir(serverId), file), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
