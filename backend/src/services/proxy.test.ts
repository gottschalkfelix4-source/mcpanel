import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  config: { dataRoot: '', hostDataRoot: '/host/data', dockerNetwork: 'test-network' },
  inspect: vi.fn(), start: vi.fn(), kill: vi.fn(), remove: vi.fn(), create: vi.fn(),
  rows: vi.fn(), occupied: vi.fn(), get: vi.fn(), set: vi.fn(),
}));
vi.mock('../config.js', () => ({ config: m.config }));
vi.mock('../db.js', () => ({ prisma: { serverHostname: { findMany: m.rows }, server: { findFirst: m.occupied } } }));
vi.mock('./settings.js', () => ({ getSetting: m.get, setSetting: m.set }));
vi.mock('./docker.js', () => ({
  docker: { getContainer: () => ({ inspect: m.inspect, kill: m.kill, start: m.start, remove: m.remove }), createContainer: m.create },
  ensureImage: vi.fn(), ensureNetwork: vi.fn(),
}));
const { normalizeHostname, normalizeHostnames, reconcileProxy, configureProxy, syncProxyRoutes, ROUTER_IMAGE } = await import('./proxy.js');
beforeEach(async () => {
  vi.resetAllMocks();
  m.config.dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-proxy-test-'));
  m.inspect.mockRejectedValue({ statusCode: 404 });
  m.create.mockResolvedValue({ start: m.start });
  m.rows.mockResolvedValue([{ hostname: 'survival.example.test', server: { containerName: 'mc-one' } }]);
  m.occupied.mockResolvedValue(null);
  m.get.mockResolvedValue('');
});
afterEach(async () => fs.rm(m.config.dataRoot, { recursive: true, force: true }));
it('normalizes case, trailing dot and international domain names', () => {
  expect(normalizeHostname(' SURVIVAL.Example.Test. ')).toBe('survival.example.test');
  expect(normalizeHostname('münchen.example.test')).toBe('xn--mnchen-3ya.example.test');
  expect(() => normalizeHostnames(['A.example.test', 'a.example.test.'])).toThrow('doppelt');
});
it.each(['*.example.test', 'example.test:25565', 'https://example.test', '127.0.0.1', 'localhost', '-a.example.test', 'a..example.test', 'a/example.test', ''])('rejects invalid hostname %s', value => {
  expect(() => normalizeHostname(value)).toThrow('ungültig');
});
it('creates an isolated router without a Docker socket or fallback route', async () => {
  await reconcileProxy({ enabled: true, port: 25565 });
  expect(m.create).toHaveBeenCalledWith(expect.objectContaining({
    Image: ROUTER_IMAGE, Env: ['ROUTES_CONFIG=/routes/routes.json'],
    HostConfig: expect.objectContaining({ Binds: ['/host/data/proxy:/routes:ro'], NetworkMode: 'test-network', RestartPolicy: { Name: 'unless-stopped' }, PortBindings: { '25565/tcp': [{ HostPort: '25565' }] } }),
  }));
  expect(JSON.parse(await fs.readFile(path.join(m.config.dataRoot, 'proxy/routes.json'), 'utf8'))).toEqual({ mappings: { 'survival.example.test': 'mc-one:25565' } });
  expect(m.start).toHaveBeenCalledOnce();
});
it('requires migration of a direct server before taking its port', async () => {
  m.occupied.mockResolvedValue({ name: 'Existing' });
  await expect(reconcileProxy({ enabled: true, port: 25565 })).rejects.toThrow('Existing');
  expect(m.create).not.toHaveBeenCalled();
  expect(m.remove).not.toHaveBeenCalled();
});
it('atomically replaces routes and explicitly signals a running router', async () => {
  m.inspect.mockResolvedValue({ Config: { Labels: { 'mcpanel.router': 'true' } }, State: { Running: true } });
  await syncProxyRoutes();
  m.rows.mockResolvedValue([]);
  await syncProxyRoutes();
  expect(JSON.parse(await fs.readFile(path.join(m.config.dataRoot, 'proxy/routes.json'), 'utf8'))).toEqual({ mappings: {} });
  expect(m.kill).toHaveBeenCalledWith({ signal: 'SIGHUP' });
  expect(await fs.readdir(path.join(m.config.dataRoot, 'proxy'))).toEqual(['routes.json']);
});
it('does not take over an unowned container', async () => {
  m.inspect.mockResolvedValue({ Config: { Labels: {} }, State: { Running: true } });
  await expect(reconcileProxy({ enabled: false, port: 25565 })).rejects.toThrow('anderweitig');
  expect(m.remove).not.toHaveBeenCalled();
  expect(m.kill).not.toHaveBeenCalled();
});
it('does not persist requested configuration after a Docker failure', async () => {
  m.start.mockRejectedValue(new Error('port is already allocated'));
  await expect(configureProxy({ enabled: true, port: 25565 })).rejects.toThrow('allocated');
  expect(m.set).not.toHaveBeenCalled();
});
