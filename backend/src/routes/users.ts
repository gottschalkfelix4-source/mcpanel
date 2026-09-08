import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { audit, authenticate, requireAdmin } from '../auth/context.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

const createSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/, 'Nur Buchstaben, Zahlen, . _ -'),
  password: z.string().min(8),
  role: z.enum(['ADMIN', 'USER']).default('USER'),
});

const updateSchema = z.object({
  email: z.string().email().optional(),
  username: z.string().min(3).max(32).optional(),
  password: z.string().min(8).optional(),
  role: z.enum(['ADMIN', 'USER']).optional(),
  active: z.boolean().optional(),
});

const publicUser = {
  id: true,
  email: true,
  username: true,
  role: true,
  active: true,
  createdAt: true,
} as const;

export default async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  /** Schlanke Liste für Mitglieder-Auswahl – für alle angemeldeten Nutzer. */
  app.get('/directory', async () => {
    const users = await prisma.user.findMany({
      where: { active: true },
      select: { id: true, username: true },
      orderBy: { username: 'asc' },
    });
    return users;
  });

  app.get('/', { preHandler: requireAdmin }, async () => {
    return prisma.user.findMany({
      select: { ...publicUser, _count: { select: { ownedServers: true, memberships: true } } },
      orderBy: { createdAt: 'asc' },
    });
  });

  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const existing = await prisma.user.findFirst({
      where: { OR: [{ email: data.email.toLowerCase() }, { username: data.username }] },
    });
    if (existing) throw conflict('E-Mail oder Benutzername ist bereits vergeben');

    const user = await prisma.user.create({
      data: {
        email: data.email.toLowerCase(),
        username: data.username,
        role: data.role,
        passwordHash: await bcrypt.hash(data.password, 10),
      },
      select: publicUser,
    });
    await audit(req.user!.id, null, 'user.create', user.username);
    reply.code(201);
    return user;
  });

  app.patch('/:userId', { preHandler: requireAdmin }, async (req) => {
    const { userId } = req.params as { userId: string };
    const data = updateSchema.parse(req.body);

    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw notFound('Benutzer nicht gefunden');

    if (target.role === 'ADMIN' && (data.role === 'USER' || data.active === false)) {
      const admins = await prisma.user.count({ where: { role: 'ADMIN', active: true } });
      if (admins <= 1) throw badRequest('Der letzte aktive Administrator kann nicht geändert werden');
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.email ? { email: data.email.toLowerCase() } : {}),
        ...(data.username ? { username: data.username } : {}),
        ...(data.role ? { role: data.role } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
        ...(data.password ? { passwordHash: await bcrypt.hash(data.password, 10), sessionVersion: { increment: 1 } } : {}),
      },
      select: publicUser,
    });
    await audit(req.user!.id, null, 'user.update', user.username);
    return user;
  });

  app.delete('/:userId', { preHandler: requireAdmin }, async (req) => {
    const { userId } = req.params as { userId: string };
    if (userId === req.user!.id) throw badRequest('Du kannst dich nicht selbst löschen');

    const target = await prisma.user.findUnique({
      where: { id: userId },
      include: { _count: { select: { ownedServers: true } } },
    });
    if (!target) throw notFound('Benutzer nicht gefunden');
    if (target._count.ownedServers > 0) {
      throw badRequest('Benutzer besitzt noch Server – bitte zuerst übertragen oder löschen');
    }

    await prisma.user.delete({ where: { id: userId } });
    await audit(req.user!.id, null, 'user.delete', target.username);
    return { ok: true };
  });
}
