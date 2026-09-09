import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { audit, authenticate, requireAdmin } from '../auth/context.js';
import { getCurseforgeKey, getPublicHost, setSetting } from '../services/settings.js';
import * as curseforge from '../providers/curseforge.js';
import * as dockerSvc from '../services/docker.js';
import {
  assertComplete, getTarget, publicTarget, saveTarget, testTarget,
  type TargetConfig,
} from '../services/backupTarget.js';
import { globalNotificationRoutes } from './notifications.js';
import { configureProxy, proxyStatus } from '../services/proxy.js';
import { proxyOverview } from '../services/proxyOverview.js';

export default async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/proxy', { preHandler: requireAdmin }, proxyStatus);
  app.get('/proxy/overview', { preHandler: requireAdmin }, proxyOverview);
  app.put('/proxy', { preHandler: requireAdmin }, async (req) => {
    const next = z.object({ enabled: z.boolean(), port: z.number().int().min(1024).max(65535) }).parse(req.body);
    await configureProxy(next);
    await audit(req.user!.id, null, 'proxy.configure', JSON.stringify(next));
    return proxyStatus();
  });
  app.put('/public-host', { preHandler: requireAdmin }, async (req) => {
    const { host } = z.object({ host: z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.:\[\]-]+$/) }).parse(req.body);
    await setSetting('panel.publicHost', host);
    return { publicHost: host };
  });

  await app.register(globalNotificationRoutes, { prefix: '/notifications' });

  /** Panel-Infos, die jeder angemeldete Nutzer sehen darf. */
  app.get('/public', async () => ({
    publicHost: await getPublicHost(),
    portRange: config.portRange,
    curseforgeAvailable: Boolean(await getCurseforgeKey()),
  }));

  app.get('/', { preHandler: requireAdmin }, async () => {
    const key = await getCurseforgeKey();
    const [users, servers, backups] = await Promise.all([
      prisma.user.count(),
      prisma.server.count(),
      prisma.backup.count(),
    ]);

    let dockerInfo: { version: string; containers: number } | null = null;
    try {
      const version = await dockerSvc.docker.version();
      const containers = await dockerSvc.listPanelContainers();
      dockerInfo = { version: version.Version, containers: containers.length };
    } catch {
      dockerInfo = null;
    }

    return {
      build: {
        version: config.build.version || null,
        revision: config.build.revision ? config.build.revision.slice(0, 7) : null,
        date: config.build.date || null,
      },
      publicHost: await getPublicHost(),
      portRange: config.portRange,
      dataRoot: config.dataRoot,

      hostDataRoot: config.hostDataRoot,
      mcImage: config.mcImage || `${config.mcImageRepo}:java… (automatisch je Minecraft-Version)`,
      dockerNetwork: config.dockerNetwork,
      curseforge: {
        configured: Boolean(key),
        masked: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : null,
      },
      counts: { users, servers, backups },
      docker: dockerInfo,
    };
  });

  app.put('/curseforge', { preHandler: requireAdmin }, async (req) => {
    const body = z.object({ apiKey: z.string() }).parse(req.body);
    await setSetting('curseforge.apiKey', body.apiKey.trim());

    if (!body.apiKey.trim()) return { ok: true, configured: false };

    try {
      await curseforge.search({ query: 'atm', type: 'modpack', pageSize: 1 });
      return { ok: true, configured: true, verified: true };
    } catch (err) {
      return {
        ok: true,
        configured: true,
        verified: false,
        error: err instanceof Error ? err.message : 'Test fehlgeschlagen',
      };
    }
  });

  // --- Zweitablage für Backups -------------------------------------------

  const targetSchema = z.object({
    kind: z.enum(['NONE', 'SMB', 'S3']),
    smb: z
      .object({
        host: z.string().max(200).default(''),
        share: z.string().max(200).default(''),
        path: z.string().max(300).default(''),
        username: z.string().max(120).default(''),
        password: z.string().max(300).optional(),
        domain: z.string().max(120).default(''),
        version: z.string().max(10).default('3.0'),
      })
      .default({}),
    s3: z
      .object({
        endpoint: z.string().max(300).default(''),
        region: z.string().max(60).default('us-east-1'),
        bucket: z.string().max(200).default(''),
        prefix: z.string().max(200).default(''),
        accessKeyId: z.string().max(200).default(''),
        secretAccessKey: z.string().max(300).optional(),
        forcePathStyle: z.boolean().default(true),
      })
      .default({}),
  });

  /**
   * Leer gelassene Geheimnisse bedeuten „unverändert lassen" – die Oberfläche
   * bekommt sie nie zu sehen und kann sie deshalb nicht zurückschicken.
   */
  async function merge(body: z.infer<typeof targetSchema>): Promise<TargetConfig> {
    const current = await getTarget();
    return {
      kind: body.kind,
      smb: {
        ...body.smb,
        password: body.smb.password?.length ? body.smb.password : current.smb.password,
      },
      s3: {
        ...body.s3,
        secretAccessKey: body.s3.secretAccessKey?.length
          ? body.s3.secretAccessKey
          : current.s3.secretAccessKey,
      },
    };
  }

  app.get('/backup-target', { preHandler: requireAdmin }, async () => {
    const current = await getTarget();
    return { target: publicTarget(current), status: await testTarget(current) };
  });

  app.put('/backup-target', { preHandler: requireAdmin }, async (req) => {
    const merged = await merge(targetSchema.parse(req.body));
    assertComplete(merged);

    // Erst prüfen, dann speichern: eine kaputte Angabe soll nicht dazu führen,
    // dass ab jetzt jede nächtliche Sicherung still scheitert.
    const status = await testTarget(merged);
    if (!status.ok) return { ok: false, status, target: publicTarget(await getTarget()) };

    await saveTarget(merged);
    await audit(req.user!.id, null, 'settings.backupTarget', merged.kind);
    return { ok: true, status, target: publicTarget(merged) };
  });

  app.post('/backup-target/test', { preHandler: requireAdmin }, async (req) => {
    const merged = await merge(targetSchema.parse(req.body));
    return testTarget(merged);
  });

  app.get('/audit', { preHandler: requireAdmin }, async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 100);
    return prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(500, limit),
      include: {
        user: { select: { id: true, username: true } },
        server: { select: { id: true, name: true } },
      },
    });
  });
}
