import { guardMutations } from './mutationGuard.js';
import { remainingDiskBytes } from '../services/quota.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, requireServer } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import {
  PROPERTY_FIELDS,
  readJsonList,
  readProperties,
  saveProperties,
} from '../services/properties.js';
import { rconCommand } from '../services/rcon.js';
import * as dockerSvc from '../services/docker.js';

export default async function configRoutes(app: FastifyInstance) {
  guardMutations(app);
  /** server.properties inkl. Feldbeschreibung für die UI. */
  app.get('/properties', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_READ);
    const props = await readProperties(access.server.id);
    return { fields: PROPERTY_FIELDS, ...props };
  });

  app.put('/properties', async (req) => {
    const access = await requireServer(req, PERMISSIONS.CONFIG_EDIT);
    const body = z.object({ values: z.record(z.string()) }).parse(req.body);
    await saveProperties(access.server.id, body.values, await remainingDiskBytes(access.server));
    await audit(req.user!.id, access.server.id, 'config.properties', Object.keys(body.values).join(','));
    const { state } = await dockerSvc.getState(access.server);
    return { ok: true, restartRequired: state === 'running' };
  });

  /** Java-/Container-Umgebung (nur Besitzer & Admins sinnvoll). */
  app.get('/environment', async (req) => {
    const access = await requireServer(req, PERMISSIONS.SETTINGS_EDIT);
    return {
      extraEnv: access.server.extraEnv ?? {},
      memoryMb: access.server.memoryMb,
      mcVersion: access.server.mcVersion,
      type: access.server.type,
      autoStart: access.server.autoStart,
      image: dockerSvc.imageForServer(access.server),
      effective: dockerSvc.buildEnv(access.server),
    };
  });

  /** Operatoren, Whitelist und Bans. */
  app.get('/players', async (req) => {
    const access = await requireServer(req, PERMISSIONS.FILES_READ);
    const [ops, whitelist, banned] = await Promise.all([
      readJsonList<{ uuid: string; name: string; level: number }>(access.server.id, 'ops.json'),
      readJsonList<{ uuid: string; name: string }>(access.server.id, 'whitelist.json'),
      readJsonList<{ uuid: string; name: string; reason?: string }>(
        access.server.id,
        'banned-players.json',
      ),
    ]);
    return { ops, whitelist, banned };
  });

  /** Spieleraktionen laufen über RCON, damit sie sofort greifen. */
  app.post('/players/:action', async (req) => {
    const access = await requireServer(req, PERMISSIONS.CONFIG_EDIT);
    const { action } = req.params as { action: string };
    const body = z.object({ player: z.string().min(1).max(32), reason: z.string().optional() }).parse(req.body);

    const commands: Record<string, string> = {
      op: `op ${body.player}`,
      deop: `deop ${body.player}`,
      whitelistAdd: `whitelist add ${body.player}`,
      whitelistRemove: `whitelist remove ${body.player}`,
      ban: `ban ${body.player}${body.reason ? ' ' + body.reason : ''}`,
      pardon: `pardon ${body.player}`,
      kick: `kick ${body.player}${body.reason ? ' ' + body.reason : ''}`,
    };

    const command = commands[action];
    if (!command) return { ok: false, error: 'Unbekannte Aktion' };

    const response = await rconCommand(access.server, command);
    await audit(req.user!.id, access.server.id, `player.${action}`, body.player);
    return { ok: true, response };
  });
}
