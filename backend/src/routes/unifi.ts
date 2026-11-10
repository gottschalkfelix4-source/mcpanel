import type { FastifyInstance } from 'fastify';
import { audit, requireAdmin } from '../auth/context.js';
import {
  assertUsable, getUnifiConfig, lastSyncStatus, mergeUnifiInput, publicUnifiConfig, removeAllRules,
  saveUnifiConfig, syncUnifi, testUnifi, unifiInputSchema,
} from '../services/unifi.js';

/** UniFi-Anbindung – ausschließlich für Administratoren (`/api/settings/unifi`). */
export default async function unifiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => {
    const config = await getUnifiConfig();
    return { config: publicUnifiConfig(config), status: lastSyncStatus() };
  });

  /** Verbindung prüfen, ohne zu speichern – liefert den Zertifikats-Fingerabdruck. */
  app.post('/test', async (req) => {
    const merged = await mergeUnifiInput(unifiInputSchema.parse(req.body));
    return testUnifi(merged);
  });

  app.put('/', async (req) => {
    const merged = await mergeUnifiInput(unifiInputSchema.parse(req.body));
    const previous = await getUnifiConfig();
    if (merged.enabled) {
      assertUsable(merged);
      // Erst prüfen, dann speichern: sonst scheitert jeder spätere Abgleich still.
      const test = await testUnifi(merged);
      if (!test.ok) return { ok: false, test, config: publicUnifiConfig(previous), status: lastSyncStatus() };
    }
    let removed = 0;
    let removeError: string | null = null;
    if (!merged.enabled && previous.enabled) {
      // Beim Abschalten die eigenen Weiterleitungen wieder schließen.
      removed = await removeAllRules(previous).catch((err) => {
        removeError = err instanceof Error ? err.message : String(err);
        return 0;
      });
    }
    await saveUnifiConfig(merged);
    await audit(req.user!.id, null, 'settings.unifi', merged.enabled ? `aktiv (${merged.url})` : 'aus');
    const status = merged.enabled ? await syncUnifi(req.log.info.bind(req.log)) : null;
    return { ok: true, removed, removeError, config: publicUnifiConfig(merged), status };
  });

  app.post('/sync', async (req) => {
    const config = await getUnifiConfig();
    if (!config.enabled) return { ok: false, status: null };
    const status = await syncUnifi(req.log.info.bind(req.log));
    return { ok: Boolean(status?.ok), status };
  });
}
