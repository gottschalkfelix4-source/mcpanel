import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { attachment } from '../lib/contentDisposition.js';
import { audit, requireAdmin } from '../auth/context.js';
import { prisma } from '../db.js';
import { setSetting } from '../services/settings.js';
import { createPanelBackup, deletePanelBackup, getPanelBackupSchedule, listPanelBackups, panelBackupFile, panelBackupScheduleSchema } from '../services/panelBackups.js';
import { runTask } from '../services/tasks.js';

export default async function panelBackupRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin);
  app.get('/', async () => ({ backups: await listPanelBackups(), schedule: await getPanelBackupSchedule(),
    tasks: await prisma.task.findMany({ where: { serverId: null, type: 'panel.backup' }, orderBy: { createdAt: 'desc' }, take: 5 }) }));
  app.post('/', async req => {
    const taskId = await runTask(null, 'panel.backup', task => createPanelBackup(task).then(() => {}));
    await audit(req.user!.id, null, 'panel.backup.create');
    return { taskId };
  });
  app.put('/schedule', async req => {
    const schedule = panelBackupScheduleSchema.parse(req.body);
    await setSetting('panel.backup.schedule', JSON.stringify(schedule));
    await audit(req.user!.id, null, 'panel.backup.schedule', schedule.enabled ? schedule.cron : 'deaktiviert');
    return getPanelBackupSchedule();
  });
  app.get('/:filename/download', async (req, reply) => {
    const { filename } = z.object({ filename: z.string() }).parse(req.params);
    const file = await panelBackupFile(filename);
    reply.header('Content-Type', 'application/gzip').header('Content-Length', file.sizeBytes)
      .header('Content-Disposition', attachment(filename));
    return reply.send(fs.createReadStream(file.path));
  });
  app.delete('/:filename', async req => {
    const { filename } = z.object({ filename: z.string() }).parse(req.params);
    await deletePanelBackup(filename);
    await audit(req.user!.id, null, 'panel.backup.delete', filename);
    return { ok: true };
  });
}
