import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serverDir } from '../config.js';
import { audit, requireServer } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { badRequest } from '../lib/errors.js';
import { downloadToFile } from '../lib/download.js';
import * as modrinth from '../providers/modrinth.js';
import * as curseforge from '../providers/curseforge.js';
import { checkForUpdate, installModpack, listVersions } from '../services/modpack.js';
import { runTask } from '../services/tasks.js';

const installSchema = z.object({
  provider: z.enum(['modrinth', 'curseforge']),
  projectId: z.string().min(1),
  versionId: z.string().min(1),
  backupFirst: z.boolean().optional(),
  keepConfig: z.boolean().optional(),
  startAfter: z.boolean().optional(),
});

export default async function modpackRoutes(app: FastifyInstance) {
  /** Aktuell installiertes Modpack + Update-Prüfung. */
  app.get('/', async (req) => {
    const access = await requireServer(req);
    const server = access.server;

    if (!server.modpackProjectId) {
      return { installed: null, update: null };
    }

    let update = null;
    try {
      update = await checkForUpdate(server);
    } catch (err) {
      update = { error: err instanceof Error ? err.message : 'Update-Prüfung fehlgeschlagen' };
    }

    return {
      installed: {
        provider: server.modpackProvider,
        projectId: server.modpackProjectId,
        versionId: server.modpackVersionId,
        name: server.modpackName,
        versionName: server.modpackVersionName,
        iconUrl: server.modpackIconUrl,
        minecraftVersion: server.mcVersion,
        loader: (server.extraEnv as Record<string, string>)?.TYPE ?? server.type,
      },
      update,
    };
  });

  /** Alle Versionen des gebundenen Modpacks (für gezielten Wechsel). */
  app.get('/versions', async (req) => {
    const access = await requireServer(req);
    const server = access.server;
    if (!server.modpackProjectId || !server.modpackProvider) return { versions: [] };
    return {
      versions: await listVersions(
        server.modpackProvider as 'modrinth' | 'curseforge',
        server.modpackProjectId,
      ),
    };
  });

  /** Modpack installieren oder auf eine bestimmte Version wechseln. */
  app.post('/install', async (req) => {
    const access = await requireServer(req, PERMISSIONS.MODPACK_MANAGE);
    const body = installSchema.parse(req.body);

    const taskId = await runTask(access.server.id, 'modpack.install', async (task) => {
      await installModpack(access.server.id, body, task);
    });

    await audit(req.user!.id, access.server.id, 'modpack.install', `${body.provider}/${body.projectId}`);
    return { ok: true, taskId };
  });

  /** Auf die neueste Version aktualisieren. */
  app.post('/update', async (req) => {
    const access = await requireServer(req, PERMISSIONS.MODPACK_MANAGE);
    const server = access.server;
    if (!server.modpackProjectId || !server.modpackProvider) {
      throw badRequest('Auf diesem Server ist kein Modpack installiert');
    }

    const info = await checkForUpdate(server);
    if (!info?.latest) throw badRequest('Keine Versionen gefunden');
    if (!info.updateAvailable) return { ok: true, alreadyLatest: true };

    const options = z
      .object({ backupFirst: z.boolean().default(true), keepConfig: z.boolean().default(false) })
      .parse(req.body ?? {});

    const taskId = await runTask(server.id, 'modpack.update', async (task) => {
      await installModpack(
        server.id,
        {
          provider: server.modpackProvider as 'modrinth' | 'curseforge',
          projectId: server.modpackProjectId!,
          versionId: info.latest.id,
          ...options,
        },
        task,
      );
    });

    await audit(req.user!.id, server.id, 'modpack.update', info.latest.name);
    return { ok: true, taskId, version: info.latest };
  });

  /** Modpack-Bindung lösen (Dateien bleiben liegen). */
  app.delete('/', async (req) => {
    const access = await requireServer(req, PERMISSIONS.MODPACK_MANAGE);
    const { prisma } = await import('../db.js');
    await prisma.server.update({
      where: { id: access.server.id },
      data: {
        modpackProvider: null,
        modpackProjectId: null,
        modpackVersionId: null,
        modpackName: null,
        modpackVersionName: null,
        modpackIconUrl: null,
      },
    });
    return { ok: true };
  });
}
