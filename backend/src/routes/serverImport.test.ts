import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ root: '', create: vi.fn(), inspect: vi.fn(), install: vi.fn(), member: vi.fn() }));
vi.mock('../config.js', () => ({ cacheDir: () => m.root, serverDir: () => m.root }));
vi.mock('../auth/jwt.js', () => ({ verifyToken: (token: string) => ({ sub: token, sessionVersion: 0 }) }));
vi.mock('../db.js', () => ({ prisma: {
  user: { findUnique: async ({ where }: any) => ({ id: where.id, role: where.id === 'admin' ? 'ADMIN' : 'USER', active: true, sessionVersion: 0 }) },
  server: { findUnique: async ({ where }: any) => where.id === 'bestehend' ? { id: 'bestehend', ownerId: 'besitzer', quotaMemoryMb: 4096 } : null },
  serverMember: { findUnique: m.member },
  setting: { findUnique: async () => null },
  auditLog: { create: async () => {} },
} }));
vi.mock('../services/serverManager.js', () => ({ createServer: m.create }));
vi.mock('../services/docker.js', () => ({}));
vi.mock('../services/serverStartup.js', () => ({}));
vi.mock('../services/diskUsage.js', () => ({}));
vi.mock('../services/serverImport.js', async original => ({ ...await original<object>(), inspectServerZip: m.inspect, importServerZip: m.install }));
vi.mock('../services/tasks.js', () => ({ runTask: async (_id: string, _type: string, fn: Function) => { await fn({ id: 'aufgabe' }); return 'aufgabe'; } }));
import { authenticate } from '../auth/context.js';
import routes from './serverImport.js';
const query = '?name=Testserver&type=PAPER&mcVersion=1.20.1';
const body = (filename = 'server.zip') => `--grenze\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\nZIP-Inhalt\r\n--grenze--\r\n`;
beforeEach(async () => { vi.clearAllMocks(); m.member.mockImplementation(async ({ where }: any) => where.serverId_userId.userId === 'verwalter' ? { permissions: ['server.reinstall'] } : where.serverId_userId.userId === 'mitglied' ? { permissions: ['files.read'] } : null); m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-import-route-')); m.create.mockResolvedValue({ id: 'neu' }); m.inspect.mockResolvedValue({ entries: [], bytes: 4, root: '' }); });
afterEach(async () => fs.rm(m.root, { recursive: true, force: true }));
async function call(user: string | null, payload = body(), suffix = query, target = '/import') {
  const app = Fastify(); await app.register(multipart); app.addHook('preHandler', authenticate);
  app.setErrorHandler((err, _req, reply) => reply.code(err instanceof ZodError ? 400 : err.statusCode ?? 500).send({ error: err.message }));
  await app.register(routes, { prefix: '/servers' });
  try { return await app.inject({ method: 'POST', url: '/servers' + target + suffix, headers: { 'content-type': 'multipart/form-data; boundary=grenze', ...(user ? { authorization: 'Bearer ' + user } : {}) }, payload }); }
  finally { await app.close(); }
}
it.each([null, 'mitglied', 'besitzer'])('verweigert den Import ohne Administratorrecht: %s', async user => {
  expect((await call(user)).statusCode).toBe(user ? 403 : 401);
  expect(m.create).not.toHaveBeenCalled(); expect(m.inspect).not.toHaveBeenCalled();
});
it('legt nach geprüftem Upload ausschließlich einen neuen Server für den angemeldeten Admin an', async () => {
  const response = await call('admin'); expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ id: 'neu', taskId: 'aufgabe' });
  expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'admin', name: 'Testserver', mcVersion: '1.20.1', type: 'PAPER' }));
  expect(m.install).toHaveBeenCalledWith('neu', expect.any(String), expect.any(Object), expect.objectContaining({ startAfter: false }), expect.anything());
  expect(await fs.readdir(path.join(m.root, 'server-import'))).toEqual([]);
});
it('räumt abgelehnte Uploads auf und erstellt keinen Server', async () => {
  expect((await call('admin', body('server.tar.gz'))).statusCode).toBe(400);
  expect(m.create).not.toHaveBeenCalled(); expect(await fs.readdir(path.join(m.root, 'server-import'))).toEqual([]);
});
it('lehnt fremde Server-IDs und Besitzerfelder ab', async () => {
  expect((await call('admin', body(), query + '&serverId=bestehend&ownerId=fremd')).statusCode).toBe(400);
  expect(m.create).not.toHaveBeenCalled();
});
it('erstellt bei ungültigem Archiv keinen Server und entfernt die temporäre Datei', async () => {
  m.inspect.mockRejectedValueOnce(Object.assign(new Error('Ungültiges ZIP'), { statusCode: 400 }));
  expect((await call('admin')).statusCode).toBe(400); expect(m.create).not.toHaveBeenCalled();
  expect(await fs.readdir(path.join(m.root, 'server-import'))).toEqual([]);
});
it('verweigert mehrere ZIPs in derselben Anfrage', async () => {
  const payload = body().replace('--grenze--\r\n', '') + body();
  expect((await call('admin', payload)).statusCode).toBe(413);
  expect(m.create).not.toHaveBeenCalled();
});

it.each(['besitzer', 'verwalter', 'admin'])('erlaubt ZIP-Import auf zugeordnetem Server für %s ohne neue Rechte', async user => {
  const response = await call(user, body(), query, '/bestehend/import');
  expect(response.statusCode).toBe(200);
  expect(response.json().id).toBe('bestehend');
  expect(m.create).not.toHaveBeenCalled();
  expect(m.install).toHaveBeenCalledWith('bestehend', expect.any(String), expect.any(Object), expect.any(Object), expect.anything(), { id: user, isAdmin: user === 'admin' });
});
it.each(['mitglied', 'fremd'])('verweigert ZIP-Import bei fehlendem Recht oder Zugriff für %s', async user => {
  expect((await call(user, body(), query, '/bestehend/import')).statusCode).toBe(user === 'mitglied' ? 403 : 404);
  expect(m.inspect).not.toHaveBeenCalled(); expect(m.install).not.toHaveBeenCalled();
});
it('prüft Rechte nach dem Upload erneut', async () => {
  m.inspect.mockImplementationOnce(async () => { m.member.mockResolvedValue({ permissions: [] }); return { entries: [], bytes: 4, root: '' }; });
  expect((await call('verwalter', body(), query, '/bestehend/import')).statusCode).toBe(403);
  expect(m.install).not.toHaveBeenCalled();
});
it('verweigert höhere RAM-Kontingente und eingeschleuste Rechte', async () => {
  expect((await call('verwalter', body(), query + '&memoryMb=8192', '/bestehend/import')).statusCode).toBe(400);
  expect((await call('verwalter', body(), query + '&ownerId=verwalter', '/bestehend/import')).statusCode).toBe(400);
  expect(m.install).not.toHaveBeenCalled();
});
