import Fastify from 'fastify';
import { beforeEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const m = vi.hoisted(() => ({ permissions: [] as string[], add: vi.fn(), remove: vi.fn(), forward: vi.fn(), sync: vi.fn(), schedule: vi.fn() }));
vi.mock('../auth/jwt.js', () => ({ verifyToken: (token: string) => ({ sub: token, sessionVersion: 0 }) }));
vi.mock('../config.js', () => ({ serverDir: (id: string) => '/test/' + id }));
vi.mock('../db.js', () => ({ prisma: {
  user: { findUnique: async ({ where }: any) => ({ id: where.id, role: where.id === 'admin' ? 'ADMIN' : 'USER', active: true, sessionVersion: 0 }) },
  server: { findUnique: async () => ({ id: 'a', name: 'Welt', ownerId: 'besitzer', nodeId: null }) },
  serverMember: { findUnique: async ({ where }: any) => where.serverId_userId.userId === 'mitglied' ? { permissions: m.permissions } : null },
  setting: { findUnique: async () => null },
  auditLog: { create: vi.fn(async () => {}) },
} }));
vi.mock('../services/settings.js', () => ({ getPublicHost: async () => 'mc.example.de', getSetting: async (_k: string, fallback = '') => fallback }));
vi.mock('../services/docker.js', () => ({ getState: async () => ({ state: 'running' }) }));
vi.mock('../services/serverPorts.js', () => ({
  MANUAL_SOURCE: 'manual',
  listServerPorts: async () => [{ id: 'p1', label: 'Simple Voice Chat', source: 'voicechat', protocol: 'udp', hostPort: 24454, containerPort: 24454, forward: true }],
  syncServerPorts: m.sync, addManualPort: m.add, removeManualPort: m.remove, setPortForward: m.forward,
}));
vi.mock('../services/unifi.js', () => ({
  getUnifiConfig: async () => ({ enabled: false }), lastSyncStatus: () => null,
  ruleName: (s: string, l: string) => `MCPanel ${s} ${l}`, scheduleUnifiSync: m.schedule,
}));
import portRoutes from './ports.js';
import { authenticate } from '../auth/context.js';

beforeEach(() => {
  vi.clearAllMocks(); m.permissions = [];
  m.sync.mockResolvedValue({ ports: [], changed: true, notes: ['Simple Voice Chat erkannt'] });
  m.add.mockResolvedValue({ id: 'p2' }); m.forward.mockResolvedValue({ label: 'x' });
});

async function call(user: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url = '', payload?: unknown) {
  const app = Fastify();
  app.addHook('preHandler', authenticate);
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof ZodError ? 400 : error.statusCode ?? 500).send({ error: error.message }));
  await app.register(portRoutes, { prefix: '/servers/:id/ports' });
  try { return await app.inject({ method, url: '/servers/a/ports' + url, headers: { authorization: 'Bearer ' + user }, payload: payload as any }); }
  finally { await app.close(); }
}

it('zeigt jedem mit Serverzugriff die Ports samt Adresse', async () => {
  m.permissions = ['console.read'];
  const res = await call('mitglied', 'GET');
  expect(res.statusCode).toBe(200);
  expect(res.json().ports[0]).toMatchObject({ hostPort: 24454, address: 'mc.example.de:24454', router: 'disabled', manual: false });
  expect((await call('fremd', 'GET')).statusCode).toBe(404);
});

it('verlangt für die Erkennung das Einstellungsrecht und meldet einen nötigen Neustart', async () => {
  expect((await call('mitglied', 'POST', '/detect')).statusCode).toBe(403);
  m.permissions = ['settings.edit'];
  const res = await call('mitglied', 'POST', '/detect');
  expect(res.json()).toMatchObject({ restartNeeded: true, notes: ['Simple Voice Chat erkannt'] });
  expect(m.schedule).toHaveBeenCalled();
});

it('überlässt eigene Ports und Router-Freigaben Administratoren – auch dem Besitzer nicht', async () => {
  const body = { label: 'Eigene Mod', protocol: 'tcp', hostPort: 9000 };
  expect((await call('besitzer', 'POST', '', body)).statusCode).toBe(403);
  expect((await call('besitzer', 'PATCH', '/p1', { forward: false })).statusCode).toBe(403);
  expect((await call('besitzer', 'DELETE', '/p1')).statusCode).toBe(403);
  expect(m.add).not.toHaveBeenCalled(); expect(m.forward).not.toHaveBeenCalled(); expect(m.remove).not.toHaveBeenCalled();

  expect((await call('admin', 'POST', '', body)).statusCode).toBe(200);
  expect((await call('admin', 'POST', '', { ...body, hostPort: 80 })).statusCode).toBe(400);
  expect((await call('admin', 'PATCH', '/p1', { forward: false })).statusCode).toBe(200);
  expect(m.forward).toHaveBeenCalledWith('a', 'p1', false);
  expect(m.schedule).toHaveBeenCalledTimes(2);
});
