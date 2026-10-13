import Fastify from 'fastify';
import { beforeEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
const m = vi.hoisted(() => ({ role: 'ADMIN', create: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock('../auth/jwt.js', () => ({ verifyToken: (token: string) => ({ sub: token, sessionVersion: 0 }) }));
vi.mock('../db.js', () => ({ prisma: {
  user: {
    findUnique: async ({ where }: any) => ({ id: where.id, username: where.id, role: where.id === 'admin' ? m.role : 'USER', active: true, sessionVersion: 0 }),
    findFirst: async () => ({ id: 'neu', username: 'Neu' }),
  },
  server: { findUnique: async () => ({ id: 'a', ownerId: 'besitzer' }) },
  serverMember: {
    findUnique: async ({ where }: any) => where.serverId_userId.userId === 'mitglied' ? { permissions: ['members.manage', 'power'] } : null,
    findMany: async () => [{ id: 'selbst', user: { id: 'mitglied' }, permissions: ['members.manage', 'power'] }],
    findFirst: async ({ where }: any) => where.serverId === 'a' && ['selbst', 'anderer'].includes(where.id) ? { id: where.id, userId: 'mitglied', user: { username: 'Mitglied' } } : null,
    create: m.create, update: m.update, delete: m.remove,
  },
  auditLog: { create: vi.fn(async () => {}) },
} }));
import memberRoutes from './members.js';
import { authenticate, getServerAccess } from '../auth/context.js';

beforeEach(() => {
  vi.clearAllMocks(); m.role = 'ADMIN';
  m.create.mockResolvedValue({ id: 'neu', user: { username: 'Neu' }, permissions: ['power'] });
  m.update.mockResolvedValue({ id: 'selbst', user: { username: 'Mitglied' }, permissions: ['power'] });
  m.remove.mockResolvedValue({});
});
async function call(user: string | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', suffix = '', payload?: object) {
  const app = Fastify();
  app.addHook('preHandler', authenticate);
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof ZodError ? 400 : error.statusCode ?? 500).send({ error: error.message }));
  await app.register(memberRoutes, { prefix: '/servers/:id/members' });
  try { return await app.inject({ method, url: '/servers/a/members/' + suffix, headers: user ? { authorization: 'Bearer ' + user } : {}, payload }); }
  finally { await app.close(); }
}

it.each(['besitzer', 'mitglied', 'fremd'])('verweigert %s sämtliche Rechteänderungen einschließlich eigener Rechte trotz Altberechtigung', async user => {
  expect((await call(user, 'POST', '', { user: 'Neu', permissions: ['power'] })).statusCode).toBe(403);
  for (const target of ['selbst', 'anderer']) {
    expect((await call(user, 'PATCH', target, { permissions: ['server.reinstall'] })).statusCode).toBe(403);
    expect((await call(user, 'DELETE', target)).statusCode).toBe(403);
  }
  expect(m.create).not.toHaveBeenCalled(); expect(m.update).not.toHaveBeenCalled(); expect(m.remove).not.toHaveBeenCalled();
});

it.each(['besitzer', 'mitglied'])('liefert %s nur lesenden Zugriff ohne delegierbares Verwaltungsrecht', async user => {
  const response = await call(user, 'GET');
  expect(response.statusCode).toBe(200);
  expect(response.json().canManage).toBe(false);
  expect(response.json().availablePermissions.map((p: any) => p.key)).not.toContain('members.manage');
  expect(response.json().members[0].permissions).toEqual(['power']);
  const access = await getServerAccess({ id: user, role: 'USER' } as any, 'a');
  expect(access.permissions).not.toContain('members.manage');
  expect(access.can('members.manage')).toBe(false);
  expect(access.can('power')).toBe(true);
});

it('erlaubt Administratoren weiterhin das Erteilen, Ändern und Entziehen von Rechten', async () => {
  expect((await call('admin', 'GET')).json().canManage).toBe(true);
  expect((await call('admin', 'POST', '', { user: 'Neu', permissions: ['power'] })).statusCode).toBe(200);
  expect((await call('admin', 'PATCH', 'selbst', { permissions: ['power'] })).statusCode).toBe(200);
  expect((await call('admin', 'DELETE', 'selbst')).statusCode).toBe(200);
  expect(m.create).toHaveBeenCalledTimes(1); expect(m.update).toHaveBeenCalledTimes(1); expect(m.remove).toHaveBeenCalledTimes(1);
});

it('weist die Delegation der Mitgliederverwaltung auch durch Administratoren zurück', async () => {
  expect((await call('admin', 'POST', '', { user: 'Neu', permissions: ['members.manage'] })).statusCode).toBe(400);
  expect((await call('admin', 'PATCH', 'selbst', { permissions: ['members.manage'] })).statusCode).toBe(400);
  expect(m.create).not.toHaveBeenCalled(); expect(m.update).not.toHaveBeenCalled();
});

it('prüft die Administratorrolle bei jeder Anfrage frisch und verlangt eine Anmeldung', async () => {
  expect((await call('admin', 'PATCH', 'selbst', { permissions: ['power'] })).statusCode).toBe(200);
  m.role = 'USER';
  expect((await call('admin', 'PATCH', 'selbst', { permissions: ['power'] })).statusCode).toBe(403);
  expect((await call(null, 'PATCH', 'selbst', { permissions: ['power'] })).statusCode).toBe(401);
  expect(m.update).toHaveBeenCalledTimes(1);
});
