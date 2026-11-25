import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const m = vi.hoisted(() => ({
  subscriptions: [] as any[],
  channels: [] as any[],
  pushCreate: vi.fn(), pushDelete: vi.fn(), pushFindMany: vi.fn(), pushFindFirst: vi.fn(),
  channelCreate: vi.fn(), channelUpdate: vi.fn(), channelDelete: vi.fn(), channelFindMany: vi.fn(), channelFindFirst: vi.fn(),
  audit: vi.fn(), testChannel: vi.fn(), publicVapidKey: vi.fn(async () => 'vapid-test-key'),
}));

vi.mock('../db.js', () => ({
  prisma: {
    pushSubscription: {
      findMany: m.pushFindMany,
      findFirst: m.pushFindFirst,
      create: m.pushCreate,
      update: vi.fn(),
      delete: m.pushDelete,
    },
    notificationChannel: {
      findMany: m.channelFindMany,
      findFirst: m.channelFindFirst,
      create: m.channelCreate,
      update: m.channelUpdate,
      delete: m.channelDelete,
    },
  },
}));
vi.mock('../config.js', () => ({ config: { dataRoot: 'C:/tmp' } }));
vi.mock('../auth/context.js', () => ({
  authenticate: async (req: any) => { req.user = { id: req.headers['x-user'] }; },
  audit: m.audit,
}));
vi.mock('../auth/sessions.js', () => ({
  describeUserAgent: (ua: string) => (ua ? 'Firefox unter Windows' : 'Unbekanntes Gerät'),
}));
vi.mock('../services/notify.js', () => ({
  DEFAULT_EVENTS: ['server.crashed', 'backup.failed', 'disk.low'],
  EVENTS: ['server.started', 'server.stopped', 'server.crashed', 'server.unhealthy', 'server.recovered', 'automation.ok', 'automation.failed', 'backup.done', 'backup.failed', 'modpack.update', 'disk.low'],
  EVENT_LABELS: { 'server.started': 'Server gestartet', 'server.crashed': 'Server abgestürzt', 'backup.failed': 'Backup fehlgeschlagen', 'disk.low': 'Speicherplatz knapp' },
  testChannel: m.testChannel,
}));
vi.mock('../services/push.js', () => ({ publicVapidKey: m.publicVapidKey }));

const { default: pushRoutes } = await import('./push.js');


function channel(over: Partial<any> = {}) {
  return {
    id: 'ch1', name: 'Handy', userId: 'nutzer', enabled: true, events: ['server.crashed'],
    lastSentAt: null, lastStatus: null, lastMessage: null, sentCount: 0, createdAt: new Date(),
    ...over,
  };
}

async function call(method: any, url: string, body?: object, user = 'nutzer') {
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) =>
    reply.code(error instanceof ZodError ? 400 : error.statusCode ?? 500).send({ error: error.message }));
  await app.register(pushRoutes, { prefix: '/api/push' });
  try {
    return await app.inject({
      method, url, headers: { 'x-user': user, 'user-agent': 'Firefox/120 Windows' },
      ...(body ? { payload: body } : {}),
    });
  } finally {
    await app.close();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  m.pushFindMany.mockImplementation(async () => m.subscriptions);
  m.pushFindFirst.mockImplementation(async ({ where }: any) =>
    m.subscriptions.find((s) => s.id === where.id && s.userId === where.userId) ?? null,
  );
  m.channelFindMany.mockImplementation(async ({ where }: any) =>
    m.channels.filter((c) => c.userId === where.userId),
  );
  m.channelFindFirst.mockImplementation(async ({ where }: any) =>
    m.channels.find((c) => c.id === where.id && c.userId === where.userId) ?? null,
  );
  m.pushCreate.mockImplementation(async ({ data }: any) => ({ id: 'sub1', ...data, createdAt: new Date() }));
  m.channelCreate.mockImplementation(async ({ data }: any) => ({ id: 'ch1', ...data, createdAt: new Date() }));
  m.channelUpdate.mockImplementation(async ({ data }: any) => ({ ...m.channels[0], ...data }));
  m.channelDelete.mockImplementation(async () => ({}));
  m.subscriptions = [{ id: 'sub1', endpoint: 'https://push.example/x', userId: 'nutzer', p256dh: 'a'.repeat(40), auth: 'b'.repeat(20), userAgent: 'Firefox/120 Windows', createdAt: new Date() }];
  m.channels = [channel(), channel({ id: 'fremd', userId: 'andere' })];
});


