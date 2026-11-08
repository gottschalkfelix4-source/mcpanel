import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authenticate, requireAdmin } from '../auth/context.js';
import {
  checkNodes,
  createNode,
  deleteNode,
  getNode,
  installCommand,
  installScript,
  nodeImage,
  nodeOverview,
  uninstallCommand,
  updateNode,
} from '../services/nodes.js';
import { tunnelState } from '../services/tunnel.js';

const hostSchema = z.string().trim().min(1).max(253);
const portSchema = z.number().int().min(1).max(65535);

const createSchema = z.object({
  name: z.string().trim().min(1).max(40),
  publicHost: hostSchema,
  /** `direct` = im selben Netz ohne VPN */
  connection: z.enum(['wireguard', 'direct']).default('wireguard'),
  /** `windows` = Docker Desktop, Installationsbefehl für PowerShell */
  platform: z.enum(['linux', 'windows']).default('linux'),
  listenPort: portSchema.default(51820),
  dataRoot: z.string().trim().max(200).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  publicHost: hostSchema.optional(),
  listenPort: portSchema.optional(),
});

/** Nodes verwalten ist Administratorensache – sie hängen am Docker-Socket fremder Rechner. */
export default async function nodeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => {
    const tunnel = tunnelState();
    return {
      tunnel: { up: tunnel.up, error: tunnel.error, mode: tunnel.mode, panelIp: tunnel.panelIp },
      image: nodeImage(),
      nodes: await nodeOverview(),
    };
  });

  app.post('/', async (req, reply) => {
    const body = createSchema.parse(req.body);
    const node = await createNode(body);
    await audit(req.user!.id, null, 'node.create', `${node.name} (${node.publicHost})`);
    reply.code(201);
    return { id: node.id, command: await installCommand(node), script: await installScript(node), uninstall: uninstallCommand(node) };
  });

  /** Installationsbefehl erneut anzeigen, etwa nach einer Neuinstallation des VPS. */
  app.get('/:id/install', async (req) => {
    const { id } = req.params as { id: string };
    const node = await getNode(id);
    await audit(req.user!.id, null, 'node.install', node.name);
    // Das Skript im Klartext dazu – zum Nachlesen, bevor man es als root ausführt.
    return { command: await installCommand(node), script: await installScript(node), uninstall: uninstallCommand(node) };
  });

  /** Sofort neu prüfen statt auf den nächsten Durchlauf zu warten (Assistent). */
  app.post('/check', async () => {
    await checkNodes();
    return { nodes: await nodeOverview() };
  });

  app.patch('/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = updateSchema.parse(req.body);
    const node = await updateNode(id, body);
    await audit(req.user!.id, null, 'node.update', node.name);
    return { ok: true };
  });

  app.delete('/:id', async (req) => {
    const { id } = req.params as { id: string };
    const node = await getNode(id);
    await deleteNode(id);
    await audit(req.user!.id, null, 'node.delete', node.name);
    return { ok: true, uninstall: uninstallCommand(node) };
  });
}
