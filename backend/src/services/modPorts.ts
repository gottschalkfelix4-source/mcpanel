/**
 * Erweiterungen, die einen eigenen Port brauchen.
 *
 * Simple Voice Chat, Geyser, Web-Karten und Votifier lauschen neben dem
 * Spielport auf einem zusätzlichen Port. Ohne Freigabe im Container und im
 * Router funktionieren sie nicht – bisher musste man das von Hand erledigen.
 *
 * Erkannt wird am Jar in `mods/` bzw. `plugins/`, der tatsächlich genutzte
 * Port steht in der Konfiguration der Erweiterung (fehlt sie noch, weil der
 * Server nie lief, gilt der Standardport).
 *
 * `samePort`: Die Erweiterung teilt den Spielern ihren Port selbst mit (Simple
 * Voice Chat schickt ihn beim Verbinden). Host- und Containerport müssen dann
 * übereinstimmen – belegt schon ein anderer Server den Port, schreibt das
 * Panel einen freien in die Konfiguration. Bei allen anderen genügt es, einen
 * freien Hostport auf den Containerport zu legen.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { safePath } from '../lib/safePath.js';
import type { PortProtocol } from '../lib/serverPorts.js';

export interface ModPortSpec {
  key: string;
  label: string;
  protocol: PortProtocol;
  defaultPort: number;
  samePort: boolean;
  /**
   * Nur über das Panel erreichbar (BlueMap: die Karte läuft im Reiter „Karte“
   * hinter der Panel-Anmeldung). Auf dem Hauptserver wird der Port dann gar
   * nicht veröffentlicht, auf Nodes nur ohne Router-Freigabe – dort erreicht
   * das Panel den Container nicht über das Minecraft-Netz.
   */
  internal?: boolean;
  /** Dateiname des Jars in mods/ oder plugins/ */
  jar: RegExp;
  /** Mögliche Konfigurationsdateien relativ zum Serverordner */
  configs: (root: string) => Promise<string[]>;
  /**
   * Port aus der Konfiguration. `null` = nicht gesetzt (Standard gilt),
   * `'game'` = die Erweiterung nutzt den Spielport mit.
   */
  read: (text: string) => number | 'game' | null;
  /** Nur für `samePort`: Port in der Konfiguration setzen. */
  write?: (text: string, port: number) => string;
}

export interface DetectedModPort {
  spec: ModPortSpec;
  /** Port im Container laut Konfiguration bzw. Standard */
  containerPort: number;
  /** Gefundene Konfigurationsdatei (relativ), `null` = noch keine */
  configPath: string | null;
}

const fixed = (...paths: string[]) => async () => paths;

/** Konfigurationsdateien in Unterordnern, deren Name einem Muster folgt (Geyser-Spigot, Geyser-Fabric …). */
function inMatchingDirs(parents: string[], dir: RegExp, file: string) {
  return async (root: string) => {
    const found: string[] = [];
    for (const parent of parents) {
      let names: string[] = [];
      try { names = await fs.readdir(safePath(root, parent)); } catch { continue; }
      for (const name of names.sort()) if (dir.test(name)) found.push(path.posix.join(parent, name, file));
    }
    return found;
  };
}

const PORT_RANGE = (value: number) => Number.isInteger(value) && value >= 1 && value <= 65535;

/** `schluessel: 123` innerhalb eines YAML-Blocks (`block:` auf oberster Ebene). */
function yamlBlockPort(text: string, block: string): number | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${block}\\s*:\\s*(#.*)?$`).test(line));
  if (start < 0) return null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // nächster Block auf oberster Ebene
    const match = /^\s+port\s*:\s*(\d+)\s*(#.*)?$/.exec(line);
    if (match) {
      const port = Number(match[1]);
      return PORT_RANGE(port) ? port : null;
    }
  }
  return null;
}

function matchPort(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  if (!match) return null;
  const port = Number(match[1]);
  return PORT_RANGE(port) ? port : null;
}

