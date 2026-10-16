import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { User } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { signDownloadToken, signMfaToken } from '../auth/jwt.js';
import { createSession, describeUserAgent } from '../auth/sessions.js';
import { totpSetupRequired } from '../auth/totpPolicy.js';
import { canonicalDownloadPath } from '../auth/downloadPath.js';
import { audit, authenticate, authenticateToken } from '../auth/context.js';
import { HttpError, badRequest, notFound, unauthorized } from '../lib/errors.js';
import { generateRecoveryCodes, hashRecoveryCode, looksLikeRecoveryCode } from '../lib/recoveryCodes.js';
import { generateSecret, otpauthUrl, verifyTotp } from '../lib/totp.js';
import { invalidateSocketAccess } from '../ws/io.js';

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

const loginLimit = {
  rateLimit: {
    max: 8,
    timeWindow: '1 minute',
    // Bewusst dieselbe Meldung fuer jede Adresse: sie darf nicht
    // erkennen lassen, ob hinter den Versuchen ein echtes Konto steht.
    errorResponseBuilder: () =>
      new HttpError(429, 'Zu viele Anmeldeversuche. Bitte warte eine Minute.'),
  },
};

/** Zuletzt verbrauchter Zeitschritt je Konto – ein Code gilt nur einmal. */
const usedTotpSteps = new Map<string, number>();

function checkTotp(user: User, code: string): boolean {
  if (!user.totpSecret) return false;
  const step = verifyTotp(user.totpSecret, code);
  if (step === null) return false;
  if ((usedTotpSteps.get(user.id) ?? -1) >= step) return false;
  usedTotpSteps.set(user.id, step);
  return true;
}

/** Verbraucht einen Wiederherstellungscode – atomar, damit er wirklich nur einmal gilt. */
async function consumeRecoveryCode(user: User, code: string): Promise<boolean> {
  const hash = hashRecoveryCode(code);
  if (!user.totpRecoveryCodes.includes(hash)) return false;
  const count = await prisma.$executeRaw`
    UPDATE "User" SET "totpRecoveryCodes" = array_remove("totpRecoveryCodes", ${hash})
    WHERE id = ${user.id} AND ${hash} = ANY("totpRecoveryCodes")`;
  return count === 1;
}

export function clientInfo(req: FastifyRequest) {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: typeof ua === 'string' ? ua : '' };
}

export async function session(user: User, req: FastifyRequest) {
  return {
    token: await createSession(user, clientInfo(req)),
    user: { id: user.id, email: user.email, username: user.username, role: user.role },
  };
}

/** Alle Geräte abmelden (Passwortwechsel, zweiter Faktor, „überall abmelden“). */
async function revokeAllSessions(userId: string) {
  await prisma.session.deleteMany({ where: { userId } });
  invalidateSocketAccess();
}

/**
 * Sucht das Konto zur Anmeldung. E-Mail ist ohnehin kleingeschrieben; beim
 * Benutzernamen gewinnt der exakte Treffer, sonst zählt die Schreibweise nicht –
 * aber nur, wenn das eindeutig ist (Altbestände könnten `Max` und `max` haben).
 */
async function findLoginUser(login: string): Promise<User | null> {
  const exact = await prisma.user.findFirst({
    where: { OR: [{ email: login.toLowerCase() }, { username: login }] },
  });
  if (exact) return exact;
  const loose = await prisma.user.findMany({
    where: { username: { equals: login, mode: 'insensitive' } },
    take: 2,
  });
  return loose.length === 1 ? loose[0] : null;
}

