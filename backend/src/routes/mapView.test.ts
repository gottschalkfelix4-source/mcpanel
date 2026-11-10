import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ port: 0, active: true, version: 0, permissions: ['console.read'], requests: [] as string[] }));
vi.mock('../config.js', () => ({ config: { jwtSecret: 'test-geheimnis' }, serverDir: () => '/x' }));
vi.mock('../db.js', () => ({ prisma: {
  user: { findUnique: async () => ({ id: 'u1', active: m.active, sessionVersion: m.version }) },
  server: { findUnique: async () => ({ id: 'srv', containerName: 'mc-srv' }) },
} }));
vi.mock('../auth/context.js', () => ({
  getServerAccess: async () => ({ can: (p: string) => m.permissions.includes(p) }),
}));
vi.mock('../services/bluemapProxy.js', async (original) => ({
  ...(await original<object>()),
  bluemapTarget: async () => ({ host: '127.0.0.1', port: m.port }),
}));

const { default: mapViewRoutes, _resetMapViewCache } = await import('./mapView.js');
const { createMapToken } = await import('../lib/mapToken.js');

let upstream: http.Server;
beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    m.requests.push(req.url!);
    res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'boese=1', 'X-Frame-Options': 'DENY' });
    res.end('<html>BlueMap</html>');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  m.port = (upstream.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
beforeEach(() => { _resetMapViewCache(); m.active = true; m.version = 0; m.permissions = ['console.read']; m.requests = []; });

async function get(url: string) {
  const app = Fastify();
  await app.register(mapViewRoutes, { prefix: '/api/map-view' });
  try { return await app.inject({ method: 'GET', url }); } finally { await app.close(); }
}

it('reicht BlueMap durch – in einer Sandbox, ohne Cookies des Upstreams', async () => {
  const token = createMapToken('srv', 'u1', 0);
  const res = await get(`/api/map-view/${token}/maps/world/settings.json?x=1`);
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe('<html>BlueMap</html>');
  expect(m.requests).toEqual(['/maps/world/settings.json?x=1']);
  expect(res.headers['content-security-policy']).toContain('sandbox allow-scripts');
  expect(res.headers['content-security-policy']).not.toContain('allow-same-origin');
  expect(res.headers['set-cookie']).toBeUndefined();
  expect(res.headers['x-frame-options']).toBeUndefined();
});

it('leitet ohne Schrägstrich auf den Ordner um, damit relative Pfade stimmen', async () => {
  const token = createMapToken('srv', 'u1', 0);
  const res = await get(`/api/map-view/${token}`);
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toBe(`${token}/`);
});

it('verweigert ohne gültiges Token, nach Abmelden überall und ohne Konsolenrecht', async () => {
  expect((await get('/api/map-view/kaputt/')).statusCode).toBe(401);
  const token = createMapToken('srv', 'u1', 0);
  m.version = 1;
  expect((await get(`/api/map-view/${token}/`)).statusCode).toBe(401);
  const other = createMapToken('srv', 'u1', 1);
  m.permissions = [];
  expect((await get(`/api/map-view/${other}/`)).statusCode).toBe(401);
  expect(m.requests).toEqual([]);
});

it('blockt Pfade außerhalb des Webroots', async () => {
  const token = createMapToken('srv', 'u1', 5);
  m.version = 5;
  expect([400, 404]).toContain((await get(`/api/map-view/${token}/%2e%2e/%2e%2e/etc/passwd`)).statusCode);
  expect((await get(`/api/map-view/${token}/maps/..%2F..%2Fgeheim`)).statusCode).toBe(400);
  expect(m.requests).toEqual([]);
});
