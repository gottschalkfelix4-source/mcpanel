import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const m = vi.hoisted(() => ({ dataRoot: '', users: 0, verifyKey: vi.fn() }));
vi.mock('../config.js', () => ({ config: {
  get dataRoot() { return m.dataRoot; },
  build: {}, publicHost: 'localhost', portRange: { min: 25565, max: 25700 },
} }));
vi.mock('../db.js', () => ({ prisma: { user: { count: async () => m.users } } }));
vi.mock('../auth/jwt.js', () => ({ signToken: () => 'token' }));
vi.mock('../services/settings.js', () => ({ getCurseforgeKey: async () => null, setSetting: vi.fn() }));
vi.mock('../providers/curseforge.js', () => ({ verifyKey: m.verifyKey }));
vi.mock('../services/docker.js', () => ({ docker: { version: async () => ({ Version: '27' }) } }));

const { default: setupRoutes, prepareSetupCode } = await import('./setup.js');

let code = '';
beforeAll(async () => {
  m.dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-setup-'));
  const log = vi.fn();
  await prepareSetupCode(log);
  code = (await fs.readFile(path.join(m.dataRoot, '.setup-code'), 'utf8')).trim();
  expect(log.mock.calls[0][0]).toContain(code);
});
afterAll(async () => {
  await fs.rm(m.dataRoot, { recursive: true, force: true });
});

async function check(setupCode: string | undefined) {
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof ZodError ? 400 : error.statusCode ?? 500).send({ error: error.message }));
  await app.register(setupRoutes, { prefix: '/setup' });
  try {
    return await app.inject({ method: 'POST', url: '/setup/check-curseforge', payload: { apiKey: 'schluessel', setupCode } });
  } finally {
    await app.close();
  }
}

it('erzeugt einen gut abtippbaren Code und behält ihn über Neustarts', async () => {
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  await prepareSetupCode(vi.fn());
  expect((await fs.readFile(path.join(m.dataRoot, '.setup-code'), 'utf8')).trim()).toBe(code);
});

it('nimmt den Code auch klein, ohne Bindestriche oder mit Leerzeichen an', async () => {
  m.verifyKey.mockResolvedValue(undefined);
  for (const variant of [code, code.toLowerCase(), code.replace(/-/g, ''), code.replace(/-/g, ' ')]) {
    const res = await check(variant);
    expect(res.statusCode, variant).toBe(200);
  }
});

it.each([undefined, '', 'AAAA-BBBB-CCCC', 'falsch'])('weist ohne richtigen Code ab: %s', async (variant) => {
  m.verifyKey.mockClear();
  const res = await check(variant);
  expect(res.statusCode).toBe(403);
  expect(m.verifyKey).not.toHaveBeenCalled();
});

it('ist nach der Einrichtung gesperrt, auch mit richtigem Code', async () => {
  m.users = 1;
  try {
    expect((await check(code)).statusCode).toBe(403);
  } finally {
    m.users = 0;
  }
});
