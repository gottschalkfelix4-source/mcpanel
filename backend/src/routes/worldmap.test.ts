import Fastify from 'fastify';
import { beforeEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const m = vi.hoisted(() => ({ permissions: [] as string[], start: vi.fn(), install: vi.fn() }));
vi.mock('../auth/jwt.js', () => ({ verifyToken: (token: string) => ({ sub: token, sessionVersion: 0 }) }));
vi.mock('../config.js', () => ({ serverDir: (id: string) => '/test/' + id, config: { jwtSecret: 'x' } }));
vi.mock('../db.js', () => ({ prisma: {
  user: { findUnique: async ({ where }: any) => ({ id: where.id, role: where.id === 'admin' ? 'ADMIN' : 'USER', active: true, sessionVersion: 0 }) },
  server: { findUnique: async () => ({ id: 'a', name: 'Welt', type: 'FABRIC', mcVersion: '1.21.1', extraEnv: {}, ownerId: 'besitzer' }) },
  serverMember: { findUnique: async ({ where }: any) => where.serverId_userId.userId === 'mitglied' ? { permissions: m.permissions } : null },
  setting: { findUnique: async () => null },
  auditLog: { create: vi.fn(async () => {}) },
} }));
vi.mock('../services/mapAddons.js', () => ({
  ADDONS: { chunky: { label: 'Chunky' }, bluemap: { label: 'BlueMap' } },
  addonState: async () => ({ installed: true, file: 'x.jar', available: null }),
  installAddon: m.install, installedAddon: async () => 'x.jar', acceptBlueMapDownload: async () => 'missing',
}));
vi.mock('../services/pregen.js', async (original) => ({
  ...(await original<object>()),
  startPregen: m.start, getMapSettings: async () => ({ job: null, bluemapAccepted: false }), saveMapSettings: vi.fn(),
}));
vi.mock('../services/quota.js', () => ({ remainingDiskBytes: async () => Infinity }));
vi.mock('../services/docker.js', () => ({ getState: async () => ({ state: 'stopped' }) }));
vi.mock('../services/tasks.js', () => ({ runTask: async (_id: string, _t: string, fn: Function) => { await fn({ update: vi.fn(), log: vi.fn() }); return 'aufgabe'; } }));
vi.mock('../services/operations.js', () => ({ withServerOperation: (_id: string, _l: string, fn: Function) => fn() }));
import worldMapRoutes from './worldmap.js';
import { authenticate } from '../auth/context.js';

beforeEach(() => { vi.clearAllMocks(); m.permissions = []; m.start.mockResolvedValue({ status: 'running' }); m.install.mockResolvedValue('chunky.jar'); });

async function call(user: string, method: 'GET' | 'POST', url = '', payload?: unknown) {
  const app = Fastify();
  app.addHook('preHandler', authenticate);
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof ZodError ? 400 : error.statusCode ?? 500).send({ error: error.message }));
  await app.register(worldMapRoutes, { prefix: '/servers/:id/map' });
  try { return await app.inject({ method, url: '/servers/a/map' + url, headers: { authorization: 'Bearer ' + user }, payload: payload as any }); }
  finally { await app.close(); }
}

it('zeigt die Karte allen mit Konsolenrecht, Vorgenerierung nur mit eigenem Recht', async () => {
  expect((await call('mitglied', 'GET')).statusCode).toBe(403);
  m.permissions = ['console.read'];
  const res = await call('mitglied', 'GET');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ canPregen: false, loader: 'FABRIC' });
  expect((await call('mitglied', 'POST', '/pregen', { radius: 2000 })).statusCode).toBe(403);
  expect((await call('mitglied', 'POST', '/addons', { chunky: true })).statusCode).toBe(403);
  expect(m.start).not.toHaveBeenCalled();

  m.permissions = ['console.read', 'world.pregen'];
  expect((await call('mitglied', 'POST', '/pregen', { radius: 2000 })).statusCode).toBe(200);
  expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), expect.objectContaining({ radius: 2000, shape: 'circle', dimension: 'overworld' }), 'mitglied');
});

it('Besitzer haben das neue Recht automatisch; ungültige Bereiche werden abgelehnt', async () => {
  expect((await call('besitzer', 'POST', '/pregen', { radius: 10 })).statusCode).toBe(400);
  expect((await call('besitzer', 'POST', '/pregen', { radius: 2000, centerX: 40_000_000 })).statusCode).toBe(400);
  expect((await call('besitzer', 'POST', '/pregen', { radius: 2000 })).statusCode).toBe(200);
});

it('installiert BlueMap nur mit Zustimmung zum Mojang-Download', async () => {
  expect((await call('besitzer', 'POST', '/addons', { bluemap: true })).statusCode).toBe(400);
  expect((await call('besitzer', 'POST', '/addons', { bluemap: true, chunky: true, acceptDownload: true })).statusCode).toBe(200);
  expect(m.install.mock.calls.map((c) => c[1])).toEqual(['chunky', 'bluemap']);
});
