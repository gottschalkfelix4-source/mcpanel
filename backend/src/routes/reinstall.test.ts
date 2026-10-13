import Fastify from 'fastify';
import { beforeEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
const m = vi.hoisted(() => ({ permissions: [] as string[], install: vi.fn() }));
vi.mock('../auth/jwt.js', () => ({ verifyToken: (token: string) => ({ sub: token, sessionVersion: 0 }) }));
vi.mock('../config.js', () => ({ serverDir: (id: string) => '/test/' + id }));
vi.mock('../db.js', () => ({ prisma: {
  user: { findUnique: async ({ where }: any) => ({ id: where.id, role: where.id === 'admin' ? 'ADMIN' : 'USER', active: true, sessionVersion: 0 }) },
  server: { findUnique: async () => ({ id: 'a', ownerId: 'besitzer', quotaMemoryMb: 4096 }) },
  serverMember: { findUnique: async ({ where }: any) => where.serverId_userId.userId === 'mitglied' ? { permissions: m.permissions } : null },
  auditLog: { create: vi.fn(async () => {}) },
} }));
vi.mock('../services/serverReinstall.js', () => ({ reinstallServer: m.install }));
vi.mock('../services/tasks.js', () => ({ runTask: async (_id: string, _type: string, fn: Function) => { await fn({ id: 'aufgabe' }); return 'aufgabe'; } }));
import reinstallRoutes from './reinstall.js';
import { authenticate } from '../auth/context.js';
const payload = { name: 'Server', type: 'PAPER', mcVersion: '1.21.1', memoryMb: 2048 };
beforeEach(() => { vi.clearAllMocks(); m.permissions = []; });
async function call(user: string | null, body: any = payload) {
  const app = Fastify();
  app.addHook('preHandler', authenticate);
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof ZodError ? 400 : error.statusCode ?? 500).send({ error: error.message }));
  await app.register(reinstallRoutes, { prefix: '/servers/:id/reinstall' });
  try { return await app.inject({ method: 'POST', url: '/servers/a/reinstall', headers: user ? { authorization: 'Bearer ' + user } : {}, payload: body }); }
  finally { await app.close(); }
}
it.each(['besitzer', 'admin'])('erlaubt dem %s die Neuinstallation ohne zusätzlich vergebene Mitgliedsrechte', async user => {
  expect((await call(user)).statusCode).toBe(200);
  expect(m.install).toHaveBeenCalledWith('a', expect.objectContaining({ keepWorld: true, startAfter: false }), expect.anything(), expect.objectContaining({ id: user }));
});
it('erlaubt eingeladenen Mitgliedern das ausdrücklich vergebene Neuinstallationsrecht', async () => {
  m.permissions = ['server.reinstall']; expect((await call('mitglied')).statusCode).toBe(200);
});
it('verlangt das Neuinstallationsrecht auch bei vorhandenen Einstellungs- oder Modpack-Rechten', async () => {
  m.permissions = ['settings.edit', 'modpack.manage']; expect((await call('mitglied')).statusCode).toBe(403);
  expect(m.install).not.toHaveBeenCalled();
});
it('prüft einen Rechteentzug bei der nächsten Anfrage erneut', async () => {
  m.permissions = ['server.reinstall']; expect((await call('mitglied')).statusCode).toBe(200);
  m.permissions = []; expect((await call('mitglied')).statusCode).toBe(403);
  expect(m.install).toHaveBeenCalledTimes(1);
});
it('verweigert nicht eingeladenen und nicht angemeldeten Nutzern den Zugriff', async () => {
  expect((await call('fremd')).statusCode).toBe(404); expect((await call(null)).statusCode).toBe(401);
  expect(m.install).not.toHaveBeenCalled();
});
it('verhindert das Umgehen von Kontingenten und administrativen Feldern', async () => {
  expect((await call('besitzer', { ...payload, memoryMb: 8192 })).statusCode).toBe(400);
  expect((await call('besitzer', { ...payload, quotaMemoryMb: 0 })).statusCode).toBe(400);
  expect((await call('besitzer', { ...payload, extraEnv: { MC_IMAGE: 'fremd' } })).statusCode).toBe(400);
  expect(m.install).not.toHaveBeenCalled();
});
it('verlangt eine Modpack-Auswahl und weist eine unpassende Auswahl beim normalen Server ab', async () => {
  expect((await call('besitzer', { ...payload, type: 'MODPACK' })).statusCode).toBe(400);
  expect((await call('besitzer', { ...payload, modpack: { provider: 'modrinth', projectId: 'pack', versionId: 'v' } })).statusCode).toBe(400);
});