export default async function authRoutes(app: FastifyInstance) {
  app.post('/login', { config: loginLimit }, async (req) => {
    const { login, password } = loginSchema.parse(req.body);

    const user = await findLoginUser(login);
    const ok = await bcrypt.compare(password, user?.active ? user.passwordHash : dummyHash);
    if (!user || !user.active || !ok) {
      // Ohne Benutzer-ID: der Versuch gehoert zu keiner belegten Anmeldung,
      // der Name steht nur als Text im Protokoll.
      await audit(null, null, 'auth.login.failed', `${login.slice(0, 120)} von ${req.ip}`);
      throw unauthorized('Benutzername oder Passwort falsch');
    }

    if (user.totpEnabled) {
      // Passwort stimmt, die Sitzung gibt es erst mit dem Einmalcode.
      return {
        mfaRequired: true,
        mfaToken: signMfaToken({ sub: user.id, username: user.username, role: user.role, sessionVersion: user.sessionVersion }),
      };
    }

    await audit(user.id, null, 'auth.login', `von ${req.ip}`);
    return session(user, req);
  });

  app.post('/login/totp', { config: loginLimit }, async (req) => {
    const { mfaToken, code } = z.object({ mfaToken: z.string().min(1), code: z.string().min(1).max(24) }).parse(req.body);
    const user = await authenticateToken(mfaToken, { purpose: 'mfa' });
    const recovery = looksLikeRecoveryCode(code);
    const ok = user.totpEnabled && (recovery ? await consumeRecoveryCode(user, code) : checkTotp(user, code));
    if (!ok) {
      await audit(user.id, null, 'auth.login.failed', `falscher ${recovery ? 'Wiederherstellungscode' : 'Einmalcode'} von ${req.ip}`);
      throw unauthorized(recovery ? 'Der Wiederherstellungscode ist ungültig oder schon verbraucht' : 'Der Code ist falsch oder abgelaufen');
    }
    await audit(user.id, null, 'auth.login', `${recovery ? 'mit Wiederherstellungscode' : 'mit zweitem Faktor'} von ${req.ip}`);
    return {
      ...(await session(user, req)),
      ...(recovery ? { usedRecoveryCode: true, recoveryCodesLeft: user.totpRecoveryCodes.length - 1 } : {}),
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
      totpEnabled: user.totpEnabled,
      totpRequired: await totpSetupRequired(user),
      recoveryCodesLeft: user.totpEnabled ? user.totpRecoveryCodes.length : 0,
    };
  });

  app.post('/password', { preHandler: authenticate }, async (req) => {
    const { currentPassword, newPassword } = passwordSchema.parse(req.body);
    const user = req.user!;
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw badRequest('Aktuelles Passwort ist falsch');
    }
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(newPassword, 10), sessionVersion: { increment: 1 } },
    });
    await revokeAllSessions(user.id);
    return { ok: true, token: (await session(updated, req)).token };
  });

  /** Meldet alle Geräte ab; dieses Fenster bekommt ein frisches Token. */
  app.post('/logout-all', { preHandler: authenticate }, async (req) => {
    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: { sessionVersion: { increment: 1 } },
    });
    await revokeAllSessions(updated.id);
    await audit(updated.id, null, 'auth.logout-all', `von ${req.ip}`);
    return { ok: true, token: (await session(updated, req)).token };
  });

  /** Meldet nur dieses Gerät ab. */
  app.post('/logout', { preHandler: authenticate }, async (req) => {
    if (req.sessionId) {
      await prisma.session.deleteMany({ where: { id: req.sessionId, userId: req.user!.id } });
      invalidateSocketAccess();
    }
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Angemeldete Geräte
  // -------------------------------------------------------------------------

  app.get('/sessions', { preHandler: authenticate }, async (req) => {
    const user = req.user!;
    // Zeilen aus einer früheren Sitzungsversion (Passwort per CLI/Admin geändert) sind tot.
    await prisma.session.deleteMany({ where: { userId: user.id, version: { not: user.sessionVersion } } });
    const rows = await prisma.session.findMany({
      where: { userId: user.id, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      device: describeUserAgent(row.userAgent),
      userAgent: row.userAgent,
      ip: row.ip,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt,
      current: row.id === req.sessionId,
    }));
  });

  app.delete('/sessions/:sessionId', { preHandler: authenticate }, async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    const { count } = await prisma.session.deleteMany({ where: { id: sessionId, userId: req.user!.id } });
    if (!count) throw notFound('Sitzung nicht gefunden');
    invalidateSocketAccess();
    const current = sessionId === req.sessionId;
    await audit(req.user!.id, null, 'auth.session.revoke', current ? 'dieses Gerät' : 'anderes Gerät');
    return { ok: true, current };
  });

  /**
   * Kurzlebiger Link für einen Download, den der Browser selbst öffnet (ohne
   * Authorization-Kopfzeile). Gilt nur für genau diese Adresse.
   */
  app.post('/download-token', { preHandler: authenticate }, async (req) => {
    const { path } = z.object({ path: z.string().min(5).max(4000).startsWith('/api/') }).parse(req.body);
    const user = req.user!;
    const bound = canonicalDownloadPath(path);
    const token = signDownloadToken({ sub: user.id, username: user.username, role: user.role, sessionVersion: user.sessionVersion, sid: req.sessionId }, bound);
    return { token };
  });

  // -------------------------------------------------------------------------
  // Zweiter Faktor (TOTP)
  // -------------------------------------------------------------------------

  /** Erzeugt ein neues Geheimnis. Aktiv wird es erst mit einem gültigen Code. */
  app.post('/totp/setup', { preHandler: authenticate }, async (req) => {
    const user = req.user!;
    if (user.totpEnabled) throw badRequest('Der zweite Faktor ist bereits aktiv');
    const secret = generateSecret();
    await prisma.user.update({ where: { id: user.id }, data: { totpSecret: secret } });
    return { secret, url: otpauthUrl(secret, user.username) };
  });

  app.post('/totp/enable', { preHandler: authenticate, config: loginLimit }, async (req) => {
    const { code } = z.object({ code: z.string().min(1).max(12) }).parse(req.body);
    const user = req.user!;
    if (user.totpEnabled) throw badRequest('Der zweite Faktor ist bereits aktiv');
    if (!user.totpSecret) throw badRequest('Bitte zuerst die Einrichtung starten');
    if (!checkTotp(user, code)) throw badRequest('Der Code passt nicht – Uhrzeit des Geräts prüfen');
    // Bestehende Sitzungen ohne zweiten Faktor beenden.
    const { codes, hashes } = generateRecoveryCodes();
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { totpEnabled: true, totpRecoveryCodes: hashes, sessionVersion: { increment: 1 } },
    });
    await revokeAllSessions(user.id);
    await audit(user.id, null, 'auth.totp.enable', '');
    return { ok: true, token: (await session(updated, req)).token, recoveryCodes: codes };
  });

  /** Neue Wiederherstellungscodes; die alten verlieren ihre Gültigkeit. */
  app.post('/totp/recovery-codes', { preHandler: authenticate, config: loginLimit }, async (req) => {
    const { password, code } = z.object({ password: z.string().min(1), code: z.string().min(1).max(12) }).parse(req.body);
    const user = req.user!;
    if (!user.totpEnabled) throw badRequest('Der zweite Faktor ist nicht aktiv');
    if (!(await bcrypt.compare(password, user.passwordHash))) throw badRequest('Passwort ist falsch');
    if (!checkTotp(user, code)) throw badRequest('Der Code ist falsch oder abgelaufen');
    const { codes, hashes } = generateRecoveryCodes();
    await prisma.user.update({ where: { id: user.id }, data: { totpRecoveryCodes: hashes } });
    await audit(user.id, null, 'auth.totp.recovery-codes', 'neu erzeugt');
    return { recoveryCodes: codes };
  });

  app.post('/totp/disable', { preHandler: authenticate, config: loginLimit }, async (req) => {
    const { password, code } = z.object({ password: z.string().min(1), code: z.string().min(1).max(12) }).parse(req.body);
    const user = req.user!;
    if (!user.totpEnabled) throw badRequest('Der zweite Faktor ist nicht aktiv');
    if (!(await bcrypt.compare(password, user.passwordHash))) throw badRequest('Passwort ist falsch');
    if (!checkTotp(user, code)) throw badRequest('Der Code ist falsch oder abgelaufen');
    if (await totpSetupRequired({ ...user, totpEnabled: false })) {
      throw badRequest('Die Zwei-Faktor-Anmeldung ist für dieses Konto vorgeschrieben und kann nicht abgeschaltet werden');
    }
    await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: false, totpSecret: null, totpRecoveryCodes: [] } });
    await audit(user.id, null, 'auth.totp.disable', '');
    return { ok: true };
  });
}
