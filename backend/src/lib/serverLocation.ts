/**
 * Wo liegt welcher Server? Synchron abfragbar, weil `serverDir()` an über
 * zwanzig Stellen ohne `await` aufgerufen wird.
 *
 * Quelle ist die Spalte `Server.nodeId`; beim Start lädt `loadServerLocations`
 * den Stand, Anlegen/Umziehen/Löschen pflegen ihn nach. Ein Server, der hier
 * fehlt, gilt als lokal – das ist der Stand vor Einführung der Nodes und
 * damit auch der Fall in allen Unit-Tests.
 *
 * Bewusst ohne Laufzeit-Importe: `config.ts` hängt hiervon ab.
 */
import type { AgentPorts } from '../node/protocol.js';

export interface NodeLocation {
  id: string;
  name: string;
  /** Adresse, unter der das Panel die Node erreicht (Tunnel- oder LAN-IP) */
  tunnelIp: string;
  /** Geheimnis für Docker-API und Zustandsabfrage des Agenten */
  agentToken: string;
  /** Öffentliche Adresse für Spieler */
  publicHost: string;
  /** Datenverzeichnis auf der Node (Host-Pfad für Bind-Mounts) */
  dataRoot: string;
  /** Ports des Agenten, wie das Panel sie erreicht */
  ports: AgentPorts;
  /**
   * Docker-Volume mit den Serverdaten (Windows). Gesetzt, hängen die
   * Minecraft-Container `servers/<id>` daraus ein statt eines Host-Ordners.
   */
  dataVolume: string | null;
}

const serverNodes = new Map<string, string>();
const nodes = new Map<string, NodeLocation>();

/** Node-ID eines Servers, `null` für den Hauptserver. */
export function nodeIdOf(serverId: string): string | null {
  return serverNodes.get(serverId) ?? null;
}

export function setServerNode(serverId: string, nodeId: string | null | undefined): void {
  if (nodeId) serverNodes.set(serverId, nodeId);
  else serverNodes.delete(serverId);
}

export function forgetServer(serverId: string): void {
  serverNodes.delete(serverId);
}

export function replaceServerLocations(rows: { id: string; nodeId: string | null }[]): void {
  serverNodes.clear();
  for (const row of rows) setServerNode(row.id, row.nodeId);
}

export function setNodeLocation(node: NodeLocation): void {
  nodes.set(node.id, { ...node });
}

export function removeNodeLocation(nodeId: string): void {
  nodes.delete(nodeId);
}

export function nodeLocation(nodeId: string): NodeLocation | null {
  return nodes.get(nodeId) ?? null;
}

/** Node eines Servers samt Verbindungsdaten, `null` für den Hauptserver. */
export function serverNodeLocation(serverId: string): NodeLocation | null {
  const id = nodeIdOf(serverId);
  if (!id) return null;
  const node = nodes.get(id);
  // Ein Server auf einer unbekannten Node darf nie still als lokal gelten:
  // sonst landen Dateien und Container auf dem falschen Rechner.
  if (!node) throw new Error(`Node ${id} ist dem Panel nicht bekannt`);
  return node;
}

export function serversOnNode(nodeId: string): string[] {
  return [...serverNodes.entries()].filter(([, node]) => node === nodeId).map(([server]) => server);
}
