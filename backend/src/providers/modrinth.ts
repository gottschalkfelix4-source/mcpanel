import { fetchJson } from '../lib/download.js';
import type {
  ProjectSummary,
  ProjectVersion,
  SearchQuery,
  SearchResponse,
} from './types.js';

const API = 'https://api.modrinth.com/v2';
const UA = 'mcpanel/1.0 (self-hosted minecraft panel)';

const headers = () => ({ 'User-Agent': UA, Accept: 'application/json' });

interface MrHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string | null;
  downloads: number;
  author: string;
  categories: string[];
  versions: string[];
  date_modified: string;
  /** "required" | "optional" | "unsupported" | "unknown" */
  server_side?: string;
}

interface MrFile {
  url: string;
  filename: string;
  primary: boolean;
  size: number;
}

interface MrVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  date_published: string;
  files: MrFile[];
}

const SORT_MAP: Record<string, string> = {
  relevance: 'relevance',
  downloads: 'downloads',
  updated: 'updated',
  newest: 'newest',
};

const PROJECT_TYPES = new Set(['mod', 'plugin', 'modpack']);
const projectType = (type?: string) => (type && PROJECT_TYPES.has(type) ? type : 'modpack');

export async function search(q: SearchQuery): Promise<SearchResponse> {
  const type = projectType(q.type);
  const facets: string[][] = [[`project_type:${type}`]];
  if (q.gameVersion) facets.push([`versions:${q.gameVersion}`]);
  if (q.loader) facets.push([`categories:${q.loader.toLowerCase()}`]);
  // Ein Plugin laeuft ausschliesslich serverseitig; die Facette wuerde hier
  // nur Projekte aussieben, die ihre Seite gar nicht erst angeben.
  // Sonst filtert Modrinth selbst - die Facette wirkt als ODER in der Gruppe.
  if (q.serverOnly && type !== 'plugin') facets.push(['server_side:required', 'server_side:optional']);

  const pageSize = q.pageSize ?? 20;
  const params = new URLSearchParams({
    query: q.query ?? '',
    facets: JSON.stringify(facets),
    limit: String(pageSize),
    offset: String(((q.page ?? 1) - 1) * pageSize),
    index: SORT_MAP[q.sort ?? 'relevance'] ?? 'relevance',
  });

  const data = await fetchJson<{ hits: MrHit[]; total_hits: number }>(
    `${API}/search?${params}`,
    { headers: headers() },
    'Modrinth',
  );

  return {
    total: data.total_hits,
    hits: data.hits.map(
      (h): ProjectSummary => ({
        provider: 'modrinth',
        id: h.project_id,
        slug: h.slug,
        name: h.title,
        summary: h.description,
        iconUrl: h.icon_url,
        downloads: h.downloads,
        author: h.author,
        categories: h.categories,
        gameVersions: h.versions,
        websiteUrl: `https://modrinth.com/${type}/${h.slug}`,
        updatedAt: h.date_modified,
        serverSupport: toServerSupport(h.server_side),
      }),
    ),
  };
}

function toServerSupport(serverSide: string | undefined) {
  if (serverSide === 'required' || serverSide === 'optional') return 'supported' as const;
  if (serverSide === 'unsupported') return 'unsupported' as const;
  return 'unknown' as const;
}

export async function getProject(id: string): Promise<ProjectSummary> {
  const p = await fetchJson<{
    id: string;
    slug: string;
    title: string;
    description: string;
    icon_url: string | null;
    downloads: number;
    categories: string[];
    game_versions: string[];
    updated: string;
    project_type: string;
    server_side?: string;
  }>(`${API}/project/${id}`, { headers: headers() }, 'Modrinth');

  return {
    provider: 'modrinth',
    id: p.id,
    slug: p.slug,
    name: p.title,
    summary: p.description,
    iconUrl: p.icon_url,
    downloads: p.downloads,
    author: '',
    categories: p.categories,
    gameVersions: p.game_versions,
    websiteUrl: `https://modrinth.com/${p.project_type}/${p.slug}`,
    updatedAt: p.updated,
    serverSupport: toServerSupport(p.server_side),
  };
}

export async function getVersions(projectId: string): Promise<ProjectVersion[]> {
  const versions = await fetchJson<MrVersion[]>(
    `${API}/project/${projectId}/version`,
    { headers: headers() },
    'Modrinth',
  );
  return versions.map(toVersion);
}

export async function getVersion(versionId: string): Promise<ProjectVersion> {
  const v = await fetchJson<MrVersion>(
    `${API}/version/${versionId}`,
    { headers: headers() },
    'Modrinth',
  );
  return toVersion(v);
}

function toVersion(v: MrVersion): ProjectVersion {
  const file = v.files.find((f) => f.primary) ?? v.files[0];
  return {
    provider: 'modrinth',
    id: v.id,
    projectId: v.project_id,
    name: v.name,
    versionNumber: v.version_number,
    gameVersions: v.game_versions,
    loaders: v.loaders,
    datePublished: v.date_published,
    downloadUrl: file?.url ?? null,
    filename: file?.filename ?? `${v.version_number}.mrpack`,
    fileSize: file?.size ?? 0,
  };
}

export const modrinthHeaders = headers;
