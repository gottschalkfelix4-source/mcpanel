import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { requireAdmin, audit } from '../auth/context.js';
import { cacheDir } from '../config.js';
import { badRequest } from '../lib/errors.js';
import { byteLimit } from '../lib/byteLimit.js';
import { createServer } from '../services/serverManager.js';
import { withServerOperation } from '../services/operations.js';
import { runTask } from '../services/tasks.js';
import { IMPORT_UPLOAD_LIMIT, importEnvironment, importSchema, importServerZip, inspectServerZip } from '../services/serverImport.js';

export default async function serverImportRoutes(app: FastifyInstance) {
  app.post('/import', { preHandler: requireAdmin }, async req => withServerOperation('panel-server-import', 'Ein Server-Upload', async () => {
    const request = importSchema.parse(req.query);
    const base = path.join(cacheDir(), 'server-import');
    await fs.mkdir(base, { recursive: true });
    const directory = await fs.mkdtemp(path.join(base, 'upload-'));
    const archive = path.join(directory, 'server.zip');
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
      const plan = await inspectServerZip(archive);
      const server = await createServer({ name: request.name, ownerId: req.user!.id, type: request.type,
        mcVersion: request.mcVersion, memoryMb: request.memoryMb, extraEnv: importEnvironment(request) });
      await audit(req.user!.id, server.id, 'server.import', 'Neuer Server aus ZIP');
      const taskId = await runTask(server.id, 'server.import', async task => {
        try { await importServerZip(server.id, archive, plan, request, task); }
        finally { await fs.rm(directory, { recursive: true, force: true }); }
      });
      background = true;
      return { id: server.id, taskId };
    } finally {
      if (!background) await fs.rm(directory, { recursive: true, force: true });
    }
  }));
}
