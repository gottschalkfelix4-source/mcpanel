import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { audit, requireAdmin, requireServer } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { badRequest, notFound } from '../lib/errors.js';
import { DEFAULT_EVENTS, EVENTS, EVENT_LABELS, testChannel } from '../services/notify.js';

const TYPES = ['DISCORD', 'WEBHOOK'] as const;

const bodySchema = z.object({
  name: z.string().min(2).max(60),
  enabled: z.boolean().default(true),
  type: z.enum(TYPES).default('DISCORD'),
  target: z.string().min(8).max(500),
  events: z.array(z.enum(EVENTS)).min(1, 'Mindestens ein Ereignis auswählen'),
});

/**
 * Verhindert, dass ein Server-Mitglied das Panel Anfragen ins eigene Netz
 * schicken lässt (SSRF). Administratoren dürfen das – im Heimnetz zeigt ein
 * Webhook durchaus mal auf einen Dienst nebenan.
 *
 * Die Prüfung sieht nur den Hostnamen an; ein Name, der erst per DNS auf eine
 * private Adresse zeigt, käme durch. Für ein selbst gehostetes Panel mit
 * eingeladenen Freunden ist das die richtige Abwägung.
 */
function assertSafeTarget(target: string, isAdmin: boolean): void {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw badRequest('Die Ziel-URL ist ungültig');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badRequest('Nur http- und https-Adressen sind erlaubt');
  }
  if (isAdmin) return;

  const host = url.hostname.toLowerCase();
  const privat =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '::1' ||
    host === '0.0.0.0';

  if (privat) {
    throw badRequest('Adressen im lokalen Netz sind nur für Administratoren erlaubt');
  }
}

/** Die URL enthält bei Discord ein Token – gekürzt an die Oberfläche geben. */
function mask(target: string): string {
  try {
    const url = new URL(target);
    const parts = url.pathname.split('/').filter(Boolean);
    const tail = parts.length > 0 ? parts[parts.length - 1] : '';
    const short = tail.length > 8 ? `…${tail.slice(-6)}` : tail;
    return `${url.host}/…/${short}`;
  } catch {
    return target.slice(0, 24) + '…';
  }
}

function serialize(channel: {
  id: string;
  name: string;
  enabled: boolean;
  type: string;
  target: string;
  events: unknown;
  serverId: string | null;
  lastSentAt: Date | null;
  lastStatus: string | null;
  lastMessage: string | null;
  sentCount: number;
}) {
  return {
    id: channel.id,
    name: channel.name,
    enabled: channel.enabled,
    type: channel.type,
    targetMasked: mask(channel.target),
    events: Array.isArray(channel.events) ? (channel.events as string[]) : [],
    global: channel.serverId === null,
    lastSentAt: channel.lastSentAt,
    lastStatus: channel.lastStatus,
    lastMessage: channel.lastMessage,
    sentCount: channel.sentCount,
  };
}

/** Katalog der Ereignisse für die Oberfläche. */
const catalog = EVENTS.map((event) => ({
  key: event,
  label: EVENT_LABELS[event],
  standard: DEFAULT_EVENTS.includes(event),
}));

// ---------------------------------------------------------------------------
// Kanäle eines Servers – /api/servers/:id/notifications
// ---------------------------------------------------------------------------

