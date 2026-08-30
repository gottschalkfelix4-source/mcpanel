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

  // --- Einzelne Mods -----------------------------------------------------

  app.get('/mods', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_READ);
    const dir = path.join(serverDir(access.server.id), 'mods');
    const entries = await fs.readdir(dir).catch(() => [] as string[]);

    const mods = [];
    for (const name of entries) {
      if (!/\.jar(\.disabled)?$/i.test(name)) continue;
      const stat = await fs.stat(path.join(dir, name)).catch(() => null);
      if (!stat) continue;
      mods.push({
        filename: name,
        displayName: name.replace(/\.jar(\.disabled)?$/i, ''),
        enabled: !name.endsWith('.disabled'),
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }
    mods.sort((a, b) => a.displayName.localeCompare(b.displayName, 'de', { numeric: true }));
    return { mods };
  });

  /** Einzelne Mod von Modrinth/CurseForge in mods/ ablegen. */
  app.post('/mods/install', async (req) => {
    const access = await requireServer(req, PERMISSIONS.MODPACK_MANAGE);
    const body = z
      .object({
        provider: z.enum(['modrinth', 'curseforge']),
        projectId: z.string().min(1),
        versionId: z.string().min(1),
      })
      .parse(req.body);

    const version =
      body.provider === 'modrinth'
        ? await modrinth.getVersion(body.versionId)
        : await curseforge.getVersion(body.projectId, body.versionId);

    let url = version.downloadUrl;
    if (!url && body.provider === 'curseforge') {
      url = await curseforge.resolveDownloadUrl(body.projectId, body.versionId, version.filename);
    }
    if (!url) throw badRequest('Für diese Datei ist kein automatischer Download erlaubt');

    const target = path.join(serverDir(access.server.id), 'mods', path.basename(version.filename));
    await downloadToFile(url, target, {
      headers: body.provider === 'modrinth' ? modrinth.modrinthHeaders() : undefined,
    });

    await audit(req.user!.id, access.server.id, 'mod.install', version.filename);
    return { ok: true, filename: version.filename };
  });

  app.post('/mods/toggle', async (req) => {
    const access = await requireServer(req, PERMISSIONS.MODPACK_MANAGE);
    const body = z.object({ filename: z.string().min(1) }).parse(req.body);
    const safe = path.basename(body.filename);
    const dir = path.join(serverDir(access.server.id), 'mods');

    const from = path.join(dir, safe);
    const to = safe.endsWith('.disabled')
      ? path.join(dir, safe.replace(/\.disabled$/, ''))
      : path.join(dir, safe + '.disabled');

    await fs.rename(from, to);
    return { ok: true, enabled: !to.endsWith('.disabled') };
  });

  app.delete('/mods', async (req) => {
    const access = await requireServer(req, PERMISSIONS.MODPACK_MANAGE);
    const body = z.object({ filenames: z.array(z.string().min(1)).min(1) }).parse(req.body);
    const dir = path.join(serverDir(access.server.id), 'mods');

    for (const name of body.filenames) {
      await fs.rm(path.join(dir, path.basename(name)), { force: true });
    }
    await audit(req.user!.id, access.server.id, 'mod.delete', body.filenames.join(', ').slice(0, 200));
    return { ok: true };
  });
}
