/**
 * Gemeinsame Absprachen zwischen Panel und Node-Agent. Beide laufen aus
 * demselben Abbild – trotzdem steht hier alles an einer Stelle, damit eine
 * Änderung nicht nur auf einer Seite landet.
 */
import crypto from 'node:crypto';
import { z } from 'zod';

/** Samba-Freigabe mit dem Datenverzeichnis der Node. */
export const SMB_SHARE = 'mcpanel';
export const SMB_USER = 'mcpanel';
/** Markierungsdatei in der Freigabe – beweist, dass die richtige Freigabe hängt. */
export const NODE_MARKER = '.mcpanel-node';
/**
 * Kopfzeile mit dem Agent-Geheimnis. Jede Verbindung zur Docker-API muss es in
 * ihrer ersten Anfrage tragen. Im Tunnel ist das die zweite Absicherung neben
 * WireGuard, ohne VPN die erste: dort könnte sonst jeder Rechner – und jeder
 * Minecraft-Container hinter NAT – im LAN die Node übernehmen.
 */
export const AGENT_TOKEN_HEADER = 'x-mcpanel-token';
/** Erste Zeile einer RCON-Verbindung über den Agenten: `MCPANEL-RCON <token> <container>` */
export const RCON_PREAMBLE = 'MCPANEL-RCON';
/** Name des Docker-Volumes mit den Serverdaten auf Windows-Nodes. */
export const WINDOWS_DATA_VOLUME = 'mcpanel-node-data';
/** Datenverzeichnis im Agent-Container auf Windows (liegt im Volume). */
export const WINDOWS_DATA_ROOT = '/opt/mcpanel-node';

export type NodeConnection = 'wireguard' | 'direct';
/**
 * `linux`: Agent im Host-Netz eines Linux-Rechners, Daten als Ordner auf dem Host.
 * `windows`: Docker Desktop. Kein Host-Netz, Port 445 gehört Windows selbst,
 * Bind-Mounts von NTFS sind langsam – der Agent läuft deshalb im Bridge-Netz
 * mit veröffentlichten Ports, die Daten liegen in einem Docker-Volume.
 */
export type NodePlatform = 'linux' | 'windows';

export interface AgentPorts {
  /** Docker-API (Socket-Proxy mit Token) */
  docker: number;
  /** Zustandsabfrage */
  status: number;
  /** RCON-Weiterleitung zu den Minecraft-Containern */
  rcon: number;
  /** Samba */
  smb: number;
}

/** Ports, unter denen der Agent im Container lauscht. */
export const AGENT_INTERNAL_PORTS: AgentPorts = { docker: 2375, status: 7480, rcon: 7481, smb: 445 };
/**
 * Auf Windows ohne VPN veröffentlicht Docker Desktop die Dienste am Windows-
 * Rechner selbst. Dort ist 445 die Windows-Dateifreigabe und 2375 oft der
 * Docker-Daemon – also ein eigener, unauffälliger Bereich.
 */
export const WINDOWS_PUBLISHED_PORTS: AgentPorts = { docker: 24375, status: 24480, rcon: 24481, smb: 24445 };

/** Ports, unter denen das Panel den Agenten erreicht. */
export function agentPorts(platform: NodePlatform, connection: NodeConnection): AgentPorts {
  // Im Tunnel spricht das Panel den Agenten direkt in dessen Netz an.
  return platform === 'windows' && connection === 'direct' ? WINDOWS_PUBLISHED_PORTS : AGENT_INTERNAL_PORTS;
}

export const nodeProfileSchema = z.object({
  v: z.literal(1),
  nodeId: z.string().min(1),
  name: z.string().min(1),
  mode: z.enum(['wireguard', 'direct']).default('wireguard'),
  platform: z.enum(['linux', 'windows']).default('linux'),
  /**
   * Adresse, unter der das Panel die Node erreicht: Tunneladresse bzw. LAN-IP.
   * Auf Windows ohne VPN gehört sie dem Windows-Rechner, nicht dem Agenten.
   */
  nodeIp: z.string().ip({ version: 'v4' }),
  token: z.string().min(32),
  smbPassword: z.string().min(16),
  dataRoot: z.string().startsWith('/'),
  /** Docker-Netz der Minecraft-Container auf der Node (für die RCON-Weiterleitung) */
  dockerNetwork: z.string().min(1).default('mcpanel_mcpanel'),
  // Nur im Tunnelbetrieb:
  privateKey: z.string().min(40).optional(),
  listenPort: z.number().int().min(1).max(65535).optional(),
  prefix: z.number().int().min(8).max(30).optional(),
  panelIp: z.string().ip({ version: 'v4' }).optional(),
  panelPublicKey: z.string().min(40).optional(),
}).refine(
  (profile) => profile.mode === 'direct' || Boolean(profile.privateKey && profile.listenPort && profile.prefix && profile.panelIp && profile.panelPublicKey),
  { message: 'Im Tunnelbetrieb fehlen WireGuard-Angaben' },
);

export type NodeProfile = z.infer<typeof nodeProfileSchema>;

/** Vergleich in konstanter Zeit – das Token soll sich nicht Zeichen für Zeichen erraten lassen. */
export function tokenMatches(expected: string, given: string | undefined | null): boolean {
  if (!given) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Nur Containernamen, wie das Panel sie vergibt – nichts, was die Docker-API umbiegen könnte. */
export const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function rconPreamble(token: string, containerName: string): string {
  if (!CONTAINER_NAME_PATTERN.test(containerName)) throw new Error('Ungültiger Containername');
  return `${RCON_PREAMBLE} ${token} ${containerName}\n`;
}

/** Gegenstück im Agenten; `null` bei allem, was nicht genau so aussieht. */
export function parseRconPreamble(line: string): { token: string; container: string } | null {
  const parts = line.trim().split(' ');
  if (parts.length !== 3 || parts[0] !== RCON_PREAMBLE || !CONTAINER_NAME_PATTERN.test(parts[2])) return null;
  return { token: parts[1], container: parts[2] };
}

export interface AgentStatus {
  nodeId: string;
  version: string;
  hostname: string;
  kernel: string;
  uptimeSec: number;
  cpus: number;
  /** Lastmittel über 1, 5 und 15 Minuten */
  load: [number, number, number];
  memTotalMb: number;
  memAvailableMb: number;
  diskTotalMb: number;
  diskFreeMb: number;
  /** Docker-Fassung auf der Node, leer wenn nicht erreichbar */
  dockerVersion: string;
  /** Samba läuft */
  smb: boolean;
}