export default async function notificationRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const access = await requireServer(req);

    // Globale Kanäle werden mit angezeigt, damit niemand rätselt, warum eine
    // Nachricht ankommt, die in dieser Liste nicht steht.
    const [own, global] = await Promise.all([
      prisma.notificationChannel.findMany({
        where: { serverId: access.server.id },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.notificationChannel.findMany({
        where: { serverId: null },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return {
      channels: own.map(serialize),
      globalChannels: global.map(serialize),
      catalog,
      defaults: DEFAULT_EVENTS,
      canManage: access.can(PERMISSIONS.AUTOMATION_MANAGE),
    };
  });

  app.post('/', async (req, reply) => {
    const access = await requireServer(req, PERMISSIONS.AUTOMATION_MANAGE);
    const body = bodySchema.parse(req.body);
    assertSafeTarget(body.target, req.user!.role === 'ADMIN');

    const channel = await prisma.notificationChannel.create({
      data: {
        serverId: access.server.id,
        name: body.name.trim(),
        enabled: body.enabled,
        type: body.type,
        target: body.target.trim(),
        events: body.events,
      },
    });

    await audit(req.user!.id, access.server.id, 'notify.create', channel.name);
    reply.code(201);
    return serialize(channel);
  });

  app.patch('/:channelId', async (req) => {
    const access = await requireServer(req, PERMISSIONS.AUTOMATION_MANAGE);
    const { channelId } = req.params as { channelId: string };

    const existing = await prisma.notificationChannel.findFirst({
      where: { id: channelId, serverId: access.server.id },
    });
    if (!existing) throw notFound('Kanal nicht gefunden');

    const toggle = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (toggle.success && Object.keys(req.body as object).length === 1) {
      const updated = await prisma.notificationChannel.update({
        where: { id: channelId },
        data: { enabled: toggle.data.enabled },
      });
      return serialize(updated);
    }

    const body = bodySchema.parse(req.body);
    assertSafeTarget(body.target, req.user!.role === 'ADMIN');

    const updated = await prisma.notificationChannel.update({
      where: { id: channelId },
      data: {
        name: body.name.trim(),
        enabled: body.enabled,
        type: body.type,
        target: body.target.trim(),
        events: body.events,
      },
    });

    await audit(req.user!.id, access.server.id, 'notify.update', updated.name);
    return serialize(updated);
  });

  app.delete('/:channelId', async (req) => {
    const access = await requireServer(req, PERMISSIONS.AUTOMATION_MANAGE);
    const { channelId } = req.params as { channelId: string };

    const existing = await prisma.notificationChannel.findFirst({
      where: { id: channelId, serverId: access.server.id },
    });
    if (!existing) throw notFound('Kanal nicht gefunden');

    await prisma.notificationChannel.delete({ where: { id: channelId } });
    await audit(req.user!.id, access.server.id, 'notify.delete', existing.name);
    return { ok: true };
  });

  app.post('/:channelId/test', async (req) => {
    const access = await requireServer(req, PERMISSIONS.AUTOMATION_MANAGE);
    const { channelId } = req.params as { channelId: string };

    const channel = await prisma.notificationChannel.findFirst({
      where: { id: channelId, serverId: access.server.id },
    });
    if (!channel) throw notFound('Kanal nicht gefunden');

    try {
      await testChannel(channel);
      return { ok: true, message: 'Testnachricht zugestellt' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Zustellung fehlgeschlagen' };
    }
  });
}

// ---------------------------------------------------------------------------
// Globale Kanäle – /api/settings/notifications (nur Administratoren)
// ---------------------------------------------------------------------------

export async function globalNotificationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => {
    const channels = await prisma.notificationChannel.findMany({
      where: { serverId: null },
      orderBy: { createdAt: 'asc' },
    });
    return { channels: channels.map(serialize), catalog, defaults: DEFAULT_EVENTS, canManage: true };
  });

  app.post('/', async (req, reply) => {
    const body = bodySchema.parse(req.body);
    assertSafeTarget(body.target, true);

    const channel = await prisma.notificationChannel.create({
      data: {
        serverId: null,
        name: body.name.trim(),
        enabled: body.enabled,
        type: body.type,
        target: body.target.trim(),
        events: body.events,
      },
    });

    await audit(req.user!.id, null, 'notify.create', `global: ${channel.name}`);
    reply.code(201);
    return serialize(channel);
  });

  app.patch('/:channelId', async (req) => {
    const { channelId } = req.params as { channelId: string };
    const existing = await prisma.notificationChannel.findFirst({
      where: { id: channelId, serverId: null },
    });
    if (!existing) throw notFound('Kanal nicht gefunden');

    const toggle = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (toggle.success && Object.keys(req.body as object).length === 1) {
      const updated = await prisma.notificationChannel.update({
        where: { id: channelId },
        data: { enabled: toggle.data.enabled },
      });
      return serialize(updated);
    }

    const body = bodySchema.parse(req.body);
    assertSafeTarget(body.target, true);

    const updated = await prisma.notificationChannel.update({
      where: { id: channelId },
      data: {
        name: body.name.trim(),
        enabled: body.enabled,
        type: body.type,
        target: body.target.trim(),
        events: body.events,
      },
    });

    await audit(req.user!.id, null, 'notify.update', `global: ${updated.name}`);
    return serialize(updated);
  });

  app.delete('/:channelId', async (req) => {
    const { channelId } = req.params as { channelId: string };
    const existing = await prisma.notificationChannel.findFirst({
      where: { id: channelId, serverId: null },
    });
    if (!existing) throw notFound('Kanal nicht gefunden');

    await prisma.notificationChannel.delete({ where: { id: channelId } });
    await audit(req.user!.id, null, 'notify.delete', `global: ${existing.name}`);
    return { ok: true };
  });

  app.post('/:channelId/test', async (req) => {
    const { channelId } = req.params as { channelId: string };
    const channel = await prisma.notificationChannel.findFirst({
      where: { id: channelId, serverId: null },
    });
    if (!channel) throw notFound('Kanal nicht gefunden');

    try {
      await testChannel(channel);
      return { ok: true, message: 'Testnachricht zugestellt' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Zustellung fehlgeschlagen' };
    }
  });
}
