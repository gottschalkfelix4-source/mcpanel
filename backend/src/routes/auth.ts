import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { signToken } from '../auth/jwt.js';
import { authenticate } from '../auth/context.js';
import { badRequest, unauthorized } from '../lib/errors.js';

const loginSchema = z.object({
  login: z.string().min(1),
  password: z.string().min(1),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Mindestens 8 Zeichen'),
});

export default async function authRoutes(app: FastifyInstance) {
  app.post('/login', async (req) => {
    const { login, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findFirst({
      where: { OR: [{ email: login.toLowerCase() }, { username: login }] },
    });
    if (!user || !user.active) throw unauthorized('Benutzername oder Passwort falsch');

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw unauthorized('Benutzername oder Passwort falsch');

    const token = signToken({ sub: user.id, username: user.username, role: user.role });
    return {
      token,
      user: { id: user.id, email: user.email, username: user.username, role: user.role },
    };
  });

  app.get('/me', { preHandler: authenticate }, async (req) => {
    const user = req.user!;
    const [ownedCount, memberCount] = await Promise.all([
      prisma.server.count({ where: { ownerId: user.id } }),
      prisma.serverMember.count({ where: { userId: user.id } }),
    ]);
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      createdAt: user.createdAt,
      serverCount: ownedCount + memberCount,
    };
  });

  app.post('/password', { preHandler: authenticate }, async (req) => {
    const { currentPassword, newPassword } = passwordSchema.parse(req.body);
    const user = req.user!;
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw badRequest('Aktuelles Passwort ist falsch');
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(newPassword, 10) },
    });
    return { ok: true };
  });
}
