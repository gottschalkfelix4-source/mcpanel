import type { FastifyInstance } from 'fastify';
import { getServerAccess } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { prisma } from '../db.js';
import { verifyMapToken } from '../lib/mapToken.js';
import { bluemapTarget, injectStorageShim, isDocumentPath, readDocument, requestUpstream, SANDBOX_HEADERS, upstreamPath } from '../services/bluemapProxy.js';

/**
 * Eingebettete BlueMap-Karte (`/api/map-view/<token>/…`). Läuft ohne
 * Bearer-Token – die Berechtigung steckt im Kurzzeit-Token des Pfads und wird
 * je Anfrage frisch gegen Konto und Serverrechte geprüft (kurz zwischengespeichert,
 * weil eine Karte Hunderte Kacheln lädt).
 */
const ACCESS_CACHE_MS = 15_000;
const allowed = new Map<string, number>();

/** Nur für Tests. */
export function _resetMapViewCache(): void {
  allowed.clear();
}

async function mayView(token: string): Promise<string | null> {
  const claim = verifyMapToken(token);
  if (!claim) return null;
  const cacheKey = `${claim.userId}:${claim.serverId}:${claim.sessionVersion}`;
  if ((allowed.get(cacheKey) ?? 0) > Date.now()) return claim.serverId;
  const user = await prisma.user.findUnique({ where: { id: claim.userId } });
  if (!user?.active || user.sessionVersion !== claim.sessionVersion) return null;
  try {
    const access = await getServerAccess(user, claim.serverId);
    if (!access.can(PERMISSIONS.CONSOLE_READ)) return null;
  } catch {
    return null;
  }
  allowed.set(cacheKey, Date.now() + ACCESS_CACHE_MS);
  if (allowed.size > 5000) allowed.delete(allowed.keys().next().value!);
  return claim.serverId;
}

export default async function mapViewRoutes(app: FastifyInstance) {
  // Ein Platzhalter statt `/:token/*`: Das Token ist länger als Fastifys
  // Grenze für Pfadparameter (100 Zeichen).
  app.get('/*', async (req, reply) => {
    reply.headers(SANDBOX_HEADERS);
    const rest = (req.params as { '*': string })['*'] ?? '';
    const slash = rest.indexOf('/');
    const token = slash < 0 ? rest : rest.slice(0, slash);
    const serverId = await mayView(token);
    if (!serverId) return reply.code(401).type('text/plain; charset=utf-8').send('Der Kartenlink ist abgelaufen. Bitte den Reiter „Karte“ neu laden.');
    // Ohne abschließenden Schrägstrich lösten BlueMaps relative Pfade falsch auf.
    if (slash < 0) return reply.redirect(`${encodeURIComponent(token)}/`);
    const path = upstreamPath(req.raw.url ?? '', token);
    if (!path) return reply.code(400).type('text/plain; charset=utf-8').send('Ungültiger Pfad');
    const server = await prisma.server.findUnique({ where: { id: serverId } });
    const target = server ? await bluemapTarget(server) : null;
    if (!target) return reply.code(404).type('text/plain; charset=utf-8').send('Auf diesem Server ist BlueMap nicht installiert.');
    const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
    const document = isDocumentPath(path);
    try {
      const upstream = await requestUpstream(target, method, path, req.headers, { document });
      if (document && method === 'GET' && upstream.status === 200 && /text\/html/i.test(upstream.headers['content-type'] ?? '')) {
        // Ohne den Ersatz für localStorage startet BlueMap in der Sandbox nicht.
        const html = injectStorageShim(await readDocument(upstream));
        return reply.code(200)
          .header('content-type', upstream.headers['content-type'])
          .header('cache-control', 'no-store')
          .send(html);
      }
      reply.code(upstream.status).headers(upstream.headers);
      // Bricht der Browser ab (Kachel nicht mehr gebraucht, SSE geschlossen), Verbindung freigeben.
      req.raw.on('close', () => upstream.stream.destroy());
      return reply.send(upstream.stream);
    } catch {
      return reply.code(502).type('text/plain; charset=utf-8').send('BlueMap ist gerade nicht erreichbar – läuft der Server?');
    }
  });
}
