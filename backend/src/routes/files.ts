import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { attachment } from '../lib/contentDisposition.js';
import { audit, requireServer } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { badRequest, notFound } from '../lib/errors.js';
import * as files from '../services/files.js';
import { assertDiskAvailable, remainingDiskBytes } from '../services/quota.js';
import { guardMutations } from './mutationGuard.js';
import { getSftpInfo } from '../services/sftp.js';
import { getSftpHost } from '../services/settings.js';
import { reserveDisk } from '../services/diskReservation.js';
import { forgetTreeStats, treeStats, type TreeStats } from '../services/treeStats.js';
import { serverDir } from '../config.js';

const pathQuery = z.object({ path: z.string().default('/') });

export default async function fileRoutes(app: FastifyInstance) {
  guardMutations(app);
  app.get('/sftp', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_READ);
    return { ...getSftpInfo(), host: await getSftpHost(), username: req.user!.username,
      path: `/${access.server.id}/`, writable: access.can(PERMISSIONS.FILES_WRITE) };
  });
  // Verzeichnis auflisten
  app.get('/', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_READ);
    const { path: rel } = pathQuery.parse(req.query);
    return { path: rel, entries: await files.listDir(access.server.id, rel) };
  });

  // Ordnergrößen getrennt von der Liste: die bleibt so sofort da, auch wenn
  // ein Ordner wie die Welt oder BlueMap-Kacheln Hunderttausende Dateien hat.
  app.get('/sizes', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_READ);
    const { path: rel } = pathQuery.parse(req.query);
    const dirs = (await files.listDir(access.server.id, rel)).filter((entry) => entry.isDir);
    const sizes: Record<string, TreeStats> = {};
    for (let i = 0; i < dirs.length; i += 4) {
      await Promise.all(dirs.slice(i, i + 4).map(async (entry) => {
        sizes[entry.name] = await treeStats(files.resolveSafe(access.server.id, entry.path));
      }));
    }
    return { path: rel, sizes };
  });

  // Nach jeder Änderung über den Dateimanager stimmen die Ordnergrößen nicht mehr.
  app.addHook('onResponse', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const id = (req.params as { id?: string } | undefined)?.id;
    if (id) {
      try { forgetTreeStats(serverDir(id)); } catch { /* unbekannter Server – nichts zu vergessen */ }
    }
  });

  // Datei lesen
  app.get('/content', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_READ);
    const { path: rel } = pathQuery.parse(req.query);
    return { path: rel, content: await files.readFile(access.server.id, rel) };
  });

  // Datei schreiben
  app.put('/content', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_WRITE);
    const body = z.object({ path: z.string().min(1), content: z.string() }).parse(req.body);
    const old = await fsp.stat(files.resolveSafe(access.server.id, body.path)).catch(() => null);
    await assertDiskAvailable(access.server, Math.max(0, Buffer.byteLength(body.content) - (old?.size ?? 0)));
    await files.writeFile(access.server.id, body.path, body.content);
    await audit(req.user!.id, access.server.id, 'files.write', body.path);
    return { ok: true };
  });

  app.post('/dir', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_WRITE);
    const body = z.object({ path: z.string().min(1) }).parse(req.body);
    await files.createDir(access.server.id, body.path);
    return { ok: true };
  });

  app.post('/rename', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_WRITE);
    const body = z.object({ from: z.string().min(1), to: z.string().min(1) }).parse(req.body);
    await files.rename(access.server.id, body.from, body.to);
    await audit(req.user!.id, access.server.id, 'files.rename', `${body.from} -> ${body.to}`);
    return { ok: true };
  });

  app.delete('/', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_WRITE);
    const body = z.object({ paths: z.array(z.string().min(1)).min(1) }).parse(req.body);
    await files.remove(access.server.id, body.paths);
    await audit(req.user!.id, access.server.id, 'files.delete', body.paths.join(', ').slice(0, 200));
    return { ok: true };
  });

  app.post('/unzip', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_WRITE);
    const body = z
      .object({ path: z.string().min(1), target: z.string().default('/') })
      .parse(req.body);
    await files.unzip(access.server.id, body.path, body.target, await remainingDiskBytes(access.server));
    return { ok: true };
  });

  // Download
  app.get('/download', async (req, reply) => {
    const access = await requireServer(req, PERMISSIONS.FILES_READ);
    const { path: rel } = pathQuery.parse(req.query);
    const abs = files.downloadPath(access.server.id, rel);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat || stat.isDirectory()) throw notFound('Datei nicht gefunden');

    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', String(stat.size))
      .header('Content-Disposition', attachment(path.basename(abs)));
    return reply.send(fs.createReadStream(abs));
  });

  // Upload (multipart)
  app.post('/upload', { config: { locksItself: true } }, async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_WRITE);
    const dir = (req.query as { path?: string }).path ?? '/';

    // Kontingent vorher pruefen; die Groesse des Uploads steht erst waehrend
    // des Empfangs fest, deshalb greift die Pruefung auf den Ist-Stand zu.
    await assertDiskAvailable(access.server);

    const parts = req.parts();
    const saved: string[] = [];
    for await (const part of parts) {
      if (part.type !== 'file') continue;
      const safeName = path.basename(part.filename).replace(/[\\/:*?"<>|]/g, '_');
      const old = await fsp.stat(files.resolveSafe(access.server.id, path.join(dir, safeName))).catch(() => null);
      // Gleichzeitige Uploads teilen sich das Restkontingent.
      const reservation = reserveDisk(access.server, old?.size ?? 0);
      try {
        await files.saveUpload(access.server.id, dir, part.filename, part.file, await remainingDiskBytes(access.server) + (old?.size ?? 0), reservation);
      } finally {
        reservation.release();
      }
      saved.push(part.filename);
    }
    if (saved.length === 0) throw badRequest('Keine Datei empfangen');
    await audit(req.user!.id, access.server.id, 'files.upload', saved.join(', ').slice(0, 200));
    return { ok: true, saved };
  });
}
