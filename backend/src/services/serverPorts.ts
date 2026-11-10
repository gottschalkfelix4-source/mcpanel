/**
 * Zusatzports der Server pflegen.
 *
 * Vor jedem Start schaut das Panel nach, welche Erweiterungen mit eigenem
 * Port installiert sind (`modPorts.ts`), vergibt kollisionsfreie Hostports,
 * schreibt sie bei Bedarf in die Konfiguration der Erweiterung und hinterlegt
 * sie in `ServerPort`. Der Container bekommt die Freigaben über
 * `portBindings()`, der Router (UniFi) über `unifi.ts`.
 *
 * Vergeben wird unter einer panelweiten Warteschlange, damit zwei gleichzeitig
 * startende Server nicht denselben Port erwischen.
 */
import type { Server, ServerPort } from '@prisma/client';
import { serverDir } from '../config.js';
import { prisma } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { replaceAllExtraPorts, setExtraPorts, type PortProtocol } from '../lib/serverPorts.js';
import { nodeIdOf } from '../lib/serverLocation.js';
import { detectModPorts, MOD_PORTS, writeModPort } from './modPorts.js';
import { withQueuedOperation } from './operations.js';
import { getProxyConfig } from './proxy.js';
import { getSetting, setSetting } from './settings.js';

const QUEUE = 'panel-ports';
export const MANUAL_SOURCE = 'manual';

/** Ports, die Spielern nicht vergeben werden – Panel, SSH, Samba & Co. */
const RESERVED = new Set([22, 53, 80, 443, 445, 2375, 2376, 3000, 5432, 7480, 7481, 8080, 8443, 51820]);

/** Stand der Datenbank in die synchrone Registry übernehmen (Bootstrap). */
export async function loadServerPorts(): Promise<void> {
  const rows = await prisma.serverPort.findMany();
  replaceAllExtraPorts(rows.map((row) => ({ ...row, protocol: row.protocol as PortProtocol })));
}

async function refreshRegistry(serverId: string): Promise<ServerPort[]> {
  const rows = await prisma.serverPort.findMany({ where: { serverId }, orderBy: { hostPort: 'asc' } });
  setExtraPorts(serverId, rows.map((row) => ({ ...row, protocol: row.protocol as PortProtocol })));
  return rows;
}

/**
 * Hostports, die ein fremder Dienst auf dem Docker-Host belegt (z. B. Home
 * Assistant auf 8123). Docker meldet das erst beim Start – das Panel merkt
 * sich den Port und vergibt ihn nie wieder.
 */
const BUSY_KEY = 'ports.hostBusy';

async function busyPorts(): Promise<number[]> {
  try {
    const list = JSON.parse(await getSetting(BUSY_KEY, '[]')) as unknown;
    return Array.isArray(list) ? list.filter((port): port is number => Number.isInteger(port)) : [];
  } catch {
    return [];
  }
}

/** Hostports, die bereits jemand anderes nutzt. */
async function takenPorts(exceptServerId?: string): Promise<Set<number>> {
  const [servers, extra, proxy, busy] = await Promise.all([
    prisma.server.findMany({ select: { port: true } }),
    prisma.serverPort.findMany({ where: exceptServerId ? { serverId: { not: exceptServerId } } : {}, select: { hostPort: true } }),
    getProxyConfig(),
    busyPorts(),
  ]);
  const taken = new Set<number>([...RESERVED, ...busy]);
  for (const server of servers) taken.add(server.port);
  for (const port of extra) taken.add(port.hostPort);
  if (proxy.enabled) taken.add(proxy.port);
  return taken;
}

/** Nächster freier Port ab dem Wunschport, notfalls ab 1024 von vorn. */
export function nextFreePort(preferred: number, taken: Set<number>): number {
  for (let port = preferred; port <= 65535; port++) if (!taken.has(port)) return port;
  for (let port = 1024; port < preferred; port++) if (!taken.has(port)) return port;
  throw conflict('Kein freier Port mehr verfügbar');
}

