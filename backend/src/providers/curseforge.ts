import { fetchJson } from '../lib/download.js';
import { getCurseforgeKey } from '../services/settings.js';
import type {
  ProjectSummary,
  ProjectVersion,
  SearchQuery,
  SearchResponse,
} from './types.js';

const API = 'https://api.curseforge.com';
const GAME_ID = 432; // Minecraft
const CLASS_MODPACKS = 4471;
const CLASS_MODS = 6;

export class CurseforgeNotConfigured extends Error {
  constructor() {
    super('CurseForge ist nicht konfiguriert – bitte einen API-Key in den Panel-Einstellungen hinterlegen.');
  }
}

async function headers(): Promise<Record<string, string>> {
  const key = await getCurseforgeKey();
  if (!key) throw new CurseforgeNotConfigured();
  return { 'x-api-key': key, Accept: 'application/json' };
}

export async function isConfigured(): Promise<boolean> {
  return Boolean(await getCurseforgeKey());
}

const MOD_LOADER_IDS: Record<string, number> = {
  forge: 1,
  fabric: 4,
  quilt: 5,
  neoforge: 6,
};

export const MOD_LOADER_NAMES: Record<number, string> = {
  0: 'any',
  1: 'forge',
  2: 'cauldron',
  3: 'liteloader',
  4: 'fabric',
  5: 'quilt',
  6: 'neoforge',
};

const SORT_FIELDS: Record<string, number> = {
  relevance: 1,
  downloads: 6,
  updated: 3,
  newest: 11,
};

interface CfMod {
  id: number;
  name: string;
  slug: string;
  summary: string;
  downloadCount: number;
  logo?: { url: string } | null;
  authors: { name: string }[];
  categories: { name: string }[];
  links?: { websiteUrl?: string };
  dateModified: string;
  latestFilesIndexes?: { gameVersion: string }[];
  /** Die Suche liefert die neuesten Dateien gleich mit – inkl. Serverpaket-ID. */
  latestFiles?: { serverPackFileId?: number }[];
}

interface CfFile {
  id: number;
  modId: number;
  displayName: string;
  fileName: string;
  fileDate: string;
  fileLength: number;
  downloadUrl: string | null;
  gameVersions: string[];
  isServerPack?: boolean;
  serverPackFileId?: number;
}

export async function search(q: SearchQuery): Promise<SearchResponse> {
  const pageSize = q.pageSize ?? 20;

  // CurseForge kennt keinen Filter für Serverpakete – wir müssen nach dem
  // Abruf aussortieren. Deshalb großzügiger anfragen, damit die Seite voll wird.
  const filterServerPacks = Boolean(q.serverOnly) && q.type !== 'mod';
  const fetchSize = Math.min(50, filterServerPacks ? pageSize * 2 : pageSize);

  const params = new URLSearchParams({
    gameId: String(GAME_ID),
    classId: String(q.type === 'mod' ? CLASS_MODS : CLASS_MODPACKS),
    searchFilter: q.query ?? '',
    sortField: String(SORT_FIELDS[q.sort ?? 'relevance'] ?? 1),
    sortOrder: 'desc',
    index: String(((q.page ?? 1) - 1) * fetchSize),
    pageSize: String(fetchSize),
  });
  if (q.gameVersion) params.set('gameVersion', q.gameVersion);
  if (q.loader && MOD_LOADER_IDS[q.loader.toLowerCase()]) {
    params.set('modLoaderType', String(MOD_LOADER_IDS[q.loader.toLowerCase()]));
  }

  const data = await fetchJson<{ data: CfMod[]; pagination: { totalCount: number } }>(
    `${API}/v1/mods/search?${params}`,
    { headers: await headers() },
    'CurseForge',
  );

  let hits = data.data.map(toSummary);
  if (filterServerPacks) {
    hits = hits.filter((hit) => hit.hasServerPack).slice(0, pageSize);
  }

  return {
    total: data.pagination?.totalCount ?? data.data.length,
    hits,
  };
}

