import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/context.js';
import { fetchJson } from '../lib/download.js';
import * as modrinth from '../providers/modrinth.js';
import * as curseforge from '../providers/curseforge.js';
import type { ProjectSummary, SearchQuery } from '../providers/types.js';

/** Notfall-Liste, falls die Modrinth-API nicht erreichbar ist. */
const FALLBACK_VERSIONS = [
  '1.21.4', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.1',
  '1.19.2', '1.18.2', '1.16.5', '1.12.2', '1.7.10',
];

const searchSchema = z.object({
  provider: z.enum(['modrinth', 'curseforge', 'all']).default('all'),
  q: z.string().optional(),
  type: z.enum(['modpack', 'mod']).default('modpack'),
  gameVersion: z.string().optional(),
  loader: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  sort: z.enum(['relevance', 'downloads', 'updated', 'newest']).default('relevance'),
  // Standardmäßig nur servertaugliche Projekte zeigen.
  serverOnly: z.enum(['true', 'false']).default('true'),
});

export default async function catalogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/providers', async () => {
    return {
      modrinth: { available: true, label: 'Modrinth' },
      curseforge: { available: await curseforge.isConfigured(), label: 'CurseForge' },
    };
  });

  /** Liste der Minecraft-Versionen (für Filter und Server-Anlage). */
  app.get('/game-versions', async () => {
    try {
      const tags = await fetchJson<{ version: string; version_type: string }[]>(
        'https://api.modrinth.com/v2/tag/game_version',
        { headers: modrinth.modrinthHeaders() },
        'Modrinth',
      );
      return {
        release: tags.filter((t) => t.version_type === 'release').map((t) => t.version),
        all: tags.map((t) => t.version),
      };
    } catch {
      return { release: FALLBACK_VERSIONS, all: FALLBACK_VERSIONS };
    }
  });

  app.get('/search', async (req) => {
    const params = searchSchema.parse(req.query);
    const query: SearchQuery = {
      query: params.q,
      type: params.type,
      gameVersion: params.gameVersion,
      loader: params.loader,
      page: params.page,
      pageSize: params.pageSize,
      sort: params.sort,
      serverOnly: params.serverOnly === 'true',
    };

    const wanted =
      params.provider === 'all' ? (['modrinth', 'curseforge'] as const) : ([params.provider] as const);

    const results = await Promise.all(
      wanted.map(async (provider) => {
        try {
          if (provider === 'curseforge' && !(await curseforge.isConfigured())) {
            return { provider, hits: [] as ProjectSummary[], total: 0, error: 'Kein API-Key hinterlegt' };
          }
          const api = provider === 'modrinth' ? modrinth : curseforge;
          const res = await api.search(
            params.provider === 'all'
              ? { ...query, pageSize: Math.ceil(params.pageSize / 2) }
              : query,
          );
          return { provider, ...res, error: null as string | null };
        } catch (err) {
          return {
            provider,
            hits: [] as ProjectSummary[],
            total: 0,
            error: err instanceof Error ? err.message : 'Fehler',
          };
        }
      }),
    );

    // Bei "all" die Ergebnisse verschränken, damit beide Quellen sichtbar sind
    const merged: ProjectSummary[] = [];
    if (params.provider === 'all') {
      const lists = results.map((r) => [...r.hits]);
      for (let i = 0; merged.length < params.pageSize; i++) {
        let added = false;
        for (const list of lists) {
          if (list[i]) {
            merged.push(list[i]);
            added = true;
          }
        }
        if (!added) break;
      }
    } else {
      merged.push(...results[0].hits);
    }

    return {
      hits: merged,
      total: results.reduce((sum, r) => sum + r.total, 0),
      sources: results.map((r) => ({ provider: r.provider, total: r.total, error: r.error })),
    };
  });

  app.get('/:provider/:projectId', async (req) => {
    const { provider, projectId } = req.params as { provider: string; projectId: string };
    return provider === 'modrinth'
      ? modrinth.getProject(projectId)
      : curseforge.getProject(projectId);
  });

  app.get('/:provider/:projectId/versions', async (req) => {
    const { provider, projectId } = req.params as { provider: string; projectId: string };
    const versions =
      provider === 'modrinth'
        ? await modrinth.getVersions(projectId)
        : await curseforge.getVersions(projectId);

    versions.sort((a, b) => new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime());
    return { versions };
  });
}
