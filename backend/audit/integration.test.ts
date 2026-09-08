/** Opt-in tests against a disposable PostgreSQL database. Never use production data.
 * AUDIT_DATABASE_URL must name mcpanel_audit on loopback; run with a temporary DATA_ROOT.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../src/lib/errors.js';
import { createServer as httpServer } from 'node:http';
import { createRequire } from 'node:module';
import { Server as IOServer } from 'socket.io';

const docker = vi.hoisted(() => ({ create: vi.fn(async () => ({})), remove: vi.fn(async () => {}), recreate: vi.fn(async () => ({})) }));
vi.mock('../src/services/docker.js', () => ({
  docker: { getContainer: () => ({ inspect: async () => { throw { statusCode: 404 }; } }) },
  ensureNetwork: vi.fn(), ensureImage: vi.fn(), imageForServer: () => 'fixture',
  createContainer: docker.create, removeContainer: docker.remove, recreateContainer: docker.recreate,
  getState: async () => ({ state: 'stopped' }), start: vi.fn(), stop: vi.fn(),
  buildEnv: () => [], PROTECTED_ENV_KEYS: [], getStats: async () => null,
  tailLogs: async () => 'fixture history', followLogs: async () => () => {}, writeStdin: vi.fn(),
}));
vi.mock('../src/services/rcon.js', () => ({ rconCommand: async () => 'fixture response', listPlayers: async () => ({ online: 0, max: 20, players: [] }) }));

const url = process.env.AUDIT_DATABASE_URL;
describe.skipIf(!url)('PostgreSQL integration (disposable database)', () => {
  let prisma: typeof import('../src/db.js').prisma;
  let app: ReturnType<typeof Fastify>;
  let admin: { id: string; sessionVersion: number; username: string; role: 'ADMIN' };
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.pathname !== '/mcpanel_audit' || !process.env.DATA_ROOT?.startsWith('/tmp/')) {
      throw new Error('Dedicated loopback mcpanel_audit database and temporary DATA_ROOT required');
    }
    process.env.DATABASE_URL = url;
    ({ prisma } = await import('../src/db.js'));
    await prisma.$executeRawUnsafe('TRUNCATE "User", "Setting", "BackupTargetVersion" CASCADE');
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => reply.code(err instanceof HttpError ? err.statusCode : (err as { code?: string }).code === 'P2002' ? 409 : 500).send({ error: err.message }));
    await app.register((await import('../src/routes/setup.js')).default, { prefix: '/setup' });
    await app.register((await import('../src/routes/auth.js')).default, { prefix: '/auth' });
    await app.register((await import('../src/routes/servers.js')).default, { prefix: '/servers' });
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await prisma?.$disconnect(); });

  it('BUG-03: concurrent setup creates exactly one administrator', async () => {
    const responses = await Promise.all(['alpha', 'bravo'].map(name => app.inject({ method: 'POST', url: '/setup', payload: { username: name, email: `${name}@example.test`, password: 'fixture-password-123' } })));
    expect(responses.map(res => res.statusCode).sort()).toEqual([201, 403]);
    expect(await prisma.user.count()).toBe(1);
    admin = await prisma.user.findFirstOrThrow() as typeof admin;
  });

  it('BUG-18: concurrent server creation reserves different ports in the DB', async () => {
    const { createServer } = await import('../src/services/serverManager.js');
    const results = await Promise.all(['one', 'two'].map(name => createServer({ name, ownerId: admin.id, type: 'PAPER', mcVersion: '1.20.1', memoryMb: 1024 })));
    expect(new Set(results.map(s => s.port)).size).toBe(2);
  });

  it('BUG-34: Docker creation failure compensates DB and directories', async () => {
    const { createServer } = await import('../src/services/serverManager.js');
    docker.create.mockRejectedValueOnce(new Error('fixture Docker failure'));
    await expect(createServer({ name: 'failed', ownerId: admin.id, type: 'PAPER', mcVersion: '1.20.1', memoryMb: 1024 })).rejects.toThrow('fixture');
    expect(await prisma.server.count({ where: { name: 'failed' } })).toBe(0);
    const ids = new Set((await prisma.server.findMany()).map(s => s.id));
    expect((await fs.readdir(path.join(process.env.DATA_ROOT!, 'servers'))).every(id => ids.has(id))).toBe(true);
  });

  it('BUG-31: password change revokes old HTTP tokens and preserves the returned session', async () => {
    const { signToken } = await import('../src/auth/jwt.js');
    const { authenticateToken } = await import('../src/auth/context.js');
    const token = signToken({ sub: admin.id, username: admin.username, role: admin.role, sessionVersion: admin.sessionVersion });
    const response = await app.inject({ method: 'POST', url: '/auth/password', headers: { authorization: `Bearer ${token}` }, payload: { currentPassword: 'fixture-password-123', newPassword: 'new-fixture-password-456' } });
    expect(response.statusCode).toBe(200);
    await expect(authenticateToken(token)).rejects.toThrow('widerrufen');
    expect((await authenticateToken(response.json().token)).id).toBe(admin.id);
  });

  it('PROXY-01: duplicate hostnames are rejected atomically across servers', async () => {
    const servers = await prisma.server.findMany();
    const results = await Promise.allSettled(servers.map(server => prisma.serverHostname.create({ data: { serverId: server.id, hostname: 'survival.example.test' } })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.serverHostname.count()).toBe(1);
  });


  it('BUG-20: Docker removal failure keeps the server and its files', async () => {
    const { deleteServer } = await import('../src/services/serverManager.js');
    const server = await prisma.server.findFirstOrThrow();
    const file = path.join(process.env.DATA_ROOT!, 'servers', server.id, 'preserve.txt');
    await fs.writeFile(file, 'original data');
    docker.remove.mockRejectedValueOnce(new Error('Docker permission denied'));
    await expect(deleteServer(server, true)).rejects.toThrow('permission');
    expect(await prisma.server.findUnique({ where: { id: server.id } })).not.toBeNull();
    expect(await fs.readFile(file, 'utf8')).toBe('original data');
  });

  it('PROXY-01/05: admin API saves aliases; ordinary users cannot change routing', async () => {
    const { signToken } = await import('../src/auth/jwt.js');
    const server = await prisma.server.findFirstOrThrow();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    const token = signToken({ sub: user.id, username: user.username, role: user.role, sessionVersion: user.sessionVersion });
    const response = await app.inject({ method: 'PUT', url: `/servers/${server.id}/proxy`, headers: { authorization: `Bearer ${token}` }, payload: { hostnames: ['Primary.Example.Test.', 'alias.example.test'], directConnect: true } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().proxy.hostnames).toEqual(['primary.example.test', 'alias.example.test']);
    const member = await prisma.user.create({ data: { username: 'ordinary', email: 'ordinary@example.test', passwordHash: 'unused', role: 'USER' } });
    await prisma.serverMember.create({ data: { serverId: server.id, userId: member.id, permissions: [] } });
    const memberToken = signToken({ sub: member.id, username: member.username, role: member.role, sessionVersion: 0 });
    const denied = await app.inject({ method: 'PUT', url: `/servers/${server.id}/proxy`, headers: { authorization: `Bearer ${memberToken}` }, payload: { hostnames: [], directConnect: false } });
    expect(denied.statusCode).toBe(403);
  });

  it('BUG-04: an open WebSocket loses command access after role demotion and account disabling', async () => {
    const { setupConsoleGateway } = await import('../src/ws/console.js');
    const { signToken } = await import('../src/auth/jwt.js');
    const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
    const { io: connect } = require('socket.io-client');
    const user = await prisma.user.create({ data: { username: 'socket-admin', email: 'socket@example.test', passwordHash: 'unused', role: 'ADMIN' } });
    const server = await prisma.server.findFirstOrThrow();
    const http = httpServer();
    const gateway = new IOServer(http);
    setupConsoleGateway(gateway);
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const socket = connect(`http://127.0.0.1:${(http.address() as { port: number }).port}`, { auth: { token: signToken({ sub: user.id, username: user.username, role: user.role, sessionVersion: 0 }) }, transports: ['websocket'], reconnection: false });
    const command = () => new Promise<{ ok: boolean }>((resolve, reject) => socket.timeout(2000).emit('command', { serverId: server.id, command: 'list' }, (err: Error, result: { ok: boolean }) => err ? reject(err) : resolve(result)));
    try {
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
      expect((await command()).ok).toBe(true);
      await prisma.user.update({ where: { id: user.id }, data: { role: 'USER' } });
      expect((await command()).ok).toBe(false);
      await prisma.serverMember.create({ data: { serverId: server.id, userId: user.id, permissions: ['console.command', 'console.read'] } });
      expect((await command()).ok).toBe(true);
      await prisma.user.update({ where: { id: user.id }, data: { active: false } });
      expect((await command()).ok).toBe(false);
    } finally { socket.disconnect(); await new Promise<void>(resolve => gateway.close(() => resolve())); }
  });
});
