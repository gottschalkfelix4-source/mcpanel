import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { audit, requireServer } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { badRequest, notFound } from '../lib/errors.js';
import { ACTIONS, TRIGGERS, runAutomation } from '../services/automation.js';
import { describeCron, isValidCron, nextRun } from '../services/cron.js';

const bodySchema = z
  .object({
    name: z.string().min(2).max(60),
    enabled: z.boolean().default(true),
    trigger: z.enum(TRIGGERS),
    cron: z.string().max(120).optional(),
    action: z.enum(ACTIONS),
    config: z
      .object({
        command: z.string().max(500).optional(),
        backupName: z.string().max(80).optional(),
        note: z.string().max(280).optional(),
        keepBackups: z.number().int().min(1).max(200).optional(),
      })
      .default({}),
    onlyWhenRunning: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.trigger === 'SCHEDULE') {
      if (!value.cron?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['cron'], message: 'Zeitplan fehlt' });
      } else if (!isValidCron(value.cron)) {
        ctx.addIssue({ code: 'custom', path: ['cron'], message: 'Zeitplan ist ungültig' });
      }
    }
    if (value.action === 'COMMAND' && !value.config.command?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['config', 'command'], message: 'Befehl fehlt' });
    }
  });

/** Ergänzt Klartext-Zeitplan und nächsten Lauf für die Oberfläche. */
function decorate(automation: {
  cron: string | null;
  trigger: string;
  enabled: boolean;
  [k: string]: unknown;
}) {
  const schedule =
    automation.trigger === 'SCHEDULE' && automation.cron
      ? describeCron(automation.cron)
      : 'Wenn der Server unerwartet abstürzt';

  let next: string | null = null;
  if (automation.enabled && automation.trigger === 'SCHEDULE' && automation.cron) {
    next = nextRun(automation.cron)?.toISOString() ?? null;
  }

  return { ...automation, scheduleText: schedule, nextRunAt: next };
}

export default async function automationRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const access = await requireServer(req);
    const automations = await prisma.automation.findMany({
      where: { serverId: access.server.id },
      orderBy: { createdAt: 'asc' },
    });
    return {
      automations: automations.map(decorate),
      canManage: access.can(PERMISSIONS.AUTOMATION_MANAGE),
    };
  });

  /** Zeitplan vorab prüfen, während der Nutzer tippt. */
  app.get('/preview', async (req) => {
    await requireServer(req);
    const { cron } = z.object({ cron: z.string() }).parse(req.query);
    if (!isValidCron(cron)) return { valid: false, text: 'Ungültiger Zeitplan', next: [] };

    const upcoming: string[] = [];
    let cursor = new Date();
    for (let i = 0; i < 3; i++) {
      const date = nextRun(cron, cursor);
      if (!date) break;
      upcoming.push(date.toISOString());
      cursor = date;
    }
    return { valid: true, text: describeCron(cron), next: upcoming };
  });

  app.post('/', async (req, reply) => {
    const access = await requireServer(req, PERMISSIONS.AUTOMATION_MANAGE);
    const body = bodySchema.parse(req.body);

    const automation = await prisma.automation.create({
      data: {
        serverId: access.server.id,
        name: body.name.trim(),
        enabled: body.enabled,
        trigger: body.trigger,
        cron: body.trigger === 'SCHEDULE' ? body.cron!.trim() : null,
        action: body.action,
        config: body.config,
        onlyWhenRunning: body.onlyWhenRunning,
        createdById: req.user!.id,
      },
    });

    await audit(req.user!.id, access.server.id, 'automation.create', automation.name);
    reply.code(201);
    return decorate(automation);
  });

  app.patch('/:automationId', async (req) => {
    const access = await requireServer(req, PERMISSIONS.AUTOMATION_MANAGE);
    const { automationId } = req.params as { automationId: string };

    const existing = await prisma.automation.findFirst({
      where: { id: automationId, serverId: access.server.id },
    });
    if (!existing) throw notFound('Automatisierung nicht gefunden');

    // Teilaktualisierung: nur "enabled" umschalten ist ausdrücklich erlaubt.
    const toggle = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (toggle.success && Object.keys(req.body as object).length === 1) {
      const updated = await prisma.automation.update({
        where: { id: automationId },
        data: { enabled: toggle.data.enabled },
      });
      await audit(
        req.user!.id,
        access.server.id,
        'automation.toggle',
        `${updated.name}: ${updated.enabled ? 'aktiv' : 'pausiert'}`,
      );
      return decorate(updated);
    }

    const body = bodySchema.parse(req.body);
    const updated = await prisma.automation.update({
      where: { id: automationId },
      data: {
        name: body.name.trim(),
        enabled: body.enabled,
        trigger: body.trigger,
        cron: body.trigger === 'SCHEDULE' ? body.cron!.trim() : null,
        action: body.action,
        config: body.config,
        onlyWhenRunning: body.onlyWhenRunning,
      },
    });

    await audit(req.user!.id, access.server.id, 'automation.update', updated.name);
    return decorate(updated);
  });

  app.delete('/:automationId', async (req) => {
    const access = await requireServer(req, PERMISSIONS.AUTOMATION_MANAGE);
    const { automationId } = req.params as { automationId: string };

    const existing = await prisma.automation.findFirst({
      where: { id: automationId, serverId: access.server.id },
    });
    if (!existing) throw notFound('Automatisierung nicht gefunden');

    await prisma.automation.delete({ where: { id: automationId } });
    await audit(req.user!.id, access.server.id, 'automation.delete', existing.name);
    return { ok: true };
  });

  /** Sofort ausführen – zum Testen einer frisch angelegten Regel. */
  app.post('/:automationId/run', async (req) => {
    const access = await requireServer(req, PERMISSIONS.AUTOMATION_MANAGE);
    const { automationId } = req.params as { automationId: string };

    const automation = await prisma.automation.findFirst({
      where: { id: automationId, serverId: access.server.id },
    });
    if (!automation) throw notFound('Automatisierung nicht gefunden');
    if (automation.action === 'COMMAND' && !(automation.config as { command?: string })?.command) {
      throw badRequest('Kein Befehl hinterlegt');
    }

    const result = await runAutomation(automation, 'manuell');
    return { ok: result.status !== 'FEHLER', ...result };
  });
}
