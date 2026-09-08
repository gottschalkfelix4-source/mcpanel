import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, requireServer } from '../auth/context.js';
import type { Permission } from '../auth/permissions.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { badRequest } from '../lib/errors.js';
import { downloadToFile } from '../lib/download.js';
import * as modrinth from '../providers/modrinth.js';
import * as curseforge from '../providers/curseforge.js';
import { contentDir, contentDirName, contentKindFor } from '../services/content.js';
import { analyseCrash } from '../services/crashAnalysis.js';
import * as dockerSvc from '../services/docker.js';
import { guardMutations } from './mutationGuard.js';
import { remainingDiskBytes } from '../services/quota.js';
import { safePath } from '../lib/safePath.js';

/**
 * Einzelne Mods bzw. Plugins eines Servers. Beides ist derselbe Vorgang - eine
 * .jar in einem Verzeichnis, das der Server beim Start einliest -, nur der
 * Ordner unterscheidet sich. Deshalb eine Route statt zweier.
 */
export default async function contentRoutes(app: FastifyInstance) {
  guardMutations(app);
  /** Verzeichnis des Servers, oder eine Absage bei VANILLA. */
  async function requireDir(req: FastifyRequest, permission: Permission) {
    const access = await requireServer(req, permission);
    const dir = contentDir(access.server);
    if (!dir) {
      throw badRequest(
        'Dieser Servertyp lädt weder Mods noch Plugins. Stelle den Typ unter Einstellungen um.',
      );
    }
    return { access, dir };
  }

  app.get('/', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_READ);
    const kind = contentKindFor(access.server.type);
    if (!kind) return { kind: null, dirName: null, items: [] };

    const dir = contentDir(access.server)!;
    const entries = await fs.readdir(dir).catch(() => [] as string[]);

    const items = [];
    for (const name of entries) {
      if (!/\.jar(\.disabled)?$/i.test(name)) continue;
      const stat = await fs.stat(path.join(dir, name)).catch(() => null);
      if (!stat) continue;
      items.push({
        filename: name,
        displayName: name.replace(/\.jar(\.disabled)?$/i, ''),
        enabled: !name.endsWith('.disabled'),
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }
    items.sort((a, b) => a.displayName.localeCompare(b.displayName, 'de', { numeric: true }));
    return { kind, dirName: contentDirName(kind), items };
  });

  /** Einzelne Mod bzw. einzelnes Plugin von Modrinth/CurseForge ablegen. */
  app.post('/install', async (req) => {
    const { access, dir } = await requireDir(req, PERMISSIONS.MODPACK_MANAGE);
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

    await fs.mkdir(dir, { recursive: true });
    const target = safePath(dir, path.basename(version.filename));
    const old = await fs.stat(target).catch(() => null);
    await downloadToFile(url, target, {
      maxBytes: await remainingDiskBytes(access.server) + (old?.size ?? 0),
      headers: body.provider === 'modrinth' ? modrinth.modrinthHeaders() : undefined,
    });

    const kind = contentKindFor(access.server.type)!;
    await audit(req.user!.id, access.server.id, `${kind}.install`, version.filename);
    return { ok: true, filename: version.filename };
  });

  app.post('/toggle', async (req) => {
    const { dir } = await requireDir(req, PERMISSIONS.MODPACK_MANAGE);
    const body = z.object({ filename: z.string().min(1) }).parse(req.body);
    const safe = path.basename(body.filename);

    const from = path.join(dir, safe);
    const to = safe.endsWith('.disabled')
      ? path.join(dir, safe.replace(/\.disabled$/, ''))
      : path.join(dir, safe + '.disabled');

    await fs.rename(from, to);
    return { ok: true, enabled: !to.endsWith('.disabled') };
  });

  app.delete('/', async (req) => {
    const { access, dir } = await requireDir(req, PERMISSIONS.MODPACK_MANAGE);
    const body = z.object({ filenames: z.array(z.string().min(1)).min(1) }).parse(req.body);

    for (const name of body.filenames) {
      await fs.rm(path.join(dir, path.basename(name)), { force: true });
    }
    const kind = contentKindFor(access.server.type)!;
    await audit(
      req.user!.id,
      access.server.id,
      `${kind}.delete`,
      body.filenames.join(', ').slice(0, 200),
    );
    return { ok: true };
  });

  /**
   * Warum sich der Server beendet hat. Liefert `null`, wenn sich im Protokoll
   * keine einzelne Datei benennen laesst - lieber nichts sagen als die falsche
   * Mod beschuldigen.
   */
  app.get('/diagnose', async (req) => {
    const access = await requireServer(req, PERMISSIONS.CONSOLE_READ);
    const dir = contentDir(access.server);
    if (!dir) return { diagnosis: null };

    const log = await dockerSvc.tailLogs(access.server, 200).catch(() => '');
    const dateien = await fs.readdir(dir).catch(() => [] as string[]);
    return { diagnosis: analyseCrash(log, dateien) };
  });
}
