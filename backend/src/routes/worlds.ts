import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authenticate, requireServer } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { cacheDir } from '../config.js';
import { attachment } from '../lib/contentDisposition.js';
import { badRequest } from '../lib/errors.js';
import { byteLimit } from '../lib/byteLimit.js';
import { runTask } from '../services/tasks.js';
import { IMPORT_EXPANDED_LIMIT, IMPORT_UPLOAD_LIMIT } from '../services/serverImport.js';
import {
  activateWorld, assertWorldName, createWorld, deleteWorld, exportWorld, importWorld, inspectWorldZip, listWorlds, resetWorld,
} from '../services/worlds.js';

const seedSchema = z.string().trim().max(64).default('');

export default async function worldRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_READ);
    return listWorlds(access.server);
  });

  app.post('/:name/activate', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_WRITE);
    const { name } = req.params as { name: string };
    const result = await activateWorld(access.server, name);
    await audit(req.user!.id, access.server.id, 'world.activate', name);
    return result;
  });

  app.post('/', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_WRITE);
    const body = z.object({ name: z.string().min(1).max(64), seed: seedSchema }).parse(req.body);
    const result = await createWorld(access.server, body.name, body.seed);
    await audit(req.user!.id, access.server.id, 'world.create', `${body.name}${body.seed ? ` (Seed ${body.seed})` : ''}`);
    return result;
  });

  app.post('/reset', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_WRITE);
    const body = z.object({ seed: seedSchema }).parse(req.body ?? {});
    const userId = req.user!.id;
    const taskId = await runTask(access.server.id, 'world.reset', (task) => resetWorld(access.server, body.seed, task, userId));
    await audit(userId, access.server.id, 'world.reset', body.seed ? `Seed ${body.seed}` : 'zufälliger Seed');
    return { ok: true, taskId };
  });

  app.delete('/:name', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_WRITE);
    const { name } = req.params as { name: string };
    await deleteWorld(access.server, name);
    await audit(req.user!.id, access.server.id, 'world.delete', name);
    return { ok: true };
  });

  app.get('/:name/download', async (req, reply) => {
    const access = await requireServer(req, PERMISSIONS.FILES_READ);
    const { name } = req.params as { name: string };
    const exported = await exportWorld(access.server, name);
    const stat = await fs.stat(exported.file);
    const stream = createReadStream(exported.file);
    stream.on('close', () => void exported.cleanup());
    await audit(req.user!.id, access.server.id, 'world.download', name);
    reply
      .header('Content-Type', 'application/gzip')
      .header('Content-Length', stat.size)
      .header('Content-Disposition', attachment(exported.filename));
    return reply.send(stream);
  });

  /**
   * Welt als ZIP hochladen. Wie beim Dateimanager wird ohne Serversperre
   * empfangen; erst das Entpacken läuft als Aufgabe unter der Sperre.
   */
  app.post('/upload', async (req, reply) => {
    const query = z.object({
      name: z.string().min(1).max(64),
      activate: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    }).parse(req.query);
    const name = assertWorldName(query.name);
    const access = await requireServer(req, PERMISSIONS.FILES_WRITE);
    const base = path.join(cacheDir(), 'world-import');
    await fs.mkdir(base, { recursive: true });
    const directory = await fs.mkdtemp(path.join(base, 'upload-'));
    const archive = path.join(directory, 'world.zip');
    let background = false;
    try {
      let count = 0;
      const free = await fs.statfs(directory);
      const limit = Math.min(IMPORT_UPLOAD_LIMIT, Math.max(0, free.bavail * free.bsize - 64 * 1024 ** 2));
      for await (const part of req.parts({ limits: { files: 1, fields: 0, parts: 1, fileSize: limit } })) {
        if (part.type !== 'file' || ++count !== 1 || !/\.zip$/i.test(part.filename)) throw badRequest('Bitte genau eine ZIP-Datei hochladen.');
        await pipeline(part.file, byteLimit(limit), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
        if (part.file.truncated) throw badRequest('Das ZIP ist zu groß oder wurde unvollständig übertragen.');
      }
      if (count !== 1) throw badRequest('Keine ZIP-Datei empfangen.');
      const plan = await inspectWorldZip(archive, IMPORT_EXPANDED_LIMIT);
      // Rechte nach dem (womöglich langen) Upload erneut prüfen.
      await authenticate(req, reply);
      const current = await requireServer(req, PERMISSIONS.FILES_WRITE);
      const taskId = await runTask(current.server.id, 'world.import', async (task) => {
        try {
          await importWorld(current.server, archive, plan, name, query.activate, task);
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      });
      background = true;
      await audit(req.user!.id, access.server.id, 'world.upload', name);
      return { ok: true, taskId };
    } finally {
      if (!background) await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
