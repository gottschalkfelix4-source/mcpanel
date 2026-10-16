import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Server, User } from '@prisma/client';
import { prisma } from '../db.js';
import { verifyToken } from './jwt.js';
import { canonicalDownloadPath } from './downloadPath.js';
import { ALL_PERMISSIONS, PERMISSIONS, type Permission } from './permissions.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';
import { touchSession } from './sessions.js';
import { allowedWithoutTotp, totpSetupRequired, TOTP_REQUIRED_MESSAGE } from './totpPolicy.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    /** Gerätesitzung des Tokens, falls es eine trägt. */
    sessionId?: string;
  }
}

function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/** preHandler: erzwingt einen gültigen Login. */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  const token = extractToken(req);
  if (token) {
    const { user, sessionId } = await authenticateSession(token);
    req.user = user;
    req.sessionId = sessionId;
    await enforceTotpPolicy(user, req.url);
    return;
  }
  // Downloads öffnet der Browser selbst, ohne Kopfzeile. Dafür gibt es ein
  // kurzlebiges Token, das nur genau diese Adresse aufschließt – nie das
  // Sitzungstoken in der URL, das in Verläufen und Proxy-Protokollen landet.
  const queryToken = (req.query as Record<string, unknown> | undefined)?.token;
  if ((req.method === 'GET' || req.method === 'HEAD') && typeof queryToken === 'string') {
    req.user = await authenticateToken(queryToken, { purpose: 'download', path: canonicalDownloadPath(req.url) });
    await enforceTotpPolicy(req.user, req.url);
    return;
  }
  throw unauthorized();
}

/**
 * Ist der zweite Faktor vorgeschrieben und noch nicht eingerichtet, bleibt nur
 * der Weg zur Einrichtung offen.
 */
export async function enforceTotpPolicy(user: User, url: string | null): Promise<void> {
  if (user.totpEnabled) return;
  if (url !== null && allowedWithoutTotp(url)) return;
  if (await totpSetupRequired(user)) throw forbidden(TOTP_REQUIRED_MESSAGE);
}

export async function authenticateToken(
  token: string,
  expect: { purpose?: 'download' | 'mfa'; path?: string } = {},
): Promise<User> {
  return (await authenticateSession(token, expect)).user;
}

/** Wie authenticateToken, liefert zusätzlich die Gerätesitzung des Tokens. */
export async function authenticateSession(
  token: string,
  expect: { purpose?: 'download' | 'mfa'; path?: string } = {},
): Promise<{ user: User; sessionId?: string }> {
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    throw unauthorized('Sitzung abgelaufen');
  }
  if (payload.purpose !== expect.purpose) throw unauthorized('Ungültiges Token');
  if (expect.purpose === 'download' && payload.path !== expect.path) throw unauthorized('Download-Link gilt nicht für diese Adresse');
  let user: User | null;
  if (payload.sid) {
    // Sitzung und Konto in einer Abfrage: eine gelöschte Zeile = abgemeldetes Gerät.
    const session = await prisma.session.findUnique({ where: { id: payload.sid }, include: { user: true } });
    if (!session || session.userId !== payload.sub || session.expiresAt < new Date()) throw unauthorized('Sitzung widerrufen');
    user = session.user;
  } else {
    user = await prisma.user.findUnique({ where: { id: payload.sub } });
  }
  if (!user || !user.active) throw unauthorized('Konto deaktiviert');
  if ((payload.sessionVersion ?? 0) !== user.sessionVersion) throw unauthorized('Sitzung widerrufen');
  if (payload.sid && !payload.purpose) touchSession(payload.sid);
  return { user, sessionId: payload.sid };
}

export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply) {
  if (req.user?.role !== 'ADMIN') throw forbidden('Nur für Administratoren');
}

export interface ServerAccess {
  server: Server;
  permissions: Permission[];
  isOwner: boolean;
  isAdmin: boolean;
  can(permission: Permission): boolean;
}

/** Lädt einen Server und die effektiven Rechte des Nutzers darauf. */
export async function getServerAccess(user: User, serverId: string): Promise<ServerAccess> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) throw notFound('Server nicht gefunden');

  const isAdmin = user.role === 'ADMIN';
  const isOwner = server.ownerId === user.id;

  let permissions: Permission[] = [];
  if (isAdmin || isOwner) {
    permissions = [...ALL_PERMISSIONS];
  } else {
    const member = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId, userId: user.id } },
    });
    if (!member) throw notFound('Server nicht gefunden');
    permissions = member.permissions as Permission[];
  }

  // Mitgliederverwaltung ist nicht delegierbar, auch nicht an Besitzer oder
  // Mitglieder mit einem früher gespeicherten members.manage-Recht.
  if (!isAdmin) permissions = permissions.filter((p) => p !== PERMISSIONS.MEMBERS_MANAGE);

  return {
    server,
    permissions,
    isOwner,
    isAdmin,
    can: (p) => permissions.includes(p),
  };
}

/** Wie getServerAccess, wirft aber zusätzlich bei fehlendem Recht. */
export async function requireServer(
  req: FastifyRequest,
  permission?: Permission,
): Promise<ServerAccess> {
  const { id } = req.params as { id: string };
  const access = await getServerAccess(req.user!, id);
  if (permission && !access.can(permission)) {
    throw forbidden(`Dir fehlt das Recht "${permission}"`);
  }
  return access;
}

export async function audit(
  userId: string | null,
  serverId: string | null,
  action: string,
  detail = '',
) {
  await prisma.auditLog.create({ data: { userId, serverId, action, detail } }).catch(() => {});
}
