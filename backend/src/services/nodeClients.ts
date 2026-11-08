/**
 * Docker-Verbindungen zu den Nodes und deren Bereitschaft.
 *
 * Eigenes kleines Modul, damit `docker.ts` es nutzen kann, ohne den ganzen
 * Node-Dienst (Datenbank, Tunnel, Einhängen) mitzuziehen.
 */
import Docker from 'dockerode';
import { HttpError } from '../lib/errors.js';
import { nodeLocation } from '../lib/serverLocation.js';
import { AGENT_TOKEN_HEADER } from '../node/protocol.js';

const clients = new Map<string, { key: string; docker: Docker }>();
const readiness = new Map<string, { ready: boolean; reason: string }>();

/** Fehler „Node getrennt“ – 503, damit die Oberfläche es von echten Fehlern unterscheidet. */
export function nodeUnavailable(name: string, reason?: string): HttpError {
  return new HttpError(503, `Node „${name}“ ist nicht verbunden${reason ? ` (${reason})` : ''}. Bitte später erneut versuchen.`);
}

export function setNodeReady(nodeId: string, ready: boolean, reason = ''): void {
  readiness.set(nodeId, { ready, reason });
}

export function isNodeReady(nodeId: string): boolean {
  return readiness.get(nodeId)?.ready === true;
}

export function nodeNotReadyReason(nodeId: string): string {
  return readiness.get(nodeId)?.reason ?? 'noch nicht geprüft';
}

export function forgetNodeClient(nodeId: string): void {
  clients.delete(nodeId);
  readiness.delete(nodeId);
}

/** Docker-Client einer Node, ohne Bereitschaftsprüfung (für den Verbindungstest selbst). */
export function rawNodeDocker(nodeId: string): Docker {
  const node = nodeLocation(nodeId);
  if (!node) throw new Error(`Node ${nodeId} ist dem Panel nicht bekannt`);
  const key = `${node.tunnelIp}|${node.ports.docker}|${node.agentToken}`;
  const cached = clients.get(nodeId);
  if (cached && cached.key === key) return cached.docker;
  // Das Token reist in jeder Anfrage mit; der Agent prüft es pro Verbindung.
  const docker = new Docker({
    host: node.tunnelIp,
    port: node.ports.docker,
    protocol: 'http',
    headers: { [AGENT_TOKEN_HEADER]: node.agentToken },
  } as Docker.DockerOptions);
  clients.set(nodeId, { key, docker });
  return docker;
}

/** Wirft, solange die Node nicht vollständig verbunden ist (Tunnel, Agent, Freigabe). */
export function assertNodeReady(nodeId: string): void {
  const node = nodeLocation(nodeId);
  if (!node) throw new HttpError(404, 'Node nicht gefunden');
  if (!isNodeReady(nodeId)) throw nodeUnavailable(node.name, nodeNotReadyReason(nodeId));
}

/** Docker-Client einer verbundenen Node – getrennt gibt es sofort einen Fehler statt eines Timeouts. */
export function nodeDocker(nodeId: string): Docker {
  assertNodeReady(nodeId);
  return rawNodeDocker(nodeId);
}