describe('Push-Routen', () => {
  it('liefert die Geräte des angemeldeten Kontos', async () => {
    const res = await call('GET', '/api/push/subscriptions');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).subscriptions).toHaveLength(1);
    expect(JSON.parse(res.body).subscriptions[0].device).toContain('Firefox');
    expect(m.pushFindMany).toHaveBeenCalledWith({ where: { userId: 'nutzer' }, orderBy: { createdAt: 'asc' } });
  });

  it('liefert nur die eigenen Kanäle – fremde bleiben außen vor', async () => {
    const res = await call('GET', '/api/push/channels');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.channels.map((c: any) => c.id)).toEqual(['ch1']);
    expect(body.catalog.some((e: any) => e.key === 'disk.low')).toBe(true);
  });

  it('legt einen eigenen Push-Kanal an', async () => {
    const res = await call('POST', '/api/push/channels', { name: 'Warnungen', enabled: true, events: ['server.crashed', 'disk.low'] });
    expect(res.statusCode).toBe(201);
    expect(m.channelCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'nutzer', type: 'PUSH', target: '', name: 'Warnungen' }),
    });
    expect(m.audit).toHaveBeenCalled();
  });

  it('lehnt einen Kanal ohne Ereignisse ab', async () => {
    const res = await call('POST', '/api/push/channels', { name: 'X', events: [] });
    expect(res.statusCode).toBe(400);
  });

  it('erlaubt das Umschalten per Teil-Update', async () => {
    const res = await call('PATCH', '/api/push/channels/ch1', { enabled: false });
    expect(res.statusCode).toBe(200);
    expect(m.channelUpdate).toHaveBeenCalledWith({ where: { id: 'ch1' }, data: { enabled: false } });
  });

  it('verbietet das Ändern fremder Kanäle', async () => {
    const res = await call('PATCH', '/api/push/channels/fremd', { enabled: false });
    expect(res.statusCode).toBe(404);
  });

  it('löscht nur eigene Kanäle', async () => {
    const fremd = await call('DELETE', '/api/push/channels/fremd');
    expect(fremd.statusCode).toBe(404);
    const eigen = await call('DELETE', '/api/push/channels/ch1');
    expect(eigen.statusCode).toBe(200);
    expect(m.channelDelete).toHaveBeenCalledWith({ where: { id: 'ch1' } });
  });

  it('meldet Testnachrichten auch bei Zustellfehlern als ok:false', async () => {
    m.testChannel.mockRejectedValueOnce(new Error('Kein Gerät für Push-Benachrichtigungen angemeldet'));
    const res = await call('POST', '/api/push/channels/ch1/test');
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, message: 'Kein Gerät für Push-Benachrichtigungen angemeldet' });
  });

  it('registriert ein Geräte-Abo', async () => {
    const res = await call('POST', '/api/push/subscribe', {
      endpoint: 'https://push.example/neu', keys: { p256dh: 'k'.repeat(40), auth: 'a'.repeat(20) },
    });
    expect(res.statusCode).toBe(201);
    expect(m.pushCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'nutzer', endpoint: 'https://push.example/neu' }),
    });
  });

  it('weist einen Nicht-https-Endpoint zurück', async () => {
    const res = await call('POST', '/api/push/subscribe', {
      endpoint: 'http://push.example/x', keys: { p256dh: 'k'.repeat(40), auth: 'a'.repeat(20) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('meldet ein fremdes Gerät zum Abmelden nicht', async () => {
    m.pushDelete.mockImplementation(async () => ({}));
    const res = await call('DELETE', '/api/push/subscriptions/unbekannt');
    expect(res.statusCode).toBe(404);
  });
});
