import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, audit } from '../auth/context.js';
import { describeUserAgent } from '../auth/sessions.js';
import { badRequest, notFound, publicErrorMessage } from '../lib/errors.js';
import { DEFAULT_EVENTS, EVENTS, EVENT_LABELS, testChannel } from '../services/notify.js';
import { publicVapidKey } from '../services/push.js';

/**
 * Web-Push für die PWA: Geräte-Abos und eigene Benachrichtigungskanäle
 * eines Kontos. Alles hier ist an `req.user` gebunden – niemand sieht oder
 * ändert fremde Abos. Ziel-URLs gibt es nicht (der Push-Dienst des Browsers
 * liefert den Endpoint), SSRF-Fragen wie bei Webhooks entfallen.
 */

const eventsSchema = z.array(z.enum(EVENTS)).min(1, 'Mindestens ein Ereignis auswählen');

const channelSchema = z.object({
  name: z.string().min(2).max(60),
  enabled: z.boolean().default(true),
  events: eventsSchema,
});

function serializeChannel(channel: {
  id: string;
  name: string;
  enabled: boolean;
  events: unknown;
  lastSentAt: Date | null;
  lastStatus: string | null;
  lastMessage: string | null;
  sentCount: number;
  createdAt: Date;
}) {
  return {
    id: channel.id,
    name: channel.name,
    enabled: channel.enabled,
    events: Array.isArray(channel.events) ? (channel.events as string[]) : [],
    lastSentAt: channel.lastSentAt,
    lastStatus: channel.lastStatus,
    lastMessage: channel.lastMessage,
    sentCount: channel.sentCount,
    createdAt: channel.createdAt,
  };
}

const catalog = EVENTS.map((event) => ({
  key: event,
  label: EVENT_LABELS[event],
  standard: DEFAULT_EVENTS.includes(event),
}));

export default async function pushRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  /** Öffentlicher VAPID-Schlüssel – ungeheim, aber nur für Angemeldete sinnvoll. */
  app.get('/vapid-key', async () => ({ publicKey: await publicVapidKey() }));

  // -------------------------------------------------------------------------
  // Geräte (Abos)
  // -------------------------------------------------------------------------

  app.get('/subscriptions', async (req) => {
    const rows = await prisma.pushSubscription.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'asc' },
    });
    return {
      subscriptions: rows.map((row) => ({
        id: row.id,
        endpoint: row.endpoint,
        device: describeUserAgent(row.userAgent),
        createdAt: row.createdAt,
      })),
    };
  });

  app.post('/subscribe', async (req, reply) => {
    const body = z
      .object({
        endpoint: z.string().url().refine((u) => u.startsWith('https://'), 'Push-Endpoints sind immer https'),
        keys: z.object({
          p256dh: z.string().min(20).max(400),
          auth: z.string().min(10).max(400),
        }),
      })
      .parse(req.body);

    const existing = await prisma.pushSubscription.findFirst({
      where: { userId: req.user!.id, endpoint: body.endpoint },
    });
    const row = existing
      ? await prisma.pushSubscription.update({
          where: { id: existing.id },
          data: {
            p256dh: body.keys.p256dh,
            auth: body.keys.auth,
            userAgent: (req.headers['user-agent'] ?? '').slice(0, 300),
          },
        })
      : await prisma.pushSubscription.create({
          data: {
            userId: req.user!.id,
            endpoint: body.endpoint,
            p256dh: body.keys.p256dh,
            auth: body.keys.auth,
            userAgent: (req.headers['user-agent'] ?? '').slice(0, 300),
          },
        });

    reply.code(201);
    return {
      id: row.id,
      device: describeUserAgent(row.userAgent),
      createdAt: row.createdAt,
    };
  });

  app.delete('/subscriptions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = await prisma.pushSubscription.findFirst({ where: { id, userId: req.user!.id } });
    if (!row) throw notFound('Gerät nicht gefunden');
    await prisma.pushSubscription.delete({ where: { id: row.id } });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Kanäle (Ereignis-Auswahl) – gehören dem Konto, gelten für alle Server
  // -------------------------------------------------------------------------

  app.get('/channels', async (req) => {
    const channels = await prisma.notificationChannel.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'asc' },
    });
    return {
      channels: channels.map(serializeChannel),
      catalog,
      defaults: DEFAULT_EVENTS,
    };
  });

  app.post('/channels', async (req, reply) => {
    const body = channelSchema.parse(req.body);
    const channel = await prisma.notificationChannel.create({
      data: {
        userId: req.user!.id,
        serverId: null,
        name: body.name.trim(),
        enabled: body.enabled,
        type: 'PUSH',
        target: '',
        events: body.events,
      },
    });
    await audit(req.user!.id, null, 'notify.create', `push: ${channel.name}`);
    reply.code(201);
    return serializeChannel(channel);
  });

  app.patch('/channels/:id', async (req) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.notificationChannel.findFirst({ where: { id, userId: req.user!.id } });
    if (!existing) throw notFound('Kanal nicht gefunden');

    const toggle = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (toggle.success && Object.keys(req.body as object).length === 1) {
      const updated = await prisma.notificationChannel.update({
        where: { id },
        data: { enabled: toggle.data.enabled },
      });
      return serializeChannel(updated);
    }

    if (existing.type !== 'PUSH') throw badRequest('Kein Push-Kanal');
    const body = channelSchema.parse(req.body);
    const updated = await prisma.notificationChannel.update({
      where: { id },
      data: { name: body.name.trim(), enabled: body.enabled, events: body.events },
    });
    await audit(req.user!.id, null, 'notify.update', `push: ${updated.name}`);
    return serializeChannel(updated);
  });

  app.delete('/channels/:id', async (req) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.notificationChannel.findFirst({ where: { id, userId: req.user!.id } });
    if (!existing) throw notFound('Kanal nicht gefunden');
    await prisma.notificationChannel.delete({ where: { id } });
    await audit(req.user!.id, null, 'notify.delete', `push: ${existing.name}`);
    return { ok: true };
  });

  app.post('/channels/:id/test', async (req) => {
    const { id } = req.params as { id: string };
    const channel = await prisma.notificationChannel.findFirst({ where: { id, userId: req.user!.id } });
    if (!channel) throw notFound('Kanal nicht gefunden');
    try {
      await testChannel(channel);
      return { ok: true, message: 'Testnachricht zugestellt' };
    } catch (err) {
      return { ok: false, message: publicErrorMessage(err, 'Zustellung fehlgeschlagen') };
    }
  });
}

