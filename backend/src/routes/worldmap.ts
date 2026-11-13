import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, requireServer } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { badRequest } from '../lib/errors.js';
import { createMapToken } from '../lib/mapToken.js';
import { sendServerCommand } from '../services/consoleCommand.js';
import { contentKindFor, serverLoader } from '../services/content.js';
import * as dockerSvc from '../services/docker.js';
import { acceptBlueMapDownload, addonState, ADDONS, installAddon, installedAddon, type AddonKey } from '../services/mapAddons.js';
import { withServerOperation } from '../services/operations.js';
import { getPlayerPositions } from '../services/playerPositions.js';
import {
  BYTES_PER_CHUNK, cancelPregen, clearPregen, estimateChunks, getMapSettings, pausePregen, pregenInputSchema,
  resumePregen, saveMapSettings, startPregen,
} from '../services/pregen.js';
import { remainingDiskBytes } from '../services/quota.js';
import { scanChunks } from '../services/regionScan.js';
import { runTask } from '../services/tasks.js';

/** Reiter „Karte“: Chunk-Übersicht, Spielerpositionen, Vorgenerierung, BlueMap (`/api/servers/:id/map`). */
export default async function worldMapRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const access = await requireServer(req, PERMISSIONS.CONSOLE_READ);
    const server = access.server;
    const [chunky, bluemap, settings, remaining] = await Promise.all([
      addonState(server, 'chunky'),
      addonState(server, 'bluemap'),
      getMapSettings(server.id),
      remainingDiskBytes(server),
    ]);
    return {
      loader: contentKindFor(server.type) ? serverLoader(server) : 'VANILLA',
      mcVersion: server.mcVersion,
      addons: { chunky, bluemap },
      bluemapAccepted: settings.bluemapAccepted,
      job: settings.job,
      canPregen: access.can(PERMISSIONS.WORLD_PREGEN),
      remainingDiskBytes: Number.isFinite(remaining) ? remaining : null,
      bytesPerChunk: BYTES_PER_CHUNK,
    };
  });

  app.get('/chunks', async (req) => {
    const access = await requireServer(req, PERMISSIONS.CONSOLE_READ);
    const { dimension } = z.object({ dimension: z.enum(['overworld', 'nether', 'end']).default('overworld') }).parse(req.query);
    return scanChunks(access.server.id, dimension);
  });

  app.get('/players', async (req) => {
    const access = await requireServer(req, PERMISSIONS.CONSOLE_READ);
    const { state } = await dockerSvc.getState(access.server);
    if (state !== 'running') return { online: 0, players: [], unsupported: false, offline: true };
    try {
      return { ...(await getPlayerPositions(access.server)), offline: false };
    } catch {
      return { online: 0, players: [], unsupported: false, offline: true };
    }
  });

  /** Kurzzeit-Link für die eingebettete BlueMap-Karte. */
  app.post('/view-token', async (req) => {
    const access = await requireServer(req, PERMISSIONS.CONSOLE_READ);
    if (!(await installedAddon(access.server, 'bluemap'))) throw badRequest('BlueMap ist auf diesem Server nicht installiert.');
    const token = createMapToken(access.server.id, req.user!.id, req.user!.sessionVersion);
    return { url: `/api/map-view/${token}/` };
  });

  /** Chunky und/oder BlueMap installieren, optional mit Neustart. */
  app.post('/addons', async (req) => {
    const access = await requireServer(req, PERMISSIONS.WORLD_PREGEN);
    const body = z.object({
      chunky: z.boolean().default(false),
      bluemap: z.boolean().default(false),
      acceptDownload: z.boolean().default(false),
      restart: z.boolean().default(true),
    }).parse(req.body);
    if (body.bluemap && !body.acceptDownload) {
      throw badRequest('BlueMap zeichnet die Karte nur, wenn sie Spielgrafiken von Mojang laden darf. Bitte zustimmen.');
    }
    const wanted = (['chunky', 'bluemap'] as AddonKey[]).filter((key) => body[key]);
    if (wanted.length === 0) throw badRequest('Nichts zu installieren');
    const server = access.server;
    const taskId = await runTask(server.id, 'map.addons', (task) => withServerOperation(server.id, 'Die Einrichtung der Karte', async () => {
      let step = 0;
      for (const key of wanted) {
        await task.update(10 + step * 35, `${ADDONS[key].label} wird heruntergeladen …`);
        const file = await installAddon(server, key);
        await task.log(`${ADDONS[key].label}: ${file}`);
        step++;
      }
      if (body.bluemap) {
        const settings = await getMapSettings(server.id);
        await saveMapSettings(server.id, { ...settings, bluemapAccepted: true });
        // Liegt BlueMaps Konfiguration schon vor, gleich freischalten.
        await acceptBlueMapDownload(server);
      }
      const { state } = await dockerSvc.getState(server);
      if (body.restart && (state === 'running' || state === 'starting')) {
        await task.update(85, 'Server startet neu, damit die Erweiterungen geladen werden …');
        await dockerSvc.restart(server);
      }
      await task.update(100, body.restart ? 'Fertig – die Erweiterungen sind geladen.' : 'Fertig – die Erweiterungen laden beim nächsten Start.');
    }));
    await audit(req.user!.id, server.id, 'map.addons', wanted.join(', '));
    return { taskId };
  });

  /** Zustimmung zum Mojang-Download für ein schon vorhandenes BlueMap nachholen. */
  app.post('/bluemap-accept', async (req) => {
    const access = await requireServer(req, PERMISSIONS.WORLD_PREGEN);
    const settings = await getMapSettings(access.server.id);
    await saveMapSettings(access.server.id, { ...settings, bluemapAccepted: true });
    // Schreibt im Serverordner – nicht neben Restore oder Modpack-Installation.
    const result = await withServerOperation(access.server.id, 'Die Einrichtung der Karte', () => acceptBlueMapDownload(access.server));
    const { state } = await dockerSvc.getState(access.server);
    if (result === 'changed' && state === 'running') await sendServerCommand(access.server, 'bluemap reload').catch(() => null);
    await audit(req.user!.id, access.server.id, 'map.bluemapAccept');
    return { ok: true, applied: result !== 'missing' };
  });

  // --- Vorgenerierung -------------------------------------------------

  app.post('/pregen/estimate', async (req) => {
    const access = await requireServer(req, PERMISSIONS.CONSOLE_READ);
    const input = pregenInputSchema.parse(req.body);
    const chunks = estimateChunks(input.shape, input.radius);
    const remaining = await remainingDiskBytes(access.server);
    return { chunks, bytes: chunks * BYTES_PER_CHUNK, fits: !Number.isFinite(remaining) || chunks * BYTES_PER_CHUNK <= remaining };
  });

  app.post('/pregen', async (req) => {
    const access = await requireServer(req, PERMISSIONS.WORLD_PREGEN);
    const input = pregenInputSchema.parse(req.body);
    const job = await startPregen(access.server, input, req.user!.id);
    await audit(req.user!.id, access.server.id, 'pregen.start', `${input.dimension}, ${input.shape}, Radius ${input.radius} um ${input.centerX}/${input.centerZ}`);
    return job;
  });

  app.post('/pregen/pause', async (req) => {
    const access = await requireServer(req, PERMISSIONS.WORLD_PREGEN);
    const job = await pausePregen(access.server);
    await audit(req.user!.id, access.server.id, 'pregen.pause');
    return job;
  });

  app.post('/pregen/resume', async (req) => {
    const access = await requireServer(req, PERMISSIONS.WORLD_PREGEN);
    const job = await resumePregen(access.server);
    await audit(req.user!.id, access.server.id, 'pregen.resume');
    return job;
  });

  app.post('/pregen/cancel', async (req) => {
    const access = await requireServer(req, PERMISSIONS.WORLD_PREGEN);
    const job = await cancelPregen(access.server);
    await audit(req.user!.id, access.server.id, 'pregen.cancel');
    return job;
  });

  app.delete('/pregen', async (req) => {
    const access = await requireServer(req, PERMISSIONS.WORLD_PREGEN);
    await clearPregen(access.server.id);
    return { ok: true };
  });
}