export const MOD_PORTS: ModPortSpec[] = [
  {
    key: 'voicechat',
    label: 'Simple Voice Chat',
    protocol: 'udp',
    defaultPort: 24454,
    samePort: true,
    jar: /^voicechat[-_].*\.jar$/i,
    configs: fixed('config/voicechat/voicechat-server.properties', 'plugins/voicechat/voicechat-server.properties'),
    // [ \t] statt \s: \s frisst Zeilenumbrüche, mit dem m-Schalter wird das bei
    // einer Datei voller Leerzeilen quadratisch und blockiert das ganze Panel.
    read: (text) => {
      const match = /^[ \t]*port[ \t]*=[ \t]*(-?\d+)[ \t]*\r?$/m.exec(text);
      if (!match) return null;
      const port = Number(match[1]);
      // -1 = Spielport mitbenutzen (der ist per UDP ohnehin freigegeben)
      if (port === -1) return 'game';
      return PORT_RANGE(port) ? port : null;
    },
    write: (text, port) => /^[ \t]*port[ \t]*=.*$/m.test(text)
      ? text.replace(/^[ \t]*port[ \t]*=.*$/m, `port=${port}`)
      : `${text}${text && !text.endsWith('\n') ? '\n' : ''}port=${port}\n`,
  },
  {
    key: 'geyser',
    label: 'Geyser (Bedrock)',
    protocol: 'udp',
    defaultPort: 19132,
    samePort: false,
    jar: /^geyser[-_].*\.jar$/i,
    configs: inMatchingDirs(['plugins', 'config'], /^geyser/i, 'config.yml'),
    read: (text) => yamlBlockPort(text, 'bedrock'),
  },
  {
    key: 'bluemap',
    label: 'BlueMap',
    protocol: 'tcp',
    defaultPort: 8100,
    samePort: false,
    internal: true,
    jar: /^bluemap[-_].*\.jar$/i,
    configs: fixed('config/bluemap/webserver.conf', 'plugins/BlueMap/webserver.conf'),
    read: (text) => matchPort(text, /^[ \t]*port[ \t]*[:=][ \t]*(\d+)/m),
  },
  {
    key: 'dynmap',
    label: 'Dynmap',
    protocol: 'tcp',
    defaultPort: 8123,
    samePort: false,
    jar: /^dynmap[-_].*\.jar$/i,
    configs: fixed('plugins/dynmap/configuration.txt', 'dynmap/configuration.txt'),
    read: (text) => matchPort(text, /^webserver-port\s*:\s*(\d+)/m),
  },
  {
    key: 'squaremap',
    label: 'squaremap',
    protocol: 'tcp',
    defaultPort: 8080,
    samePort: false,
    jar: /^squaremap[-_].*\.jar$/i,
    configs: fixed('plugins/squaremap/config.yml', 'config/squaremap/config.yml', 'squaremap/config.yml'),
    read: (text) => yamlBlockPort(text, 'internal-webserver') ?? yamlBlockPort(text, 'settings'),
  },
  {
    key: 'votifier',
    label: 'Votifier',
    protocol: 'tcp',
    defaultPort: 8192,
    samePort: false,
    jar: /^(nu)?votifier.*\.jar$/i,
    configs: fixed('plugins/NuVotifier/config.yml', 'plugins/Votifier/config.yml'),
    read: (text) => matchPort(text, /^port\s*:\s*(\d+)/m),
  },
];

async function listJars(root: string): Promise<string[]> {
  const names: string[] = [];
  for (const dir of ['mods', 'plugins']) {
    try {
      // Deaktivierte Mods (.jar.disabled) zählen nicht.
      names.push(...(await fs.readdir(safePath(root, dir))).filter((name) => /\.jar$/i.test(name)));
    } catch {
      // Ordner fehlt – kein Mod-/Plugin-Server
    }
  }
  return names;
}

async function readText(root: string, relative: string): Promise<string | null> {
  try {
    const file = safePath(root, relative);
    const info = await fs.lstat(file);
    if (!info.isFile() || info.size > 1024 * 1024) return null;
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Welche Erweiterungen mit eigenem Port liegen im Serverordner? */
export async function detectModPorts(root: string): Promise<DetectedModPort[]> {
  const jars = await listJars(root);
  const found: DetectedModPort[] = [];
  for (const spec of MOD_PORTS) {
    if (!jars.some((name) => spec.jar.test(name))) continue;
    let containerPort: number | 'game' = spec.defaultPort;
    let configPath: string | null = null;
    for (const candidate of await spec.configs(root)) {
      const text = await readText(root, candidate);
      if (text === null) continue;
      configPath = candidate;
      containerPort = spec.read(text) ?? spec.defaultPort;
      break;
    }
    if (containerPort === 'game') continue;
    found.push({ spec, containerPort, configPath });
  }
  return found;
}

/**
 * Port in die Konfiguration schreiben (nur `samePort`-Erweiterungen). Fehlt
 * die Datei, wird sie mit nur diesem Eintrag angelegt – Simple Voice Chat
 * ergänzt die übrigen Werte beim ersten Start selbst.
 */
export async function writeModPort(root: string, detected: DetectedModPort, port: number): Promise<string> {
  const { spec } = detected;
  if (!spec.write) throw new Error(`${spec.label}: Port lässt sich nicht setzen`);
  const relative = detected.configPath ?? (await spec.configs(root))[await preferredConfigIndex(root, spec)];
  const current = (await readText(root, relative)) ?? '';
  const next = spec.write(current, port);
  // Ordner anlegen und unmittelbar vor dem Schreiben erneut prüfen (TOCTOU).
  await fs.mkdir(safePath(root, path.posix.dirname(relative)), { recursive: true });
  const tmp = safePath(root, `${relative}.mcpanel-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(tmp, next, 'utf8');
  try {
    await fs.rename(tmp, safePath(root, relative));
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  return relative;
}

/** Plugin-Server (plugins/ vorhanden, kein mods/) bekommen die Plugin-Konfiguration. */
async function preferredConfigIndex(root: string, spec: ModPortSpec): Promise<number> {
  const configs = await spec.configs(root);
  const hasMods = await fs.stat(safePath(root, 'mods')).then(() => true, () => false);
  const index = configs.findIndex((candidate) => candidate.startsWith(hasMods ? 'config/' : 'plugins/'));
  return index >= 0 ? index : 0;
}
