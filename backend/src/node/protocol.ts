/**
 * Gemeinsame Absprachen zwischen Panel und Node-Agent. Beide laufen aus
 * demselben Abbild – trotzdem steht hier alles an einer Stelle, damit eine
 * Änderung nicht nur auf einer Seite landet.
 */
import crypto from 'node:crypto';
import { z } from 'zod';

/** Docker-API der Node, nur für das Panel erreichbar. */
export const AGENT_DOCKER_PORT = 2375;
/** Zustandsabfrage (Last, Speicher, Platte) des Agenten. */
export const AGENT_STATUS_PORT = 7480;
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

export type NodeConnection = 'wireguard' | 'direct';

/**
 * RCON eines Servers auf einer Node: der Container veröffentlicht Port 25575
 * nur auf der Adresse, unter der das Panel die Node erreicht (Tunnel bzw.
 * LAN), unter Spielport + Versatz. Die Spielports sind panelweit eindeutig,
 * damit auch diese – und ein Umzug kollidiert nie.
 */
export function rconHostPort(gamePort: number): number {
  return gamePort + 10_000 <= 65_535 ? gamePort + 10_000 : gamePort - 10_000;
}

export const nodeProfileSchema = z.object({
  v: z.literal(1),
  nodeId: z.string().min(1),
  name: z.string().min(1),
  mode: z.enum(['wireguard', 'direct']).default('wireguard'),
  /** Adresse, auf der der Agent lauscht: Tunneladresse bzw. LAN-IP */
  nodeIp: z.string().ip({ version: 'v4' }),
  token: z.string().min(32),
  smbPassword: z.string().min(16),
  dataRoot: z.string().startsWith('/'),
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
