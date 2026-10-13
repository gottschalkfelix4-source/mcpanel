import type { FastifyInstance } from 'fastify';
import { audit, requireServer } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { assertMemoryAllowed } from '../services/quota.js';
import { reinstallServer } from '../services/serverReinstall.js';
import { reinstallSchema } from '../services/reinstallationData.js';
import { runTask } from '../services/tasks.js';

export default async function reinstallRoutes(app: FastifyInstance) {
  app.post('/', async req => {
    const access = await requireServer(req, PERMISSIONS.SERVER_REINSTALL);
    const body = reinstallSchema.parse(req.body);
    assertMemoryAllowed(access.server, body.memoryMb, access.isAdmin);
    const taskId = await runTask(access.server.id, 'server.reinstall', task =>
      reinstallServer(access.server.id, body, task, { id: req.user!.id, isAdmin: access.isAdmin }));
    await audit(req.user!.id, access.server.id, 'server.reinstall', `${body.type}, Welt ${body.keepWorld ? 'erhalten' : 'neu'}`);
    return { taskId };
  });
}
