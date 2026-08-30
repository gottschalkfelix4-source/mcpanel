import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { signToken } from '../auth/jwt.js';
import { audit, authenticate } from '../auth/context.js';
import { HttpError, badRequest, unauthorized } from '../lib/errors.js';

const loginSchema = z.object({
  login: z.string().min(1),
  password: z.string().min(1),
});

/**
 * Vergleichshash fuer Anmeldungen ohne passendes Konto. Ohne ihn liefe bcrypt
 * nur bei existierenden Benutzern, und die Antwortzeit verriete, welche Namen
 * es gibt. Gleiche Kostenstufe wie die echten Hashes, damit auch die Dauer passt.
 */
const dummyHash = bcrypt.hashSync('mcpanel-kein-konto', 10);

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Mindestens 8 Zeichen'),
});

export default async function authRoutes(app: FastifyInstance) {
  app.post(
    '/login',
    {
      config: {
        rateLimit: {
          max: 8,
          timeWindow: '1 minute',
          // Bewusst dieselbe Meldung fuer jede Adresse: sie darf nicht
          // erkennen lassen, ob hinter den Versuchen ein echtes Konto steht.
          errorResponseBuilder: () =>
            new HttpError(429, 'Zu viele Anmeldeversuche. Bitte warte eine Minute.'),
        },
      },
    },
    async (req) => {
      const { login, password } = loginSchema.parse(req.body);

      const user = await prisma.user.findFirst({
        where: { OR: [{ email: login.toLowerCase() }, { username: login }] },
      });
      const ok = await bcrypt.compare(password, user?.active ? user.passwordHash : dummyHash);
      if (!user || !user.active || !ok) {
        // Ohne Benutzer-ID: der Versuch gehoert zu keiner belegten Anmeldung,
        // der Name steht nur als Text im Protokoll.
        await audit(null, null, 'auth.login.failed', `${login.slice(0, 120)} von ${req.ip}`);
        throw unauthorized('Benutzername oder Passwort falsch');
      }

      await audit(user.id, null, 'auth.login', `von ${req.ip}`);

      const token = signToken({ sub: user.id, username: user.username, role: user.role });
      return {
        token,
        user: { id: user.id, email: user.email, username: user.username, role: user.role },
      };
    },
  );

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