export async function getProject(modId: string): Promise<ProjectSummary> {
  const data = await fetchJson<{ data: CfMod }>(
    `${API}/v1/mods/${modId}`,
    { headers: await headers() },
    'CurseForge',
  );
  return toSummary(data.data);
}

export async function getVersions(modId: string, page = 1): Promise<ProjectVersion[]> {
  const params = new URLSearchParams({
    index: String((page - 1) * 50),
    pageSize: '50',
  });
  const data = await fetchJson<{ data: CfFile[] }>(
    `${API}/v1/mods/${modId}/files?${params}`,
    { headers: await headers() },
    'CurseForge',
  );
  return linkServerPacks(data.data.map(toVersion));
}

/**
 * CurseForge listet Serverpakete als ganz normale Dateien. Für die
 * Versionsauswahl sind sie aber kein eigener Stand, sondern gehören zu einer
 * Version. Deshalb blenden wir sie aus der Liste aus und hängen sie an die
 * passende Datei – auch dann, wenn der Autor sie nicht offiziell verknüpft hat.
 */
function linkServerPacks(versions: ProjectVersion[]): ProjectVersion[] {
  // Kandidaten: offiziell markiert oder am Namen erkennbar.
  const candidates = versions.filter((v) => v.isServerPack || looksLikeServerPack(v));
  if (candidates.length === 0) return versions;

  const mains = versions.filter((v) => !candidates.includes(v));

  const sameVersion = (a: ProjectVersion, b: ProjectVersion) => {
    const token = versionToken(a);
    return (
      token !== null &&
      token === versionToken(b) &&
      // Zusätzlich die Minecraft-Version abgleichen, damit nichts Fremdes passt.
      (a.gameVersions.length === 0 ||
        b.gameVersions.length === 0 ||
        b.gameVersions.some((g) => a.gameVersions.includes(g)))
    );
  };

  // Ein Kandidat gilt nur dann als Serverpaket, wenn es eine passende
  // Hauptdatei gibt – sonst ist es eine eigenständige Version und bleibt stehen.
  const packs = candidates.filter((pack) => mains.some((main) => sameVersion(main, pack)));

  return versions
    .filter((v) => !packs.includes(v))
    .map((version) => {
      if (version.serverPackFileId) return version;
      const match = packs.find((pack) => sameVersion(version, pack));
      return match ? { ...version, serverPackFileId: Number(match.id) } : version;
    });
}

/** Serverpakete heißen fast immer "ServerFiles…", "…-server.zip" o. Ä. */
function looksLikeServerPack(version: ProjectVersion): boolean {
  const text = `${version.name} ${version.filename}`.toLowerCase();
  return /server[\s_-]*(files|pack)/.test(text) || /[-_ ]server\.(zip|jar)$/.test(text);
}

/** Zieht die Versionskennung (z. B. "8.0") aus Anzeigename und Dateiname. */
function versionToken(version: ProjectVersion): string | null {
  const match = `${version.name} ${version.filename}`.match(/(\d+\.\d+(?:\.\d+)*)/);
  return match ? match[1] : null;
}

export type ServerPackRoute = 'linked' | 'matched';

/**
 * Sucht das zu einer Datei gehörende Serverpaket.
 * `linked` = vom Autor offiziell verknüpft, `matched` = über die
 * Versionskennung zugeordnet (wird beim Installieren protokolliert).
 */
export async function findServerPack(
  modId: string,
  version: ProjectVersion,
): Promise<{ pack: ProjectVersion; route: ServerPackRoute } | null> {
  if (version.serverPackFileId) {
    const pack = await getVersion(modId, String(version.serverPackFileId));
    return { pack, route: 'linked' };
  }

  // Nicht verknüpft: über die Dateiliste suchen. getVersions() hat die
  // Zuordnung bereits versucht, also dort nachsehen.
  const versions = await getVersions(modId);
  const enriched = versions.find((v) => v.id === version.id);
  if (enriched?.serverPackFileId) {
    const pack = await getVersion(modId, String(enriched.serverPackFileId));
    return { pack, route: 'matched' };
  }

  return null;
}

