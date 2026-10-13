import { z } from 'zod';
import { fetchJson } from '../lib/download.js';
import { badRequest } from '../lib/errors.js';
import type { ProjectSummary, ProjectVersion } from './types.js';

const API = 'https://api.feed-the-beast.com/v1/modpacks/public';
const id = z.number().int().positive();
const target = z.object({ name: z.string(), version: z.string().min(1), type: z.string() });
const release = z.object({ id, name: z.string().min(1), private: z.boolean(), targets: z.array(target) });
const projectSchema = z.object({
  status: z.literal('success'), id, name: z.string(),
  meta: z.object({ curseforgeProjectId: id.optional() }).passthrough(),
  versions: z.array(release),
});
const httpsUrl = z.string().url().refine(value => new URL(value).protocol === 'https:');
const fileSchema = z.object({
  path: z.string(), name: z.string().min(1), url: httpsUrl,
  size: z.number().int().nonnegative(), sha1: z.string().regex(/^[a-f\d]{40}$/i),
  clientonly: z.boolean(), serveronly: z.boolean(),
});
const versionSchema = release.extend({
  status: z.literal('success'), parent: id, files: z.array(fileSchema).min(1),
});

async function read<T extends z.ZodTypeAny>(endpoint: string, schema: T): Promise<z.infer<T>> {
  try {
    const result = schema.safeParse(await fetchJson(`${API}/${endpoint}`, { signal: AbortSignal.timeout(30_000) }, 'FTB'));
    if (!result.success) throw badRequest('FTB liefert unvollständige oder ungültige Serverpaket-Metadaten.');
    return result.data;
  } catch (error) {
    throw badRequest(`FTB-Serverpaket konnte nicht geprüft werden: ${error instanceof Error ? error.message : 'Abruf fehlgeschlagen'}`);
  }
}

const normalized = (value: string) => value.toLowerCase().replace(/[^a-z\d]+/g, ' ').trim();

/** Nur vollständige Versionsbezeichnungen vergleichen, niemals die erste Zahl im Packnamen. */
function matchesVersion(project: ProjectSummary, version: ProjectVersion, name: string): boolean {
  const names = [project.name, project.slug].map(normalized);
  return [version.name, version.filename.replace(/\.zip$/i, '')].some(value => {
    const full = normalized(value);
    return full === normalized(name) || names.some(prefix => full === `${prefix} ${normalized(name)}`);
  });
}

export interface FtbServerPack {
  projectId: number;
  versionId: number;
  name: string;
  version: string;
  minecraftVersion: string;
  loader: 'FORGE' | 'NEOFORGE' | 'FABRIC' | 'QUILT' | 'VANILLA';
  loaderVersion: string | null;
  downloads: { path: string; urls: string[]; size: number; sha1: string }[];
  excludedClientFiles: number;
}

/** FTB bestätigt die CurseForge-Projekt-ID selbst; gleiche Namen allein reichen nicht. */
export async function findServerPack(project: ProjectSummary, version: ProjectVersion): Promise<FtbServerPack | null> {
  const search = await read(`modpack/search/50?term=${encodeURIComponent(project.name)}`,
    z.object({ status: z.literal('success'), packs: z.array(id) }));
  const matches: z.infer<typeof projectSchema>[] = [];
  for (const packId of [...new Set(search.packs)]) {
    const pack = await read(`modpack/${packId}`, projectSchema);
    if (pack.id === packId && String(pack.meta.curseforgeProjectId) === project.id) matches.push(pack);
  }
  if (!matches.length) return null;
  if (matches.length !== 1) throw badRequest('Die CurseForge-Auswahl ist mehreren FTB-Projekten zugeordnet. Installation abgebrochen.');
  const pack = matches[0];
  const releases = pack.versions.filter(v => !v.private && matchesVersion(project, version, v.name));
  if (releases.length !== 1) throw badRequest('Für die ausgewählte Version wurde kein eindeutig passendes FTB-Serverpaket gefunden. Es wird keine andere Version installiert.');
  const manifest = await read(`modpack/${pack.id}/${releases[0].id}`, versionSchema);
  if (manifest.parent !== pack.id || manifest.id !== releases[0].id || manifest.private || manifest.name !== releases[0].name) {
    throw badRequest('Das FTB-Serverpaket gehört nicht zur ausgewählten Projektversion.');
  }
  const games = manifest.targets.filter(t => t.type === 'game' && t.name === 'minecraft');
  const loaders = manifest.targets.filter(t => t.type === 'modloader');
  if (games.length !== 1 || !version.gameVersions.includes(games[0].version) || loaders.length > 1) {
    throw badRequest('Minecraft-Version oder Loader des FTB-Serverpakets passen nicht zur Auswahl.');
  }
  const loader = loaders[0]?.name.toUpperCase() ?? 'VANILLA';
  if (!['FORGE', 'NEOFORGE', 'FABRIC', 'QUILT', 'VANILLA'].includes(loader)
    || (version.loaders.length > 0 && !version.loaders.some(l => l.toUpperCase() === loader))) {
    throw badRequest('Der Loader des FTB-Serverpakets passt nicht zur Auswahl oder wird nicht unterstützt.');
  }
  const seen = new Set<string>();
  const downloads = manifest.files.filter(file => !file.clientonly).map(file => {
    // FTB nutzt ./ als Wurzel. Alle übrigen relativen/absoluten Ausbrüche ablehnen.
    const directory = file.path.replace(/^\.\//, '').replace(/\/$/, '');
    const relative = directory === '.' || !directory ? file.name : `${directory}/${file.name}`;
    if (/[\\/:]/.test(file.name) || relative.startsWith('/') || relative.includes('\\') || relative.includes(':')
      || relative.split('/').some(part => !part || part === '.' || part === '..') || seen.has(relative.toLowerCase())) {
      throw badRequest('Das FTB-Serverpaket enthält ungültige oder doppelte Dateipfade.');
    }
    seen.add(relative.toLowerCase());
    return { path: relative, urls: [file.url], size: file.size, sha1: file.sha1.toLowerCase() };
  });
  if (!downloads.length) throw badRequest('Das FTB-Serverpaket enthält keine Serverdateien.');
  return { projectId: pack.id, versionId: manifest.id, name: pack.name, version: manifest.name,
    minecraftVersion: games[0].version, loader: loader as FtbServerPack['loader'],
    loaderVersion: loaders[0]?.version ?? null, downloads,
    excludedClientFiles: manifest.files.length - downloads.length };
}
