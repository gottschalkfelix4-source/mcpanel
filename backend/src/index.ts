import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { Server as IOServer } from 'socket.io';
import { ZodError } from 'zod';

import { config } from './config.js';
import { stopPanelBackupScheduler } from './services/panelBackups.js';
import { prisma } from './db.js';
import { HttpError } from './lib/errors.js';
import { bootstrap } from './bootstrap.js';
import { setupConsoleGateway } from './ws/console.js';
import { closeRconConnections } from './services/rcon.js';
import { startSftp, stopSftp } from './services/sftp.js';
import { stopScheduler } from './services/automation.js';
import { stopWatcher } from './services/notify.js';
import { isServerNetworkAddress, trustProxy } from './lib/network.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import serverRoutes from './routes/servers.js';
import catalogRoutes from './routes/catalog.js';
import settingsRoutes from './routes/settings.js';
import setupRoutes from './routes/setup.js';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
  },
  bodyLimit: 32 * 1024 * 1024,
  /**
   * Vor dem Backend steht immer ein nginx – im Alles-in-einem-Abbild über
   * 127.0.0.1, bei `docker compose` als eigener Dienst im internen Netz.
   * Vertraut wird genau diesem einen Glied (und zusätzlich TRUSTED_PROXIES),
   * sonst könnte jeder Client im LAN per X-Forwarded-For eine beliebige
   * Adresse vorgeben und die Anmeldebremse umgehen.
   */
  trustProxy,
});

/**
 * Minecraft-Container teilen sich ein Netz mit dem Panel (für RCON). Eine
 * Mod oder ein Plugin darf darüber nicht die Panel-API ansprechen.
 */
app.addHook('onRequest', async (req, reply) => {
  if (isServerNetworkAddress(req.socket.remoteAddress) || isServerNetworkAddress(req.ip)) {
    return reply.code(403).send({ error: 'Zugriff aus dem Minecraft-Netz ist gesperrt' });
  }
});

await app.register(cors, { origin: true, credentials: true });
await app.register(multipart, {
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB für Welten/Modpacks
});
// Nur dort bremsen, wo eine Route es ausdrücklich verlangt (config.rateLimit).
// Konsole, Dateiübertragungen und Statusabfragen bleiben unbegrenzt.
await app.register(rateLimit, { global: false });

/**
 * Leerer Body mit `Content-Type: application/json` ist bei Aktions-Endpunkten
 * (z. B. "jetzt ausführen") üblich – Fastify wirft dort sonst einen Fehler.
 */
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const raw = (body as string).trim();
  if (!raw) return done(null, {});
  try {
    done(null, JSON.parse(raw));
  } catch (err) {
    done(err as Error, undefined);
  }
});

/**
 * Systemfehler (Dateisystem mit Pfaden, Prisma mit Abfragedetails, Docker-API)
 * gehen nie an den Client. Eigene, deutsch formulierte Fehlermeldungen schon.
 */
function isInternalError(error: Error): boolean {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && !code.startsWith('FST_')) return true;
  if ((error as { errno?: unknown }).errno !== undefined) return true;
  if (error.name.startsWith('Prisma')) return true;
  return /\(HTTP code \d+\)|ECONNREFUSED|ENOENT|EACCES|\/data\/|\/var\/run\//.test(error.message ?? '');
}

app.setErrorHandler((error, _req, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Ungültige Eingabe',
      details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (error instanceof HttpError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  if ((error as { code?: string }).code === 'P2002') return reply.code(409).send({ error: 'Name, Subdomain oder Port ist bereits vergeben' });
  if ((error as { statusCode?: number }).statusCode === 413) {
    return reply.code(413).send({ error: 'Datei ist zu groß' });
  }

  // Interne Meldungen (Pfade, Docker-/Datenbankdetails) nur ins Log – der
  // Client bekommt eine neutrale Antwort mit Verweis auf das Protokoll.
  app.log.error(error);
  const status = (error as { statusCode?: number }).statusCode;
  if (status && status >= 400 && status < 500 && !isInternalError(error)) {
    return reply.code(status).send({ error: error.message || 'Ungültige Anfrage' });
  }
  return reply.code(500).send({ error: isInternalError(error) ? 'Interner Fehler – Details stehen im Panel-Protokoll' : error.message || 'Interner Fehler' });
});

/**
 * Ziel des Docker-HEALTHCHECK. Die Datenbank wird wirklich angefasst, sonst
 * meldet sich ein Container mit toter Verbindung weiter als gesund und wird
 * nie neu gestartet. `curl -fsS` wertet den 503 als Fehlschlag.
 */
app.get('/api/health', async (_req, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    app.log.error({ err }, 'Health: Datenbank nicht erreichbar');
    return reply.code(503).send({ ok: false, error: 'Datenbank nicht erreichbar' });
  }
  return { ok: true, time: new Date().toISOString() };
});

await app.register(setupRoutes, { prefix: '/api/setup' });
await app.register(authRoutes, { prefix: '/api/auth' });
await app.register(userRoutes, { prefix: '/api/users' });
await app.register(serverRoutes, { prefix: '/api/servers' });
await app.register(catalogRoutes, { prefix: '/api/catalog' });
await app.register(settingsRoutes, { prefix: '/api/settings' });

await app.ready();

const io = new IOServer(app.server, {
  path: '/socket.io',
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 1e6,
});
setupConsoleGateway(io);

await bootstrap((msg) => app.log.info(msg));
try { await startSftp((msg) => app.log.info(msg)); }
catch (err) { app.log.error({ err }, 'SFTP-Dateizugriff konnte nicht gestartet werden'); }

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(`MCPanel-Backend läuft auf Port ${config.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info('Fahre herunter …');
    stopPanelBackupScheduler();
    stopScheduler();
    stopWatcher();
    await stopSftp();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await app.close().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    closeRconConnections();
    process.exit(0);
  });
}
