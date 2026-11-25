import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sendNotification: vi.fn(async () => ({ statusCode: 201 })),
  generateVAPIDKeys: vi.fn(() => ({ publicKey: 'PU__BLI_C==', privateKey: 'PRIV' })),
  setVapidDetails: vi.fn(),
  subscriptions: [] as any[],
  deleteFind: vi.fn(),
  dataRoot: '',
}));

vi.mock('web-push', () => ({
  sendNotification: m.sendNotification,
  generateVAPIDKeys: m.generateVAPIDKeys,
  setVapidDetails: m.setVapidDetails,
}));
vi.mock('../db.js', () => ({
  prisma: {
    pushSubscription: {
      findMany: async () => m.subscriptions,
      delete: m.deleteFind,
    },
  },
}));
vi.mock('../config.js', () => ({
  config: { get dataRoot() { return m.dataRoot; } },
}));

const { ensureVapidKeys, publicVapidKey, sendPush } = await import('./push.js');

describe('Web-Push-Service', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-push-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    vi.resetModules();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    m.subscriptions = [];
    m.deleteFind.mockImplementation(async () => ({}));
  });

  it('erzeugt und speichert VAPID-Schlüssel beim ersten Aufruf', async () => {
    m.dataRoot = dir;
    const pair = await ensureVapidKeys();
    expect(pair.publicKey).toBe('PU__BLI_C==');
    const raw = await fs.readFile(path.join(dir, '.vapid-keys'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ publicKey: 'PU__BLI_C==' });
  });

  it('entfernt Auffüllzeichen aus dem öffentlichen Schlüssel', async () => {
    const key = await publicVapidKey();
    expect(key).toBe('PU__BLI_C');
    expect(key).not.toContain('=');
  });

  it('liefert an alle Geräte des Kanal-Besitzers', async () => {
    m.subscriptions = [
      { id: 'a', endpoint: 'https://push.example/a', p256dh: 'x', auth: 'y' },
      { id: 'b', endpoint: 'https://push.example/b', p256dh: 'x', auth: 'y' },
    ];
    const { delivered } = await sendPush({ userId: 'u1' } as any, { title: 'Hallo' });
    expect(delivered).toBe(2);
    expect(m.sendNotification).toHaveBeenCalledTimes(2);
  });

  it('wirft, wenn das Konto keine Geräte hat', async () => {
    await expect(sendPush({ userId: 'u1' } as any, {})).rejects.toThrow('Kein Gerät');
  });

  it('räumt verwaiste Abos auf (404/410) und liefert an die übrigen', async () => {
    m.subscriptions = [
      { id: 'tot', endpoint: 'https://push.example/tot', p256dh: 'x', auth: 'y' },
      { id: 'gut', endpoint: 'https://push.example/gut', p256dh: 'x', auth: 'y' },
    ];
    m.sendNotification
      .mockRejectedValueOnce({ statusCode: 410 })
      .mockResolvedValueOnce({ statusCode: 201 });
    const { delivered } = await sendPush({ userId: 'u1' } as any, {});
    expect(delivered).toBe(1);
    expect(m.deleteFind).toHaveBeenCalledWith({ where: { id: 'tot' } });
  });
});
