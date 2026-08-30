import type { FastifyInstance } from 'fastify';
import type { Server } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { audit, authenticate, getServerAccess, requireServer } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { badRequest, forbidden } from '../lib/errors.js';
import * as dockerSvc from '../services/docker.js';
import { listPlayers, rconCommand } from '../services/rcon.js';
import {
  createServer,
  deleteServer,
  serializeServer,
  serverDiskUsage,
  updateServerSettings,
} from '../services/serverManager.js';
import { assertMemoryAllowed, quotaState } from '../services/quota.js';
import { getPublicHost } from '../services/settings.js';

import filesRoutes from './files.js';
import configRoutes from './config.js';
import backupRoutes from './backups.js';
import modpackRoutes from './modpacks.js';
import contentRoutes from './content.js';
import memberRoutes from './members.js';
import automationRoutes from './automations.js';
import notificationRoutes from './notifications.js';

const SERVER_TYPES = [
  'VANILLA', 'PAPER', 'PURPUR', 'SPIGOT', 'FABRIC', 'FORGE', 'NEOFORGE', 'QUILT', 'MODPACK',
] as const;

const createSchema = z.object({
  name: z.string().min(2).max(48),
  description: z.string().max(280).optional(),
  type: z.enum(SERVER_TYPES).default('PAPER'),
  mcVersion: z.string().min(1).default('LATEST'),
  memoryMb: z.number().int().min(512).max(65536).default(4096),
  port: z.number().int().min(1024).max(65535).optional(),
  ownerId: z.string().optional(),
  quotaDiskMb: z.number().int().min(0).max(10_000_000).optional(),
  quotaBackups: z.number().int().min(0).max(500).optional(),
  quotaMemoryMb: z.number().int().min(0).max(65536).optional(),
});

/** Kontingente – nur Administratoren duerfen sie setzen. */
const quotaSchema = z.object({
  quotaDiskMb: z.number().int().min(0).max(10_000_000).optional(),
  quotaBackups: z.number().int().min(0).max(500).optional(),
  quotaMemoryMb: z.number().int().min(0).max(65536).optional(),
});

const updateSchema = z.object({
  name: z.string().min(2).max(48).optional(),
  description: z.string().max(280).optional(),
  type: z.enum(SERVER_TYPES).optional(),
  mcVersion: z.string().min(1).optional(),
  memoryMb: z.number().int().min(512).max(65536).optional(),
  autoStart: z.boolean().optional(),
  extraEnv: z.record(z.string()).optional(),
});

/**
 * Verglichen wird gegen den gespeicherten Stand: nur eine echte Änderung ist
 * verboten. Sonst könnte ein Nicht-Admin an einem Server mit gesetztem
 * MC_IMAGE gar nichts mehr speichern – die Oberfläche schickt extraEnv immer
 * vollständig zurück.
 */
function assertProtectedEnvUnchanged(server: Server, next: Record<string, string>): void {
  const current = (server.extraEnv ?? {}) as Record<string, string>;
  const changed = dockerSvc.PROTECTED_ENV_KEYS.filter(
    (key) => (next[key] ?? '') !== (current[key] ?? ''),
  );
  if (changed.length > 0) {
    throw forbidden(`Nur ein Administrator kann ${changed.join(', ')} ändern`);
  }
}

const powerSchema = z.object({
  action: z.enum(['start', 'stop', 'restart', 'kill']),
});

const commandSchema = z.object({
  command: z.string().min(1).max(1000),
});

