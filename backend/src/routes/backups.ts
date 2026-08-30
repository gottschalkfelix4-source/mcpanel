import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { audit, requireServer } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { backupFilePath, createBackup, deleteBackup, restoreBackup } from '../services/backups.js';
import { runTask } from '../services/tasks.js';
import { assertDiskAvailable } from '../services/quota.js';

export default async function backupRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_READ);
    const backups = await prisma.backup.findMany({
      where: { serverId: access.server.id },
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { id: true, username: true } } },
    });
    return backups.map((b) => ({ ...b, sizeBytes: Number(b.sizeBytes) }));
  });

  app.post('/', async (req) => {
    const access = await requireServer(req, PERMISSIONS.BACKUP_CREATE);
    const body = z
      .object({ name: z.string().max(80).optional(), note: z.string().max(280).optional() })
      .parse(req.body ?? {});

    // Vorab pruefen, damit die Absage sofort kommt und nicht erst als
    // fehlgeschlagene Aufgabe im Hintergrund auffaellt.
    await assertDiskAvailable(access.server);

    const userId = req.user!.id;
    const taskId = await runTask(access.server.id, 'backup.create', async (task) => {
      await createBackup(access.server, { ...body, createdById: userId, task });
    });
    await audit(userId, access.server.id, 'backup.create', body.name ?? '');
    return { ok: true, taskId };
  });

  app.post('/:backupId/restore', async (req) => {
    const access = await requireServer(req, PERMISSIONS.BACKUP_RESTORE);
    const { backupId } = req.params as { backupId: string };

    const taskId = await runTask(access.server.id, 'backup.restore', async (task) => {
      await restoreBackup(access.server, backupId, task);
    });
    await audit(req.user!.id, access.server.id, 'backup.restore', backupId);
    return { ok: true, taskId };
  });

  app.delete('/:backupId', async (req) => {
    const access = await requireServer(req, PERMISSIONS.BACKUP_DELETE);
    const { backupId } = req.params as { backupId: string };
    await deleteBackup(access.server, backupId);
    await audit(req.user!.id, access.server.id, 'backup.delete', backupId);
    return { ok: true };
  });

  app.get('/:backupId/download', async (req, reply) => {
    const access = await requireServer(req, PERMISSIONS.FILES_READ);
    const { backupId } = req.params as { backupId: string };
    const file = await backupFilePath(access.server, backupId);
    const stat = fs.statSync(file.path);

    // Kam die Datei aus einer S3-Zweitablage, liegt sie temporaer auf der
    // Platte – nach dem Streamen (auch bei Abbruch) wieder loeschen.
    const stream = fs.createReadStream(file.path);
    stream.on('close', () => void file.cleanup());

    reply
      .header('Content-Type', 'application/gzip')
      .header('Content-Length', String(stat.size))
      .header('Content-Disposition', `attachment; filename="${file.filename}"`);
    return reply.send(stream);
  });
}