export interface PortSyncResult {
  ports: ServerPort[];
  /** Hat sich an den Freigaben etwas geändert? */
  changed: boolean;
  /** Was das Panel dabei getan hat – für Protokoll und Oberfläche */
  notes: string[];
}

/**
 * Erweiterungen erkennen und Ports abgleichen. Erwartet einen gestoppten
 * Server (Aufruf vor dem Start), weil Konfigurationen umgeschrieben werden.
 */
export function syncServerPorts(server: Server): Promise<PortSyncResult> {
  return withQueuedOperation(QUEUE, 'Portvergabe', () => syncUnlocked(server));
}

async function syncUnlocked(server: Server): Promise<PortSyncResult> {
  const root = serverDir(server.id);
  const onNode = nodeIdOf(server.id) !== null;
  const allDetected = await detectModPorts(root);
  // Nur-Panel-Erweiterungen (BlueMap) bekommen lokal keinen veröffentlichten Port.
  const detected = allDetected.filter((found) => !found.spec.internal || onNode);
  const existing = await prisma.serverPort.findMany({ where: { serverId: server.id } });
  const taken = await takenPorts(server.id);
  // Manuelle Ports dieses Servers gelten ebenfalls als belegt.
  for (const row of existing) if (row.source === MANUAL_SOURCE) taken.add(row.hostPort);

  const notes: string[] = [];
  let changed = false;

  for (const found of detected) {
    const row = existing.find((entry) => entry.source === found.spec.key);
    let hostPort: number;
    if (found.spec.samePort && !taken.has(found.containerPort)) {
      // Von Hand in der Konfiguration geänderter Port gewinnt, solange er frei ist.
      hostPort = found.containerPort;
    } else if (row && !taken.has(row.hostPort)) {
      hostPort = row.hostPort;
    } else {
      hostPort = nextFreePort(found.containerPort, taken);
    }
    let containerPort = found.containerPort;

    // Teilt die Erweiterung ihren Port selbst mit, müssen beide gleich sein.
    if (found.spec.samePort && hostPort !== containerPort) {
      const file = await writeModPort(root, found, hostPort);
      notes.push(`${found.spec.label}: Port ${containerPort} ist belegt – ${hostPort} in ${file} eingetragen.`);
      containerPort = hostPort;
    }
    taken.add(hostPort);

    if (!row) {
      await prisma.serverPort.create({
        data: {
          serverId: server.id, source: found.spec.key, label: found.spec.label,
          protocol: found.spec.protocol, hostPort, containerPort,
          // Nur für das Panel: nie im Router freigeben.
          ...(found.spec.internal ? { forward: false } : {}),
        },
      });
      notes.push(found.spec.internal
        ? `${found.spec.label} erkannt – Port ${hostPort} nur für das Panel (ohne Router-Freigabe).`
        : `${found.spec.label} erkannt – Port ${hostPort}/${found.spec.protocol.replace('_', '+')} freigegeben.`);
      changed = true;
    } else if (row.hostPort !== hostPort || row.containerPort !== containerPort || row.protocol !== found.spec.protocol) {
      await prisma.serverPort.update({
        where: { id: row.id },
        data: { hostPort, containerPort, protocol: found.spec.protocol, label: found.spec.label },
      });
      notes.push(`${found.spec.label}: Port auf ${hostPort} angepasst.`);
      changed = true;
    }
  }

  // Erweiterungen, die nicht mehr installiert sind, geben ihren Port frei.
  const gone = existing.filter((row) => row.source !== MANUAL_SOURCE && !detected.some((found) => found.spec.key === row.source));
  if (gone.length > 0) {
    await prisma.serverPort.deleteMany({ where: { id: { in: gone.map((row) => row.id) } } });
    for (const row of gone) {
      notes.push(allDetected.some((found) => found.spec.key === row.source)
        ? `${row.label} läuft nur noch über das Panel – Port ${row.hostPort} geschlossen.`
        : `${row.label} nicht mehr installiert – Port ${row.hostPort} freigegeben.`);
    }
    changed = true;
  }

  const ports = await refreshRegistry(server.id);
  return { ports, changed, notes };
}