export async function getVersion(modId: string, fileId: string): Promise<ProjectVersion> {
  const data = await fetchJson<{ data: CfFile }>(
    `${API}/v1/mods/${modId}/files/${fileId}`,
    { headers: await headers() },
    'CurseForge',
  );
  return toVersion(data.data);
}

/**
 * Ermittelt eine funktionierende Download-URL.
 * Manche Autoren deaktivieren API-Downloads – dann liefert CurseForge null
 * und wir bauen die CDN-URL als Fallback selbst zusammen.
 */
export async function resolveDownloadUrl(
  modId: number | string,
  fileId: number | string,
  fileName?: string,
): Promise<string | null> {
  try {
    const data = await fetchJson<{ data: string | null }>(
      `${API}/v1/mods/${modId}/files/${fileId}/download-url`,
      { headers: await headers() },
      'CurseForge',
    );
    if (data.data) return data.data;
  } catch {
    /* Fallback unten */
  }
  if (!fileName) return null;
  const id = String(fileId);
  const a = id.slice(0, 4).replace(/^0+/, '') || '0';
  const b = String(Number(id.slice(4)));
  return `https://edge.forgecdn.net/files/${a}/${b}/${encodeURIComponent(fileName)}`;
}

/** Mehrere Mod-Metadaten in einem Rutsch (für Modpack-Manifeste). */
export async function getFilesBulk(fileIds: number[]): Promise<CfFile[]> {
  if (fileIds.length === 0) return [];
  const out: CfFile[] = [];
  for (let i = 0; i < fileIds.length; i += 200) {
    const chunk = fileIds.slice(i, i + 200);
    const res = await fetchJson<{ data: CfFile[] }>(
      `${API}/v1/mods/files`,
      {
        method: 'POST',
        headers: { ...(await headers()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds: chunk }),
      },
      'CurseForge',
    );
    out.push(...res.data);
  }
  return out;
}

function toSummary(m: CfMod): ProjectSummary {
  // Ein Serverpaket ist der beste Beleg dafür, dass das Pack serverseitig
  // gedacht ist. Fehlt es, heißt das nicht "läuft nicht" – nur "ungeprüft".
  const hasServerPack = (m.latestFiles ?? []).some((f) => Boolean(f.serverPackFileId));

  return {
    serverSupport: hasServerPack ? 'supported' : 'unknown',
    hasServerPack,
    provider: 'curseforge',
    id: String(m.id),
    slug: m.slug,
    name: m.name,
    summary: m.summary,
    iconUrl: m.logo?.url ?? null,
    downloads: m.downloadCount,
    author: m.authors?.[0]?.name ?? '',
    categories: (m.categories ?? []).map((c) => c.name),
    gameVersions: [...new Set((m.latestFilesIndexes ?? []).map((f) => f.gameVersion))],
    websiteUrl: m.links?.websiteUrl ?? null,
    updatedAt: m.dateModified,
  };
}

function toVersion(f: CfFile): ProjectVersion {
  const loaders = f.gameVersions
    .map((v) => v.toLowerCase())
    .filter((v) => ['forge', 'fabric', 'neoforge', 'quilt'].includes(v));
  const gameVersions = f.gameVersions.filter((v) => /^\d/.test(v));
  return {
    provider: 'curseforge',
    id: String(f.id),
    projectId: String(f.modId),
    name: f.displayName,
    versionNumber: f.displayName,
    gameVersions,
    loaders,
    datePublished: f.fileDate,
    downloadUrl: f.downloadUrl,
    filename: f.fileName,
    fileSize: f.fileLength,
    downloadBlocked: !f.downloadUrl,
    serverPackFileId: f.serverPackFileId ?? null,
    isServerPack: f.isServerPack ?? false,
  };
}
