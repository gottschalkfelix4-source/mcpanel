import Fastify from 'fastify';
import { beforeEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const m = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock('../auth/jwt.js', () => ({ verifyToken: (token: string) => ({ sub: token, sessionVersion: 0 }) }));
vi.mock('../config.js', () => ({ config: { jwtSecret: 'x' } }));
vi.mock('../db.js', () => ({
  prisma: {
    user: { findUnique: async ({ where }: any) => ({ id: where.id, role: 'USER', active: true, sessionVersion: 0 }) },
    setting: { findUnique: async () => null },
    auditLog: { create: vi.fn(async () => {}) },
  },
}));
vi.mock('../services/assistant.js', () => ({
  askAssistantGlobal: m.ask,
}));

import { globalAssistantRoutes } from './assistant.js';
import { authenticate } from '../auth/context.js';

beforeEach(() => vi.clearAllMocks());

async function call(token: string | null, payload: unknown) {
  const app = Fastify();
  app.addHook('preHandler', authenticate);
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof ZodError ? 400 : error.statusCode ?? 500).send({ error: error.message }));
  await app.register(globalAssistantRoutes, { prefix: '/assistant' });
  try {
    return await app.inject({
      method: 'POST',
      url: '/assistant/ask',
      headers: token ? { authorization: 'Bearer ' + token } : {},
      payload: payload as any,
    });
  } finally {
    await app.close();
  }
}

it('beantwortet eine globale Frage ohne Serverkontext', async () => {
  m.ask.mockResolvedValue({ answer: 'Ein Modpack bündelt Mods.', model: 'test-modell', actions: [] });
  const res = await call('nutzer', { question: 'Was ist ein Modpack?', history: [] });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ answer: 'Ein Modpack bündelt Mods.', model: 'test-modell', actions: [] });
  expect(m.ask).toHaveBeenCalledWith('Was ist ein Modpack?', []);
});

it('verlangt eine Anmeldung', async () => {
  const res = await call(null, { question: 'Hallo' });
  expect(res.statusCode).toBe(401);
  expect(m.ask).not.toHaveBeenCalled();
});

it('weist eine leere Frage ab, ohne den Dienst anzurufen', async () => {
  const res = await call('nutzer', { question: '   ' });
  expect(res.statusCode).toBe(400);
  expect(m.ask).not.toHaveBeenCalled();
});

it('begrenzt die Verlaufslänge', async () => {
  m.ask.mockRejectedValue(new Error('nie gerufen'));
  const res = await call('nutzer', {
    question: 'Hallo',
    history: Array.from({ length: 30 }, (_, i) => ({ role: 'user' as const, content: `n${i}` })),
  });
  expect(res.statusCode).toBe(400);
  expect(m.ask).not.toHaveBeenCalled();
});
