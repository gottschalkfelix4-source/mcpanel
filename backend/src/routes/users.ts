import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { audit, authenticate, requireAdmin } from '../auth/context.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { invalidateSocketAccess } from '../ws/io.js';

const usernameSchema = z.string().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/, 'Nur Buchstaben, Zahlen, . _ -');

const createSchema = z.object({
  email: z.string().email(),
  username: usernameSchema,
  password: z.string().min(8),
  role: z.enum(['ADMIN', 'USER']).default('USER'),
});

const updateSchema = z.object({
  email: z.string().email().optional(),
  username: usernameSchema.optional(),
  password: z.string().min(8).optional(),
  role: z.enum(['ADMIN', 'USER']).optional(),
  active: z.boolean().optional(),
  /** Zweiten Faktor zurücksetzen, wenn jemand sein Gerät verloren hat. */
  resetTotp: z.literal(true).optional(),
});

/** `Max` und `max` wären für Menschen dasselbe Konto – also nicht zulassen. */
async function assertUnique(email: string | undefined, username: string | undefined, exceptId?: string) {
  const or = [
    ...(email ? [{ email: email.toLowerCase() }] : []),
    ...(username ? [{ username: { equals: username, mode: 'insensitive' as const } }] : []),
  ];
  if (!or.length) return;
  const existing = await prisma.user.findFirst({
    where: { OR: or, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
  });
  if (existing) throw conflict('E-Mail oder Benutzername ist bereits vergeben');
}

const publicUser = {
  id: true,
  email: true,
  username: true,
  role: true,
  active: true,
  totpEnabled: true,
  createdAt: true,
} as const;

export default async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  /** Mitglieder dürfen ausschließlich Administratoren auswählen. */
  app.get('/directory', { preHandler: requireAdmin }, async () => {
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
    await assertUnique(data.email, data.username);

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

    await assertUnique(data.email, data.username, userId);
    const passwordHash = data.password ? await bcrypt.hash(data.password, 10) : undefined;

    // Prüfung und Änderung in einer Transaktion unter Tabellensperre: zwei
    // gleichzeitige Herabstufungen dürfen nicht beide „es gibt noch einen
    // anderen Admin“ sehen und das Panel ohne Administrator zurücklassen.
    const user = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE`;
      const target = await tx.user.findUnique({ where: { id: userId } });
      if (!target) throw notFound('Benutzer nicht gefunden');

      if (target.role === 'ADMIN' && target.active && (data.role === 'USER' || data.active === false)) {
        const admins = await tx.user.count({ where: { role: 'ADMIN', active: true } });
        if (admins <= 1) throw badRequest('Der letzte aktive Administrator kann nicht geändert werden');
      }

      return tx.user.update({
        where: { id: userId },
        data: {
          ...(data.email ? { email: data.email.toLowerCase() } : {}),
          ...(data.username ? { username: data.username } : {}),
          ...(data.role ? { role: data.role } : {}),
          ...(data.active !== undefined ? { active: data.active } : {}),
          ...(data.resetTotp ? { totpEnabled: false, totpSecret: null } : {}),
          ...(passwordHash ? { passwordHash, sessionVersion: { increment: 1 } } : {}),
        },
        select: publicUser,
      });
    });
    invalidateSocketAccess();
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
    invalidateSocketAccess();
    await audit(req.user!.id, null, 'user.delete', target.username);
    return { ok: true };
  });
}
