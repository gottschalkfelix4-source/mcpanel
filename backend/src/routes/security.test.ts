import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const m = vi.hoisted(() => ({ root: '' }));
vi.mock('../auth/jwt.js', () => ({ verifyToken: (token: string) => ({ sub: token, sessionVersion: 0 }), signToken: () => 'x' }));
vi.mock('../config.js', () => ({ serverDir: (id: string) => path.join(m.root, id), config: { jwtSecret: 'x' } }));
vi.mock('../db.js', () => ({ prisma: {
  user: { findUnique: async ({ where }: any) => ({ id: where.id, role: 'USER', active: true, sessionVersion: 0 }) },
  server: { findUnique: async () => ({ id: 'a', name: 'Welt', type: 'FABRIC', mcVersion: '1.21.1', extraEnv: {}, ownerId: 'besitzer' }) },
  serverMember: { findUnique: async () => null },
  setting: { findUnique: async () => null },
  auditLog: { create: vi.fn(async () => {}) },
} }));
vi.mock('../services/operations.js', () => ({ withServerOperation: (_i: string, _l: string, fn: Function) => fn(), waitForServerOperation: (_i: string, _l: string, fn: Function) => fn() }));
vi.mock('../services/docker.js', () => ({ getState: async () => ({ state: 'stopped' }) }));
vi.mock('../services/quota.js', () => ({ remainingDiskBytes: async () => Infinity }));

import contentRoutes from './content.js';
import { authenticate } from '../auth/context.js';
import { clearTotpFailures, noteTotpFailure, totpLockSeconds } from './auth.js';
import { parsePlayerList } from '../services/rcon.js';

beforeEach(async () => { m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-sicherheit-')); });
afterEach(async () => { await fs.rm(m.root, { recursive: true, force: true }); });

async function call(method: 'POST' | 'DELETE', url: string, payload: unknown) {
  const app = Fastify();
  app.addHook('preHandler', authenticate);
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof ZodError ? 400 : error.statusCode ?? 500).send({ error: error.message }));
  await app.register(contentRoutes, { prefix: '/servers/:id/content' });
  try { return await app.inject({ method, url: '/servers/a/content' + url, headers: { authorization: 'Bearer besitzer' }, payload: payload as any }); }
  finally { await app.close(); }
}

describe('Mods umschalten und löschen', () => {
  it('folgt keinem per Symlink umgebogenen mods-Ordner', async () => {
    const fremd = path.join(m.root, 'anderer-server');
    await fs.mkdir(fremd, { recursive: true });
    await fs.writeFile(path.join(fremd, 'level.dat'), 'welt');
    await fs.mkdir(path.join(m.root, 'a'), { recursive: true });
    await fs.symlink(fremd, path.join(m.root, 'a', 'mods'));

    expect((await call('DELETE', '', { filenames: ['level.dat'] })).statusCode).toBe(400);
    expect((await call('POST', '/toggle', { filename: 'level.dat' })).statusCode).toBe(400);
    expect(await fs.readFile(path.join(fremd, 'level.dat'), 'utf8')).toBe('welt');
  });

  it('arbeitet im echten Ordner weiter wie gewohnt', async () => {
    await fs.mkdir(path.join(m.root, 'a', 'mods'), { recursive: true });
    await fs.writeFile(path.join(m.root, 'a', 'mods', 'sodium.jar'), 'x');
    expect((await call('POST', '/toggle', { filename: 'sodium.jar' })).json()).toMatchObject({ enabled: false });
    expect((await call('DELETE', '', { filenames: ['sodium.jar.disabled'] })).statusCode).toBe(200);
    expect(await fs.readdir(path.join(m.root, 'a', 'mods'))).toEqual([]);
  });
});

describe('Sperre beim zweiten Faktor', () => {
  it('greift nach fünf Fehlversuchen und verdoppelt sich', () => {
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) noteTotpFailure('u', now);
    expect(totpLockSeconds('u', now)).toBe(0);
    noteTotpFailure('u', now);
    expect(totpLockSeconds('u', now)).toBe(60);
    noteTotpFailure('u', now);
    expect(totpLockSeconds('u', now)).toBe(120);
    expect(totpLockSeconds('u', now + 121_000)).toBe(0);
    clearTotpFailures('u');
    noteTotpFailure('u', now);
    expect(totpLockSeconds('u', now)).toBe(0);
  });
});

it('liest Spielerlisten mit Bedrock-Spielern (Geyser/Floodgate)', () => {
  expect(parsePlayerList('There are 3 of a max of 20 players online: Felix, .BedrockSpieler, *Anderer').players)
    .toEqual(['Felix', '.BedrockSpieler', '*Anderer']);
  expect(() => parsePlayerList('There are 1 of a max of 20 players online: bö se')).toThrow();
});