export default async function serverRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // --- Liste -------------------------------------------------------------
  app.get('/', async (req) => {
    const user = req.user!;
    const servers =
      user.role === 'ADMIN'
        ? await prisma.server.findMany({ orderBy: { createdAt: 'asc' } })
        : await prisma.server.findMany({
            where: {
              OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
            },
            orderBy: { createdAt: 'asc' },
          });

    return Promise.all(servers.map((s) => serializeServer(s, { withStats: true })));
  });

  // --- Anlegen -----------------------------------------------------------
  app.post('/', async (req, reply) => {
    const user = req.user!;

    // Server anlegen ist Administratorensache: an einem Server haengen RAM,
    // Plattenplatz und ein Port. Freunde bekommen Zugriff auf einen
    // bestehenden Server (Tab "Zugriff"), statt sich selbst welche anzulegen.
    if (user.role !== 'ADMIN') {
      throw forbidden('Nur Administratoren können Server anlegen');
    }

    const data = createSchema.parse(req.body);

    const server = await createServer({
      quota: {
        quotaDiskMb: data.quotaDiskMb ?? 0,
        quotaBackups: data.quotaBackups ?? 0,
        quotaMemoryMb: data.quotaMemoryMb ?? 0,
      },
      name: data.name,
      description: data.description,
      ownerId: data.ownerId ?? user.id,
      type: data.type,
      mcVersion: data.mcVersion,
      memoryMb: data.memoryMb,
      port: data.port,
    });

    await audit(user.id, server.id, 'server.create', server.name);
    reply.code(201);
    return serializeServer(server);
  });

  // --- Detail ------------------------------------------------------------
  app.get('/:id', async (req) => {
    const access = await requireServer(req);
    const [serialized, disk, quota, owner, members] = await Promise.all([
      serializeServer(access.server, { withStats: true }),
      serverDiskUsage(access.server),
      quotaState(access.server),
      prisma.user.findUnique({
        where: { id: access.server.ownerId },
        select: { id: true, username: true },
      }),
      prisma.serverMember.count({ where: { serverId: access.server.id } }),
    ]);

    return {
      ...serialized,
      owner,
      memberCount: members,
      disk,
      quota,
      permissions: access.permissions,
      isOwner: access.isOwner,
      isAdmin: access.isAdmin,
      rcon: access.isOwner || access.isAdmin ? { port: access.server.rconPort } : null,
      publicHost: await getPublicHost(),
    };
  });

  app.patch('/:id', async (req) => {
    const access = await requireServer(req, PERMISSIONS.SETTINGS_EDIT);
    const data = updateSchema.parse(req.body);
    const quota = quotaSchema.parse(req.body);

    const wantsQuota = Object.values(quota).some((v) => v !== undefined);
    if (wantsQuota && !access.isAdmin) {
      throw forbidden('Kontingente kann nur ein Administrator ändern');
    }
    if (data.extraEnv !== undefined && !access.isAdmin) {
      assertProtectedEnvUnchanged(access.server, data.extraEnv);
    }
    if (data.memoryMb !== undefined) {
      assertMemoryAllowed(access.server, data.memoryMb, access.isAdmin);
    }

    const { server, recreated } = await updateServerSettings(access.server, {
      ...data,
      ...(wantsQuota ? quota : {}),
    });
    await audit(req.user!.id, server.id, 'server.update', Object.keys(data).join(', '));
    return { ...(await serializeServer(server)), recreated };
  });

  app.delete('/:id', async (req) => {
    const access = await requireServer(req);
    if (!access.isOwner && !access.isAdmin) throw forbidden('Nur der Besitzer kann den Server löschen');
    const deleteFiles = (req.query as { files?: string }).files !== 'keep';
    await deleteServer(access.server, deleteFiles);
    await audit(req.user!.id, null, 'server.delete', access.server.name);
    return { ok: true };
  });

  // --- Power -------------------------------------------------------------
  app.post('/:id/power', async (req) => {
    const access = await requireServer(req, PERMISSIONS.POWER);
    const { action } = powerSchema.parse(req.body);
    const server = access.server;

    switch (action) {
      case 'start':
        await dockerSvc.start(server);
        break;
      case 'stop':
        await dockerSvc.stop(server);
        break;
      case 'restart':
        await dockerSvc.restart(server);
        break;
      case 'kill':
        await dockerSvc.kill(server);
        break;
    }

    await audit(req.user!.id, server.id, `server.${action}`, '');
    return { ok: true, ...(await dockerSvc.getState(server)) };
  });

  // --- Konsole -----------------------------------------------------------
  app.get('/:id/logs', async (req) => {
    const access = await requireServer(req, PERMISSIONS.CONSOLE_READ);
    const lines = Number((req.query as { lines?: string }).lines ?? 400);
    return { log: await dockerSvc.tailLogs(access.server, Math.min(2000, Math.max(50, lines))) };
  });

  app.post('/:id/command', async (req) => {
    const access = await requireServer(req, PERMISSIONS.CONSOLE_COMMAND);
    const { command } = commandSchema.parse(req.body);
    const server = access.server;

    const { state } = await dockerSvc.getState(server);
    if (state !== 'running') throw badRequest('Server läuft nicht');

    const clean = command.replace(/^\//, '');
    await audit(req.user!.id, server.id, 'server.command', clean.slice(0, 120));

    try {
      const response = await rconCommand(server, clean);
      return { ok: true, via: 'rcon', response };
    } catch {
      await dockerSvc.writeStdin(server, clean);
      return { ok: true, via: 'stdin', response: '' };
    }
  });

  // --- Spieler & Stats ---------------------------------------------------
  app.get('/:id/players', async (req) => {
    const access = await requireServer(req);
    const { state } = await dockerSvc.getState(access.server);
    if (state !== 'running') return { online: 0, max: 0, players: [], available: false };
    try {
      return { ...(await listPlayers(access.server)), available: true };
    } catch {
      return { online: 0, max: 0, players: [], available: false };
    }
  });

  app.get('/:id/stats', async (req) => {
    const access = await requireServer(req);
    const [state, stats, disk] = await Promise.all([
      dockerSvc.getState(access.server),
      dockerSvc.getStats(access.server),
      serverDiskUsage(access.server),
    ]);
    return { ...state, stats, disk, memoryLimitMb: access.server.memoryMb };
  });

  app.get('/:id/tasks', async (req) => {
    const access = await requireServer(req);
    return prisma.task.findMany({
      where: { serverId: access.server.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  });

  // --- Untergeordnete Bereiche ------------------------------------------
  await app.register(filesRoutes, { prefix: '/:id/files' });
  await app.register(configRoutes, { prefix: '/:id/config' });
  await app.register(backupRoutes, { prefix: '/:id/backups' });
  await app.register(modpackRoutes, { prefix: '/:id/modpack' });
  await app.register(contentRoutes, { prefix: '/:id/content' });
  await app.register(memberRoutes, { prefix: '/:id/members' });
  await app.register(automationRoutes, { prefix: '/:id/automations' });
  await app.register(notificationRoutes, { prefix: '/:id/notifications' });
}

export { getServerAccess };