export async function listServerPorts(serverId: string): Promise<ServerPort[]> {
  return prisma.serverPort.findMany({ where: { serverId }, orderBy: { hostPort: 'asc' } });
}

export interface ManualPortInput {
  label: string;
  protocol: PortProtocol;
  hostPort: number;
  containerPort?: number;
}

/** Eigenen Port ergänzen (nur Administratoren) – für Erweiterungen, die das Panel nicht kennt. */
export function addManualPort(server: Server, input: ManualPortInput): Promise<ServerPort> {
  return withQueuedOperation(QUEUE, 'Portvergabe', async () => {
    const taken = await takenPorts();
    if (taken.has(input.hostPort)) throw conflict(`Port ${input.hostPort} ist bereits vergeben oder reserviert`);
    const row = await prisma.serverPort.create({
      data: {
        serverId: server.id, source: MANUAL_SOURCE, label: input.label, protocol: input.protocol,
        hostPort: input.hostPort, containerPort: input.containerPort ?? input.hostPort,
      },
    });
    await refreshRegistry(server.id);
    return row;
  });
}

export function removeManualPort(serverId: string, portId: string): Promise<void> {
  return withQueuedOperation(QUEUE, 'Portvergabe', async () => {
    const row = await prisma.serverPort.findFirst({ where: { id: portId, serverId } });
    if (!row) throw notFound('Port nicht gefunden');
    if (row.source !== MANUAL_SOURCE) {
      throw badRequest('Erkannte Ports verschwinden von selbst, sobald die Erweiterung entfernt ist. Die Router-Freigabe lässt sich abschalten.');
    }
    await prisma.serverPort.delete({ where: { id: row.id } });
    await refreshRegistry(serverId);
  });
}

export async function setPortForward(serverId: string, portId: string, forward: boolean): Promise<ServerPort> {
  const row = await prisma.serverPort.findFirst({ where: { id: portId, serverId } });
  if (!row) throw notFound('Port nicht gefunden');
  return prisma.serverPort.update({ where: { id: row.id }, data: { forward } });
}

/** Hostport eines Zusatzports? Für die Prüfung beim Ändern des Spielports. */
export async function isExtraHostPort(port: number): Promise<boolean> {
  return (await prisma.serverPort.count({ where: { hostPort: port } })) > 0;
}

/**
 * Docker konnte einen Zusatzport nicht binden – ein anderer Dienst auf dem
 * Host nutzt ihn. Port dauerhaft meiden und einen freien vergeben. Liefert
 * `true`, wenn ein neuer Port eingetragen wurde (der Start wird dann wiederholt).
 */
export function reassignBusyPort(server: Server, hostPort: number): Promise<boolean> {
  return withQueuedOperation(QUEUE, 'Portvergabe', async () => {
    const row = await prisma.serverPort.findFirst({ where: { serverId: server.id, hostPort } });
    if (!row) return false;
    const busy = await busyPorts();
    if (!busy.includes(hostPort)) await setSetting(BUSY_KEY, JSON.stringify([...busy, hostPort].slice(-200)));

    const taken = await takenPorts(server.id);
    for (const other of await prisma.serverPort.findMany({ where: { serverId: server.id } })) taken.add(other.hostPort);
    const next = nextFreePort(hostPort + 1, taken);

    let containerPort = row.containerPort;
    const spec = MOD_PORTS.find((entry) => entry.key === row.source);
    if (spec?.samePort) {
      const found = (await detectModPorts(serverDir(server.id))).find((entry) => entry.spec.key === spec.key);
      if (found) {
        await writeModPort(serverDir(server.id), found, next);
        containerPort = next;
      }
    }
    await prisma.serverPort.update({ where: { id: row.id }, data: { hostPort: next, containerPort } });
    await refreshRegistry(server.id);
    console.warn(`[ports] ${server.name}: Port ${hostPort} ist auf dem Host belegt – ${row.label} nutzt jetzt ${next}.`);
    return true;
  });
}
