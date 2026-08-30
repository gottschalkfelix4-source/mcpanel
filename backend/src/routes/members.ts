import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { audit, requireServer } from '../auth/context.js';
import {
  ALL_PERMISSIONS,
  DEFAULT_MEMBER_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_LABELS,
} from '../auth/permissions.js';
import { badRequest, notFound } from '../lib/errors.js';

const permissionSchema = z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]]));

export default async function memberRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const access = await requireServer(req);
    const [owner, members] = await Promise.all([
      prisma.user.findUnique({
        where: { id: access.server.ownerId },
        select: { id: true, username: true, email: true },
      }),
      prisma.serverMember.findMany({
        where: { serverId: access.server.id },
        include: { user: { select: { id: true, username: true, email: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return {
      owner,
      members: members.map((m) => ({
        id: m.id,
        user: m.user,
        permissions: m.permissions,
        createdAt: m.createdAt,
      })),
      availablePermissions: ALL_PERMISSIONS.map((p) => ({ key: p, label: PERMISSION_LABELS[p] })),
      defaultPermissions: DEFAULT_MEMBER_PERMISSIONS,
      canManage: access.can(PERMISSIONS.MEMBERS_MANAGE),
    };
  });

  app.post('/', async (req) => {
    const access = await requireServer(req, PERMISSIONS.MEMBERS_MANAGE);
    const body = z
      .object({
        user: z.string().min(1), // Benutzername oder E-Mail
        permissions: permissionSchema.optional(),
      })
      .parse(req.body);

    const user = await prisma.user.findFirst({
      where: { OR: [{ username: body.user }, { email: body.user.toLowerCase() }] },
    });
    if (!user) throw notFound('Benutzer nicht gefunden');
    if (user.id === access.server.ownerId) throw badRequest('Der Besitzer ist bereits berechtigt');

    const existing = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId: access.server.id, userId: user.id } },
    });
    if (existing) throw badRequest('Dieser Benutzer hat bereits Zugriff');

    const member = await prisma.serverMember.create({
      data: {
        serverId: access.server.id,
        userId: user.id,
        permissions: body.permissions ?? DEFAULT_MEMBER_PERMISSIONS,
      },
      include: { user: { select: { id: true, username: true, email: true } } },
    });

    await audit(req.user!.id, access.server.id, 'member.add', user.username);
    return { id: member.id, user: member.user, permissions: member.permissions };
  });

  app.patch('/:memberId', async (req) => {
    const access = await requireServer(req, PERMISSIONS.MEMBERS_MANAGE);
    const { memberId } = req.params as { memberId: string };
    const body = z.object({ permissions: permissionSchema }).parse(req.body);

    const member = await prisma.serverMember.findFirst({
      where: { id: memberId, serverId: access.server.id },
    });
    if (!member) throw notFound('Mitglied nicht gefunden');

    const updated = await prisma.serverMember.update({
      where: { id: memberId },
      data: { permissions: body.permissions },
      include: { user: { select: { id: true, username: true, email: true } } },
    });

    await audit(req.user!.id, access.server.id, 'member.update', updated.user.username);
    return { id: updated.id, user: updated.user, permissions: updated.permissions };
  });

  app.delete('/:memberId', async (req) => {
    const access = await requireServer(req, PERMISSIONS.MEMBERS_MANAGE);
    const { memberId } = req.params as { memberId: string };

    const member = await prisma.serverMember.findFirst({
      where: { id: memberId, serverId: access.server.id },
      include: { user: { select: { username: true } } },
    });
    if (!member) throw notFound('Mitglied nicht gefunden');

    await prisma.serverMember.delete({ where: { id: memberId } });
    await audit(req.user!.id, access.server.id, 'member.remove', member.user.username);
    return { ok: true };
  });
}
