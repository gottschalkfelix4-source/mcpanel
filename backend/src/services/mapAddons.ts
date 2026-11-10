/**
 * Erweiterungen für Karte und Vorgenerierung: Chunky (Vorgenerierung) und
 * BlueMap (Gelände-Karte). Beide sind reine Server-Mods bzw. -Plugins, Spieler
 * brauchen nichts. Das Panel sucht auf Modrinth die zur Kombination aus
 * Loader und Minecraft-Version passende Datei und legt sie in `mods/` bzw.
 * `plugins/`.
 *
 * Unterstützt (Stand der Modrinth-Daten): Chunky auf Forge ab 1.16.5,
 * NeoForge ab 1.20.2, Fabric ab 1.16 und Paper/Spigot; BlueMap auf Forge ab
 * 1.14.4, NeoForge ab 1.20.2, Fabric ab 1.15.2 und Paper/Spigot. Ob es eine
 * Datei gibt, entscheidet allein die Modrinth-Abfrage – keine fest
 * eingebaute Versionsliste, die veraltet.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from '@prisma/client';
import { serverDir } from '../config.js';
import { downloadToFile } from '../lib/download.js';
import { badRequest } from '../lib/errors.js';
import { safePath } from '../lib/safePath.js';
import * as modrinth from '../providers/modrinth.js';
import type { ProjectVersion } from '../providers/types.js';
import { contentDir, contentKindFor, serverLoader } from './content.js';
import { remainingDiskBytes } from './quota.js';

export type AddonKey = 'chunky' | 'bluemap';

export const ADDONS: Record<AddonKey, { label: string; project: string; jar: RegExp }> = {
  chunky: { label: 'Chunky', project: 'chunky', jar: /^chunky[-_].*\.jar$/i },
  bluemap: { label: 'BlueMap', project: 'bluemap', jar: /^bluemap[-_].*\.jar$/i },
};

/** Modrinth-Loader, unter denen eine passende Datei liegen darf. `null` = Vanilla. */
export function modrinthLoaders(server: Pick<Server, 'type' | 'extraEnv'>): string[] | null {
  const kind = contentKindFor(server.type);
  if (!kind) return null;
  if (kind === 'plugin') return ['paper', 'purpur', 'spigot', 'bukkit'];
  const loader = serverLoader(server).toLowerCase();
  if (loader === 'quilt') return ['quilt', 'fabric'];
  return [loader];
}

/** Neueste Datei für Loader und Version – `null`, wenn es keine gibt. */
export function pickVersion(versions: ProjectVersion[], loaders: string[], mcVersion: string): ProjectVersion | null {
  const fits = versions.filter((version) =>
    version.downloadUrl
    && version.loaders.some((loader) => loaders.includes(loader))
    && (mcVersion.toUpperCase() === 'LATEST' || version.gameVersions.includes(mcVersion)));
  fits.sort((a, b) => Date.parse(b.datePublished) - Date.parse(a.datePublished));
  return fits[0] ?? null;
}

const versionCache = new Map<string, { at: number; value: Promise<ProjectVersion[]> }>();

function projectVersions(project: string): Promise<ProjectVersion[]> {
  const hit = versionCache.get(project);
  if (hit && Date.now() - hit.at < 3600_000) return hit.value;
  const value = modrinth.getVersions(project);
  versionCache.set(project, { at: Date.now(), value });
  value.catch(() => versionCache.delete(project));
  return value;
}

export interface AddonState {
  installed: boolean;
  /** Dateiname im Mods-/Plugin-Ordner */
  file: string | null;
  /** Passende Datei auf Modrinth, `null` = für diesen Server nicht verfügbar */
  available: { version: string; filename: string } | null;
  /** Modrinth nicht erreichbar */
  lookupFailed?: boolean;
}

export async function installedAddon(server: Server, key: AddonKey): Promise<string | null> {
  const dir = contentDir(server);
  if (!dir) return null;
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.find((name) => ADDONS[key].jar.test(name)) ?? null;
}

export async function addonState(server: Server, key: AddonKey): Promise<AddonState> {
  const file = await installedAddon(server, key);
  const loaders = modrinthLoaders(server);
  if (!loaders) return { installed: false, file: null, available: null };
  try {
    const version = pickVersion(await projectVersions(ADDONS[key].project), loaders, server.mcVersion);
    return { installed: Boolean(file), file, available: version ? { version: version.versionNumber, filename: version.filename } : null };
  } catch {
    return { installed: Boolean(file), file, available: null, lookupFailed: true };
  }
}

/** Passende Datei herunterladen. Eine schon vorhandene Fassung bleibt unangetastet. */
export async function installAddon(server: Server, key: AddonKey): Promise<string> {
  const existing = await installedAddon(server, key);
  if (existing) return existing;
  const loaders = modrinthLoaders(server);
  if (!loaders) throw badRequest('Ein Vanilla-Server lädt keine Mods. Stelle den Servertyp um (z. B. auf Fabric oder Paper).');
  const version = pickVersion(await projectVersions(ADDONS[key].project), loaders, server.mcVersion);
  if (!version?.downloadUrl) {
    throw badRequest(`${ADDONS[key].label} gibt es nicht für ${serverLoader(server)} ${server.mcVersion}.`);
  }
  const dir = contentDir(server)!;
  await fs.mkdir(dir, { recursive: true });
  const filename = path.basename(version.filename);
  if (!ADDONS[key].jar.test(filename)) throw badRequest(`Unerwarteter Dateiname von Modrinth: ${filename}`);
  await downloadToFile(version.downloadUrl, safePath(dir, filename), {
    maxBytes: await remainingDiskBytes(server),
    headers: modrinth.modrinthHeaders(),
  });
  return filename;
}

// ---------------------------------------------------------------------------
// BlueMap: Zustimmung zum Download der Mojang-Ressourcen
// ---------------------------------------------------------------------------

const BLUEMAP_CORE = ['config/bluemap/core.conf', 'plugins/BlueMap/core.conf'];

/**
 * `accept-download: true` in BlueMaps core.conf setzen. BlueMap legt die
 * Datei beim ersten Start selbst an – vorher gibt es nichts zu ändern
 * (`'missing'`), danach wird nur diese eine Zeile umgeschrieben.
 */
export async function acceptBlueMapDownload(server: Pick<Server, 'id'>): Promise<'changed' | 'already' | 'missing'> {
  const root = serverDir(server.id);
  for (const relative of BLUEMAP_CORE) {
    let text: string;
    try {
      text = await fs.readFile(safePath(root, relative), 'utf8');
    } catch {
      continue;
    }
    if (/^\s*accept-download\s*[:=]\s*true\b/m.test(text)) return 'already';
    if (!/^\s*accept-download\s*[:=]\s*false\b/m.test(text)) return 'already';
    const next = text.replace(/^(\s*accept-download\s*[:=]\s*)false\b/m, '$1true');
    const tmp = safePath(root, `${relative}.mcpanel-${Date.now()}.tmp`);
    await fs.writeFile(tmp, next, 'utf8');
    try {
      await fs.rename(tmp, safePath(root, relative));
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    return 'changed';
  }
  return 'missing';
}
