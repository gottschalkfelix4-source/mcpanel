import Fastify from 'fastify';
import { beforeEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const m = vi.hoisted(() => ({
  users: {} as Record<string, { id: string; username: string; active: boolean }>,
  memberDelete: vi.fn(), memberCreate: vi.fn(), serverUpdate: vi.fn(), automationUpdate: vi.fn(),
  invalidate: vi.fn(), audit: vi.fn(),
}));

vi.mock('../db.js', () => {
  const tx = {
    serverMember: { deleteMany: m.memberDelete, create: m.memberCreate },
    server: { update: m.serverUpdate },
    automation: { updateMany: m.automationUpdate },
  };
  return { prisma: {
    user: { findUnique: async ({ where }: any) => m.users[where.id] ?? null },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } };
});
vi.mock('../config.js', () => ({ config: {} }));
vi.mock('../auth/context.js', () => ({
  authenticate: async (req: any) => { req.user = { id: req.headers['x-user'] }; },
  requireServer: async (req: any) => ({ isAdmin: req.user.id === 'admin', server: { id: 'srv', ownerId: 'alt' } }),
  getServerAccess: vi.fn(),
  audit: m.audit,
}));
vi.mock('../ws/io.js', () => ({ invalidateSocketAccess: m.invalidate }));
for (const mod of [
  '../services/docker.js', '../services/rcon.js', '../services/consoleCommand.js', '../services/serverManager.js',
  '../services/quota.js', '../services/settings.js', '../services/proxy.js', '../services/operations.js',
  '../services/serverClone.js', '../services/tasks.js', '../services/tickMetrics.js',
]) vi.doMock(mod, () => ({}));
for (const mod of [
  './reinstall.js', './serverImport.js', './files.js', './config.js', './backups.js', './modpacks.js',
  './content.js', './members.js', './automations.js', './notifications.js', './assistant.js',
]) vi.doMock(mod, () => ({ default: async () => {} }));

const { default: serverRoutes } = await import('./servers.js');
const { ALL_PERMISSIONS } = await import('../auth/permissions.js');

async function transfer(user: string, payload: object) {
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof ZodError ? 400 : error.statusCode ?? 500).send({ error: error.message }));
  await app.register(serverRoutes, { prefix: '/servers' });
  try {
    return await app.inject({ method: 'POST', url: '/servers/srv/owner', headers: { 'x-user': user }, payload });
  } finally {
    await app.close();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  m.users = {
    neu: { id: 'neu', username: 'Neu', active: true },
    gesperrt: { id: 'gesperrt', username: 'Gesperrt', active: false },
    alt: { id: 'alt', username: 'Alt', active: true },
  };
});

it('lässt nur Administratoren den Besitzer ändern', async () => {
  const res = await transfer('alt', { userId: 'neu' });
  expect(res.statusCode).toBe(403);
  expect(m.serverUpdate).not.toHaveBeenCalled();
});

it('überträgt den Server und behält den bisherigen Besitzer als Vollmitglied', async () => {
  const res = await transfer('admin', { userId: 'neu' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, owner: { id: 'neu', username: 'Neu' } });
  expect(m.memberDelete).toHaveBeenCalledWith({ where: { serverId: 'srv', userId: 'neu' } });
  expect(m.serverUpdate).toHaveBeenCalledWith({ where: { id: 'srv' }, data: { ownerId: 'neu' } });
  expect(m.memberCreate).toHaveBeenCalledWith({ data: { serverId: 'srv', userId: 'alt', permissions: ALL_PERMISSIONS } });
  expect(m.automationUpdate).not.toHaveBeenCalled();
  expect(m.invalidate).toHaveBeenCalled();
  expect(m.audit).toHaveBeenCalledWith('admin', 'srv', 'server.owner', 'alt → Neu');
});

it('übergibt ohne Mitgliedschaft die Automationen des Altbesitzers an den neuen', async () => {
  const res = await transfer('admin', { userId: 'neu', keepPreviousOwner: false });
  expect(res.statusCode).toBe(200);
  expect(m.memberCreate).not.toHaveBeenCalled();
  expect(m.automationUpdate).toHaveBeenCalledWith({
    where: { serverId: 'srv', createdById: 'alt' }, data: { createdById: 'neu' },
  });
});

it.each([
  ['alt', 'besitzt den Server bereits'],
  ['gesperrt', 'Deaktivierte'],
  ['unbekannt', 'nicht gefunden'],
])('lehnt %s als neuen Besitzer ab', async (userId, message) => {
  const res = await transfer('admin', { userId });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toContain(message);
  expect(m.serverUpdate).not.toHaveBeenCalled();
});
