import type { FastifyInstance } from 'fastify';
import type { ServerPort } from '@prisma/client';
import { z } from 'zod';
import { audit, requireServer } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { forbidden } from '../lib/errors.js';
import { nodeLocation } from '../lib/serverLocation.js';
import * as dockerSvc from '../services/docker.js';
import {
  addManualPort, listServerPorts, MANUAL_SOURCE, removeManualPort, setPortForward, syncServerPorts,
} from '../services/serverPorts.js';
import { withServerOperation } from '../services/operations.js';
import { getPublicHost } from '../services/settings.js';
import { getUnifiConfig, lastSyncStatus, ruleName, scheduleUnifiSync } from '../services/unifi.js';

type RouterState = 'off' | 'disabled' | 'forwarded' | 'conflict' | 'skipped' | 'pending' | 'error';

/** Zusatzports eines Servers (`/api/servers/:id/ports`). */
export default async function portRoutes(app: FastifyInstance) {
  /** Router-Details (Fehlertexte, Namen fremder Regeln) sehen nur Administratoren. */
  async function describe(serverName: string, nodeId: string | null, rows: ServerPort[], isAdmin: boolean) {
    const [config, host] = await Promise.all([getUnifiConfig(), getPublicHost()]);
    const status = lastSyncStatus();
    const playerHost = (nodeId ? nodeLocation(nodeId)?.publicHost : null) ?? host;
    return {
      unifi: { enabled: config.enabled, lastSync: status?.at ?? null, error: status?.error ? (isAdmin ? status.error : 'Abgleich fehlgeschlagen') : null },
      ports: rows.map((row) => {
        const name = ruleName(serverName, row.label);
        let router: RouterState;
        let routerNote: string | null = null;
        if (!config.enabled) router = 'disabled';
        else if (!row.forward) router = 'off';
        else if (!status) router = 'pending';
        else if (status.error) { router = 'error'; routerNote = isAdmin ? status.error : null; }
        else if (status.conflicts.some((c) => c.port === row.hostPort)) {
          router = 'conflict';
          routerNote = isAdmin
            ? `Port ist im Router bereits durch „${status.conflicts.find((c) => c.port === row.hostPort)!.existing}“ belegt`
            : 'Port ist im Router bereits belegt';
        } else if (status.skipped.some((s) => s.name === name)) {
          router = 'skipped';
          routerNote = status.skipped.find((s) => s.name === name)!.reason;
        } else if (status.rules.some((r) => r.port === row.hostPort)) router = 'forwarded';
        else router = 'pending';
        return {
          id: row.id,
          label: row.label,
          source: row.source,
          manual: row.source === MANUAL_SOURCE,
          protocol: row.protocol,
          hostPort: row.hostPort,
          containerPort: row.containerPort,
          forward: row.forward,
          address: `${playerHost.includes(':') && !playerHost.startsWith('[') ? `[${playerHost}]` : playerHost}:${row.hostPort}`,
          router,
          routerNote,
        };
      }),
    };
  }

  app.get('/', async (req) => {
    const access = await requireServer(req);
    return describe(access.server.name, access.server.nodeId, await listServerPorts(access.server.id), access.isAdmin);
  });

  /** Jetzt nach Erweiterungen suchen (sonst passiert das vor jedem Start). */
  app.post('/detect', async (req) => {
    const access = await requireServer(req, PERMISSIONS.SETTINGS_EDIT);
    // Unter der Serversperre: die Erkennung kann Konfigurationen umschreiben.
    const result = await withServerOperation(access.server.id, 'Die Port-Erkennung', () => syncServerPorts(access.server));
    if (result.changed) scheduleUnifiSync();
    const state = await dockerSvc.getState(access.server).catch(() => null);
    const running = state?.state === 'running' || state?.state === 'starting';
    return {
      ...(await describe(access.server.name, access.server.nodeId, result.ports, access.isAdmin)),
      notes: result.notes,
      restartNeeded: result.changed && running,
    };
  });

  const manualSchema = z.object({
    label: z.string().trim().min(1).max(40),
    protocol: z.enum(['tcp', 'udp', 'tcp_udp']),
    hostPort: z.number().int().min(1024).max(65535),
    containerPort: z.number().int().min(1).max(65535).optional(),
  });

  app.post('/', async (req) => {
    const access = await requireServer(req);
    if (!access.isAdmin) throw forbidden('Eigene Ports vergibt nur ein Administrator');
    const body = manualSchema.parse(req.body);
    const row = await addManualPort(access.server, body);
    await audit(req.user!.id, access.server.id, 'server.port.add', `${body.label} ${body.hostPort}/${body.protocol}`);
    scheduleUnifiSync();
    return row;
  });

  app.patch('/:portId', async (req) => {
    const access = await requireServer(req);
    if (!access.isAdmin) throw forbidden('Router-Freigaben ändert nur ein Administrator');
    const { portId } = req.params as { portId: string };
    const { forward } = z.object({ forward: z.boolean() }).parse(req.body);
    const row = await setPortForward(access.server.id, portId, forward);
    await audit(req.user!.id, access.server.id, 'server.port.forward', `${row.label} ${forward ? 'an' : 'aus'}`);
    scheduleUnifiSync();
    return row;
  });

  app.delete('/:portId', async (req) => {
    const access = await requireServer(req);
    if (!access.isAdmin) throw forbidden('Eigene Ports entfernt nur ein Administrator');
    const { portId } = req.params as { portId: string };
    await removeManualPort(access.server.id, portId);
    await audit(req.user!.id, access.server.id, 'server.port.remove', portId);
    scheduleUnifiSync();
    return { ok: true };
  });
}
