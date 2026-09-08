import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Server, User } from '@prisma/client';
import { prisma } from '../db.js';
import { verifyToken } from './jwt.js';
import { ALL_PERMISSIONS, type Permission } from './permissions.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const q = (req.query as Record<string, string> | undefined)?.token;
  return q ?? null;
}

/** preHandler: erzwingt einen gültigen Login. */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  const token = extractToken(req);
  if (!token) throw unauthorized();
  req.user = await authenticateToken(token);
}

export async function authenticateToken(token: string): Promise<User> {
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    throw unauthorized('Sitzung abgelaufen');
  }
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || !user.active) throw unauthorized('Konto deaktiviert');
  if ((payload.sessionVersion ?? 0) !== user.sessionVersion) throw unauthorized('Sitzung widerrufen');
  return user;
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
