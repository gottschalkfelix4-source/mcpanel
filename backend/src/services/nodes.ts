/**
 * Nodes: weitere Docker-Hosts, auf denen Minecraft-Server laufen.
 *
 * Aufbau einer Verbindung, von unten nach oben:
 *
 *   1. WireGuard – das Panel wählt sich zur Node ein (tunnel.ts)
 *   2. Agent     – Zustandsabfrage und Docker-API auf der Tunneladresse
 *   3. Freigabe  – das Datenverzeichnis der Node wird per CIFS unter
 *                  <data>/nodes/<id> eingehängt; `serverDir()` zeigt für
 *                  Server dieser Node dorthin
 *
 * Erst wenn alle drei stehen, gilt die Node als bereit. Vorher lehnen
 * Serveroperationen mit einem klaren Fehler ab, statt ins leere lokale
 * Einhängeverzeichnis zu schreiben (siehe `setOperationGuard`).
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Node } from '@prisma/client';
import { config, nodeMountDir } from '../config.js';
import { prisma } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { setTunnelNetwork } from '../lib/network.js';
import {
  nodeIdOf,
  nodeLocation,
  removeNodeLocation,
  replaceServerLocations,
  setNodeLocation,
} from '../lib/serverLocation.js';
import {
  AGENT_INTERNAL_PORTS,
  AGENT_TOKEN_HEADER,
  WINDOWS_DATA_ROOT,
  WINDOWS_DATA_VOLUME,
  WINDOWS_PUBLISHED_PORTS,
  agentPorts,
  NODE_MARKER,
  SMB_SHARE,
  SMB_USER,
  type AgentStatus,
  type NodeConnection,
  type NodePlatform,
  type NodeProfile,
} from '../node/protocol.js';
import * as dockerSvc from './docker.js';
import { assertNodeReady, forgetNodeClient, isNodeReady, nodeNotReadyReason, rawNodeDocker, setNodeReady } from './nodeClients.js';
import { setOperationGuard } from './operations.js';
import { getPublicHost } from './settings.js';
import {
  ensureTunnel,
  nextTunnelIp,
  panelKeyPair,
  panelTunnelIp,
  peerStatus,
  removePeer,
  syncPeers,
  tunnelPrefix,
  tunnelState,
  wgKeyPair,
  type PeerStatus,
} from './tunnel.js';

const run = promisify(execFile);
const CHECK_INTERVAL_MS = 10_000;
/** Ohne Handschlag seit dieser Zeit gilt der Tunnel als getrennt (WireGuard erneuert alle 2 min). */
const HANDSHAKE_STALE_MS = 3 * 60_000;

// ---------------------------------------------------------------------------
// Laufzeitzustand
// ---------------------------------------------------------------------------

interface NodeRuntime {
  status: AgentStatus | null;
  peer: PeerStatus | null;
  mounted: boolean;
  error: string | null;
  checkedAt: Date | null;
  /** Server mit Autostart wurden nach dem Panel-Start schon hochgefahren */
  autostarted: boolean;
  /** Bereits einmal verbunden gewesen (für die Meldung „wieder da“) */
  everReady: boolean;
}

const runtime = new Map<string, NodeRuntime>();

function runtimeOf(nodeId: string): NodeRuntime {
  let entry = runtime.get(nodeId);
  if (!entry) {
    entry = { status: null, peer: null, mounted: false, error: null, checkedAt: null, autostarted: false, everReady: false };
    runtime.set(nodeId, entry);
  }
  return entry;
}

function registerNode(node: Node): void {
  setNodeLocation({
    id: node.id,
    name: node.name,
    tunnelIp: node.tunnelIp,
    agentToken: node.agentToken,
    publicHost: node.publicHost,
    dataRoot: node.dataRoot,
    ports: portsOf(node),
    dataVolume: isWindowsNode(node) ? WINDOWS_DATA_VOLUME : null,
  });
}

const isTunnelNode = (node: Pick<Node, 'connection'>) => node.connection !== 'direct';
const isWindowsNode = (node: Pick<Node, 'platform'>) => node.platform === 'windows';
const platformOf = (node: Pick<Node, 'platform'>): NodePlatform => (isWindowsNode(node) ? 'windows' : 'linux');
const portsOf = (node: Pick<Node, 'platform' | 'connection'>) =>
  agentPorts(platformOf(node), isTunnelNode(node) ? 'wireguard' : 'direct');

/** Lädt Nodes und Serverstandorte in die Registry. Muss vor allen Serveroperationen laufen. */
export async function loadNodes(): Promise<void> {
  const [nodes, servers] = await Promise.all([
    prisma.node.findMany(),
    prisma.server.findMany({ select: { id: true, nodeId: true } }),
  ]);
  for (const node of nodes) registerNode(node);
  replaceServerLocations(servers);
}

// ---------------------------------------------------------------------------
// Einhängen der Freigabe
// ---------------------------------------------------------------------------

async function isMountedAt(at: string): Promise<boolean> {
  try {
    const table = await fs.readFile('/proc/mounts', 'utf8');
    return table.includes(` ${at.replace(/ /g, '\\040')} `);
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Liest die Markierungsdatei – beweist, dass die richtige Node eingehängt ist und antwortet. */
async function markerMatches(node: Node): Promise<boolean> {
  try {
    const raw = await withTimeout(fs.readFile(path.join(nodeMountDir(node.id), NODE_MARKER), 'utf8'), 8000, 'Zeitüberschreitung');
    return (JSON.parse(raw) as { nodeId?: string }).nodeId === node.id;
  } catch {
    return false;
  }
}

async function unmountNode(nodeId: string): Promise<void> {
  const at = nodeMountDir(nodeId);
  for (let round = 0; round < 3 && (await isMountedAt(at)); round++) {
    await run('umount', [at], { timeout: 15_000 }).catch(() => run('umount', ['-l', at], { timeout: 15_000 }).catch(() => {}));
  }
}

function describeMountError(raw: string): string {
  if (/mount error\(13\)|Permission denied/.test(raw)) return 'Freigabe lehnt die Zugangsdaten ab – Installationsbefehl erneut ausführen';
  if (/mount error\(1\)|Operation not permitted|must be superuser/i.test(raw)) {
    return 'Dem Panel-Container fehlt das Recht SYS_ADMIN zum Einhängen der Freigabe';
  }
  if (/ENOENT.*mount|mount: not found|unknown filesystem type 'cifs'/i.test(raw)) return 'Im Panel-Abbild fehlt cifs-utils';
  if (/mount error\(112\)|mount error\(115\)|Host is down|timed out/i.test(raw)) return 'Freigabe antwortet nicht';
  return `Freigabe konnte nicht eingehängt werden: ${raw.slice(0, 200)}`;
}

async function mountNode(node: Node): Promise<void> {
  const at = nodeMountDir(node.id);
  if ((await isMountedAt(at)) && (await markerMatches(node))) return;
  await unmountNode(node.id);
  await fs.mkdir(at, { recursive: true });

  const credentialsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-node-'));
  const credentials = path.join(credentialsDir, 'credentials');
  await fs.writeFile(credentials, `username=${SMB_USER}\npassword=${node.smbPassword}\n`, { mode: 0o600 });
  const options = [
    `credentials=${credentials}`,
    'vers=3.1.1',
    'uid=0', 'gid=0', 'file_mode=0644', 'dir_mode=0755',
    // Fällt der Tunnel weg, sollen Dateizugriffe mit Fehler zurückkommen,
    // statt das Panel endlos festzuhalten.
    'soft', 'echo_interval=10',
    // Kurze Attributpuffer: Minecraft schreibt auf der Node mit, und der
    // Dateimanager soll das zeitnah sehen.
    'actimeo=1',
    'nobrl',
    `port=${portsOf(node).smb}`,
    // Ohne Tunnel verlangt der Agent SMB3-Verschlüsselung.
    ...(isTunnelNode(node) ? [] : ['seal']),
  ].join(',');
  try {
    await run('mount', ['-t', 'cifs', `//${node.tunnelIp}/${SMB_SHARE}`, at, '-o', options], { timeout: 30_000 });
    if (!(await markerMatches(node))) {
      await unmountNode(node.id);
      throw new Error('Die eingehängte Freigabe gehört zu einer anderen Node');
    }
  } catch (err) {
    const raw = (err instanceof Error ? err.message : String(err)).replace(/password=[^,'\s]*/g, 'password=***');
    throw new Error(/anderen Node/.test(raw) ? raw : describeMountError(raw));
  } finally {
    await fs.rm(credentialsDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Überwachung
// ---------------------------------------------------------------------------

async function fetchAgentStatus(node: Node): Promise<AgentStatus> {
  const response = await fetch(`http://${node.tunnelIp}:${portsOf(node).status}/status`, {
    headers: { [AGENT_TOKEN_HEADER]: node.agentToken },
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 401) throw new Error('Agent lehnt das Token ab – Installationsbefehl erneut ausführen');
  if (!response.ok) throw new Error(`Agent antwortet mit ${response.status}`);
  const status = (await response.json()) as AgentStatus;
  if (status.nodeId !== node.id) throw new Error('Unter dieser Tunneladresse antwortet eine andere Node');
  return status;
}

let log: (msg: string) => void = (msg) => console.log(msg);
let checking: Promise<void> | null = null;

async function checkNode(node: Node, peers: Map<string, PeerStatus>, peerErrors: Map<string, string>): Promise<void> {
  const state = runtimeOf(node.id);
  const wasReady = isNodeReady(node.id);
  state.peer = peers.get(node.publicKey) ?? null;
  state.checkedAt = new Date();

  let reason = '';
  const tunnel = tunnelState();
  if (isTunnelNode(node)) {
    if (!tunnel.up) {
      reason = tunnel.error ?? 'Tunnel nicht eingerichtet';
    } else if (peerErrors.has(node.publicKey)) {
      reason = peerErrors.get(node.publicKey)!;
    }
  }

  if (!reason) {
    try {
      state.status = await fetchAgentStatus(node);
    } catch (err) {
      state.status = null;
      const handshake = state.peer?.handshakeAt?.getTime() ?? 0;
      const detail = err instanceof Error ? err.message : String(err);
      reason = !isTunnelNode(node)
        ? /Token/.test(detail)
          ? detail
          : `Agent unter ${node.tunnelIp} nicht erreichbar – läuft er, und lässt die Firewall der Node TCP ${Object.values(portsOf(node)).join(', ')} aus dem LAN durch?`
        : !handshake || Date.now() - handshake > HANDSHAKE_STALE_MS
        ? 'Kein Tunnel-Handschlag – läuft der Agent, und ist UDP-Port ' + node.listenPort + ' auf der Node offen?'
        : `Agent nicht erreichbar: ${err instanceof Error ? err.message : err}`;
    }
  }

  if (!reason && state.status && !state.status.smb) reason = 'Samba läuft auf der Node nicht';
  if (!reason && state.status && !state.status.dockerVersion) reason = 'Docker auf der Node antwortet nicht';

  if (!reason) {
    try {
      await mountNode(node);
      state.mounted = true;
    } catch (err) {
      state.mounted = false;
      reason = err instanceof Error ? err.message : String(err);
    }
  }

  if (!reason) {
    try {
      await withTimeout(rawNodeDocker(node.id).ping(), 8000, 'Zeitüberschreitung');
    } catch (err) {
      reason = `Docker-API nicht erreichbar: ${err instanceof Error ? err.message : err}`;
    }
  }

  const ready = !reason;
  state.error = reason || null;
  setNodeReady(node.id, ready, reason);

  if (ready && state.status) {
    const changed = node.agentVersion !== state.status.version;
    const stale = !node.lastSeenAt || Date.now() - node.lastSeenAt.getTime() > 60_000;
    if (changed || stale) {
      await prisma.node.update({
        where: { id: node.id },
        data: { agentVersion: state.status.version, lastSeenAt: new Date() },
      }).catch(() => {});
    }
  }

  if (ready && !wasReady) {
    log(`Node „${node.name}“ ${state.everReady ? 'wieder ' : ''}verbunden (${node.tunnelIp})`);
    state.everReady = true;
    if (!state.autostarted) {
      state.autostarted = true;
      void autostartNode(node);
    }
  } else if (!ready && wasReady) {
    log(`Node „${node.name}“ getrennt: ${reason}`);
  }
}

async function autostartNode(node: Node): Promise<void> {
  const servers = await prisma.server.findMany({ where: { nodeId: node.id, autoStart: true } });
  for (const server of servers) {
    try {
      const { state } = await dockerSvc.getState(server);
      if (state !== 'running' && state !== 'starting') await dockerSvc.start(server);
    } catch (err) {
      log(`Autostart für ${server.name} auf „${node.name}“ fehlgeschlagen: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Ein Prüfdurchlauf über alle Nodes. Läuft nie doppelt. */
export function checkNodes(): Promise<void> {
  if (checking) return checking;
  checking = (async () => {
    const nodes = await prisma.node.findMany();
    if (nodes.length === 0) return;
    // WireGuard nur, wenn es überhaupt eine Node hinter einem Tunnel gibt:
    // reine LAN-Setups brauchen weder NET_ADMIN noch die Werkzeuge.
    const tunnelNodes = nodes.filter(isTunnelNode);
    if (tunnelNodes.length > 0 && !tunnelState().up) await ensureTunnel();
    const peerErrors = await syncPeers(tunnelNodes.map((node) => ({
      publicKey: node.publicKey, host: node.publicHost, port: node.listenPort, tunnelIp: node.tunnelIp,
    })));
    const peers = await peerStatus().catch(() => new Map<string, PeerStatus>());
    await Promise.all(nodes.map((node) => {
      registerNode(node);
      return checkNode(node, peers, peerErrors).catch((err) => {
        setNodeReady(node.id, false, err instanceof Error ? err.message : String(err));
      });
    }));
  })().finally(() => { checking = null; });
  return checking;
}

export async function startNodeMonitor(logger: (msg: string) => void): Promise<void> {
  log = logger;
  setTunnelNetwork(config.nodes.tunnelSubnet);
  setOperationGuard((serverId) => {
    const nodeId = nodeIdOf(serverId);
    if (nodeId) assertNodeReady(nodeId);
  });
  const count = await prisma.node.count();
  if (count > 0) {
    const tunnel = (await prisma.node.count({ where: { connection: { not: 'direct' } } })) > 0 ? await ensureTunnel() : null;
    if (tunnel) {
    if (tunnel.up) logger(`Node-Tunnel bereit (${tunnel.panelIp}, ${tunnel.mode === 'userspace' ? 'wireguard-go' : 'Kernel'})`);
    else logger(`WARNUNG: Node-Tunnel nicht verfügbar – ${tunnel.error}`);
    }
    // Erster Durchlauf sofort, damit Autostarts nicht zehn Sekunden warten –
    // aber höchstens 20 s, eine hängende Node darf den Panel-Start nicht aufhalten.
    await Promise.race([
      checkNodes().catch((err) => logger(`Nodes: ${err instanceof Error ? err.message : err}`)),
      new Promise((resolve) => setTimeout(resolve, 20_000).unref()),
    ]);
  }
  setInterval(() => { void checkNodes().catch(() => {}); }, CHECK_INTERVAL_MS).unref();
}

// ---------------------------------------------------------------------------
// Verwaltung
// ---------------------------------------------------------------------------

const HOST_PATTERN = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$|^\d{1,3}(?:\.\d{1,3}){3}$|^[0-9a-fA-F:]+$/;
const DATA_ROOT_PATTERN = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export interface NodeInput {
  name: string;
  publicHost: string;
  /** `direct`: im selben Netz ohne VPN, `publicHost` ist dann die LAN-IP */
  connection?: NodeConnection;
  /** `windows`: Docker Desktop, Installation per PowerShell */
  platform?: NodePlatform;
  listenPort?: number;
  dataRoot?: string;
}

const PRIVATE_V4 = /^(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}$/;

/**
 * Ohne VPN braucht das Panel eine feste private IPv4-Adresse: an sie bindet
 * der Agent seine Dienste und die Container ihren RCON-Port. Ein DNS-Name
 * oder eine öffentliche Adresse würde die Dienste ungeschützt ins Netz hängen.
 */
export function validateDirectAddress(host: string): void {
  if (!PRIVATE_V4.test(host) || host.split('.').some((octet) => Number(octet) > 255)) {
    throw badRequest('Ohne VPN: bitte die private IPv4-Adresse der Node im LAN angeben (z. B. 192.168.1.50)');
  }
  if (host.startsWith(config.nodes.tunnelSubnet.split('.').slice(0, 3).join('.') + '.')) {
    throw badRequest(`Die Adresse liegt im Tunnelnetz ${config.nodes.tunnelSubnet} des Panels`);
  }
}

function validateInput(input: Partial<NodeInput>): void {
  if (input.name !== undefined && !/^[\p{L}\p{N} ._-]{1,40}$/u.test(input.name.trim())) {
    throw badRequest('Name: 1–40 Zeichen, Buchstaben, Ziffern, Leerzeichen, Punkt, Binde- und Unterstrich');
  }
  if (input.publicHost !== undefined && !HOST_PATTERN.test(input.publicHost.trim())) {
    throw badRequest('Adresse: IP-Adresse oder DNS-Name der Node ohne Protokoll und Port');
  }
  if (input.dataRoot !== undefined) {
    const root = input.dataRoot.trim();
    if (!DATA_ROOT_PATTERN.test(root) || root.split('/').includes('..') || ['/', '/etc', '/var', '/usr', '/root', '/home', '/opt'].includes(root)) {
      throw badRequest('Datenverzeichnis: absoluter Pfad wie /opt/mcpanel-node, keine Systemordner');
    }
  }
}

export async function createNode(input: NodeInput): Promise<Node> {
  validateInput(input);
  const direct = input.connection === 'direct';
  const publicHost = input.publicHost.trim().replace(/^\[|\]$/g, '');
  if (direct) validateDirectAddress(publicHost);
  const keys = wgKeyPair();
  if (!direct) await panelKeyPair();
  const used = await prisma.node.findMany({ select: { tunnelIp: true } });
  if (direct && used.some((row) => row.tunnelIp === publicHost)) throw conflict('Unter dieser Adresse ist bereits eine Node eingetragen');
  const node = await prisma.node.create({
    data: {
      name: input.name.trim(),
      publicHost,
      connection: direct ? 'direct' : 'wireguard',
      platform: input.platform === 'windows' ? 'windows' : 'linux',
      listenPort: input.listenPort ?? 51820,
      // Unter Windows liegen die Daten im Volume, das der Agent hier einhängt.
      dataRoot: input.platform === 'windows' ? WINDOWS_DATA_ROOT : input.dataRoot?.trim() || '/opt/mcpanel-node',
      tunnelIp: direct ? publicHost : nextTunnelIp([panelTunnelIp(), ...used.map((row) => row.tunnelIp)]),
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      smbPassword: crypto.randomBytes(24).toString('base64url'),
      agentToken: crypto.randomBytes(32).toString('base64url'),
    },
  });
  registerNode(node);
  setNodeReady(node.id, false, 'Warte auf die Installation auf der Node');
  // Tunnel jetzt schon aufbauen: sobald der Agent läuft, steht die Verbindung.
  void checkNodes().catch(() => {});
  return node;
}

export async function updateNode(id: string, input: Partial<NodeInput>): Promise<Node> {
  validateInput(input);
  const existing = await prisma.node.findUnique({ where: { id } });
  if (!existing) throw notFound('Node nicht gefunden');
  const publicHost = input.publicHost?.trim().replace(/^\[|\]$/g, '');
  if (publicHost !== undefined && !isTunnelNode(existing) && publicHost !== existing.publicHost) {
    // Ohne VPN hängen Agent und RCON-Ports an dieser Adresse – eine neue
    // braucht eine Neuinstallation, und laufende Container zeigen noch auf die alte.
    validateDirectAddress(publicHost);
    if (await prisma.server.count({ where: { nodeId: id } })) {
      throw conflict('Die LAN-Adresse lässt sich nur ändern, solange keine Server auf der Node liegen');
    }
  }
  const node = await prisma.node.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(publicHost !== undefined ? { publicHost, ...(isTunnelNode(existing) ? {} : { tunnelIp: publicHost }) } : {}),
      ...(input.listenPort !== undefined ? { listenPort: input.listenPort } : {}),
    },
  });
  registerNode(node);
  void checkNodes().catch(() => {});
  return node;
}

export async function deleteNode(id: string): Promise<void> {
  const node = await prisma.node.findUnique({ where: { id }, include: { _count: { select: { servers: true } } } });
  if (!node) throw notFound('Node nicht gefunden');
  if (node._count.servers > 0) {
    throw conflict(`Auf „${node.name}“ liegen noch ${node._count.servers} Server. Bitte zuerst umziehen oder löschen.`);
  }
  await unmountNode(id);
  if (isTunnelNode(node)) await removePeer(node.publicKey);
  await prisma.node.delete({ where: { id } });
  removeNodeLocation(id);
  forgetNodeClient(id);
  runtime.delete(id);
  await fs.rm(nodeMountDir(id), { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/** Abbild für den Agenten: dieselbe Fassung wie das Panel, damit beide zusammenpassen. */
export function nodeImage(): string {
  if (config.nodes.image) return config.nodes.image;
  const version = config.build.version.replace(/^v/, '');
  return `${config.nodes.imageRepo}:${/^\d+\.\d+\.\d+/.test(version) ? version : 'latest'}`;
}

export async function nodeProfile(node: Node): Promise<NodeProfile> {
  const base = {
    v: 1 as const,
    nodeId: node.id,
    name: node.name,
    platform: platformOf(node),
    nodeIp: node.tunnelIp,
    token: node.agentToken,
    smbPassword: node.smbPassword,
    dataRoot: node.dataRoot,
    dockerNetwork: config.dockerNetwork,
  };
  if (!isTunnelNode(node)) return { ...base, mode: 'direct' };
  const panel = await panelKeyPair();
  return {
    ...base,
    mode: 'wireguard',
    privateKey: node.privateKey,
    listenPort: node.listenPort,
    prefix: tunnelPrefix(),
    panelIp: panelTunnelIp(),
    panelPublicKey: panel.publicKey,
  };
}

/**
 * Installationsskript für die Node. Enthält das komplette Profil, damit die
 * Node das Panel nie erreichen muss – der Hauptserver darf hinter NAT stehen.
 *
 * Der ganze Ablauf steckt in einer Funktion: über `| sh` gelesen, würde sonst
 * jeder Befehl, der von stdin liest, den Rest des Skripts verschlucken.
 */
export async function installScript(node: Node): Promise<string> {
  if (isWindowsNode(node)) return installScriptWindows(node);
  const profile = JSON.stringify(await nodeProfile(node));
  const image = nodeImage();
  if (!/^[a-z0-9./:_@-]+$/i.test(image)) throw new Error('NODE_IMAGE enthält unzulässige Zeichen');
  const portRange = `${config.portRange.min}:${config.portRange.max}`;
  const safeName = node.name.replace(/[^\p{L}\p{N} ._-]/gu, '');
  const tunnel = isTunnelNode(node);
  // Im LAN-Betrieb entfällt alles rund um WireGuard; stattdessen müssen die
  // Dienste des Agenten aus dem Heimnetz erreichbar sein.
  const prepare = tunnel
    ? [
      '  # WireGuard aus dem Kernel bevorzugen; sonst nimmt der Agent wireguard-go.',
      '  modprobe wireguard >/dev/null 2>&1 || true',
      "  EXTRA='--cap-add=NET_ADMIN'",
      '  [ -c /dev/net/tun ] && EXTRA="$EXTRA --device=/dev/net/tun"',
    ].join('\n')
    : [
      '  # Betrieb im selben Netz ohne VPN: kein WireGuard nötig.',
      "  EXTRA=''",
      '  ip -4 addr 2>/dev/null | grep -q " $NODE_IP/" || warn "Die Adresse $NODE_IP ist auf diesem Rechner nicht zu finden – stimmt die LAN-IP im Panel?"',
    ].join('\n');
  const agentPortList = Object.values(AGENT_INTERNAL_PORTS).join(' ');
  const firewall = tunnel
    ? [
      '  # Firewall: WireGuard braucht UDP; die Spielports veröffentlicht Docker selbst.',
      "  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then",
      '    ufw allow "$WG_PORT/udp" >/dev/null && say "ufw: UDP $WG_PORT freigegeben"',
      '  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then',
      '    firewall-cmd -q --permanent --add-port="$WG_PORT/udp" && firewall-cmd -q --reload && say "firewalld: UDP $WG_PORT freigegeben"',
      '  fi',
    ].join('\n')
    : [
      '  # Firewall: Agent (Docker-API, Zustand) und Samba nur aus privaten Netzen.',
      "  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then",
      '    for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do',
      `      for port in ${agentPortList}; do ufw allow from "$net" to any port "$port" proto tcp >/dev/null; done`,
      '    done',
      '    say "ufw: Agent-Ports aus dem LAN freigegeben"',
      '  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then',
      `    for port in ${agentPortList}; do firewall-cmd -q --permanent --add-port="$port/tcp"; done`,
      '    firewall-cmd -q --reload && say "firewalld: Agent-Ports freigegeben"',
      '  fi',
    ].join('\n');
  const hint = tunnel
    ? 'Hat der Anbieter eine eigene Firewall: UDP $WG_PORT sowie TCP/UDP $MC_PORTS (Minecraft) öffnen.'
    : 'Spieler im LAN verbinden sich mit $NODE_IP; für Zugriff von außen die Ports $MC_PORTS im Router auf diese Node weiterleiten.';
  return `#!/bin/sh
# MCPanel – Installation der Node "${safeName}"
# Richtet Docker (falls nötig) und den Node-Agenten ein. Erneut ausführen ist
# unschädlich: der Agent wird mit demselben Profil neu gestartet.
set -eu

IMAGE='${image}'
DATA='${node.dataRoot}'
NAME='mcpanel-node'
WG_PORT='${node.listenPort}'
MC_PORTS='${portRange}'
NODE_IP='${node.tunnelIp}'

say() { printf '\\033[1;32m[mcpanel-node]\\033[0m %s\\n' "$*"; }
warn() { printf '\\033[1;33m[mcpanel-node]\\033[0m %s\\n' "$*"; }
fail() { printf '\\033[1;31m[mcpanel-node]\\033[0m %s\\n' "$*" >&2; exit 1; }

main() {
  [ "$(id -u)" = 0 ] || fail "Bitte als root ausführen (oder mit sudo)."
  [ "$(uname -s)" = Linux ] || fail "Nodes laufen nur unter Linux."

  if ! command -v docker >/dev/null 2>&1; then
    say "Docker fehlt – Installation über get.docker.com ..."
    if ! command -v curl >/dev/null 2>&1; then
      (apt-get update -qq && apt-get install -y -qq curl) || dnf install -y curl || yum install -y curl || apk add --no-cache curl || fail "curl konnte nicht installiert werden."
    fi
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true
  fi
  docker info >/dev/null 2>&1 || fail "Docker läuft nicht."

${prepare}

  mkdir -p "$DATA/servers"
  chmod 711 "$DATA"
  umask 077
  cat > "$DATA/node.json" <<'MCPANEL_PROFIL'
${profile}
MCPANEL_PROFIL
  chmod 600 "$DATA/node.json"
  umask 022

  say "Lade $IMAGE ..."
  docker pull -q "$IMAGE" >/dev/null || docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "Abbild $IMAGE nicht ladbar."
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --restart unless-stopped \\
    --network host $EXTRA \\
    --health-cmd 'test -f /run/mcpanel-node/ready' --health-interval 30s \\
    -e MCPANEL_ROLE=node -e NODE_CONFIG="$DATA/node.json" \\
    -v /var/run/docker.sock:/var/run/docker.sock \\
    -v "$DATA:$DATA" \\
    "$IMAGE" >/dev/null

${firewall}

  say "Warte auf den Agenten ..."
  i=0
  while [ $i -lt 60 ]; do
    if docker logs "$NAME" 2>&1 | grep -q 'Bereit'; then
      say "Fertig! Das Panel verbindet sich jetzt mit dieser Node."
      say "${hint}"
      return 0
    fi
    if docker logs "$NAME" 2>&1 | grep -q 'ABBRUCH'; then
      docker logs "$NAME" 2>&1 | tail -n 20
      fail "Der Agent konnte nicht starten."
    fi
    i=$((i + 1))
    sleep 2
  done
  docker logs "$NAME" 2>&1 | tail -n 20
  fail "Der Agent meldet sich nicht. Protokoll: docker logs $NAME"
}

main "$@" </dev/null
`;
}

/** PowerShell-Zeichenkette in einfachen Anführungszeichen. */
const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Installationsskript für Windows mit Docker Desktop (PowerShell 5.1 und 7).
 *
 * Unterschiede zu Linux: kein Host-Netz – der Agent hängt im Minecraft-Netz
 * und Docker Desktop veröffentlicht seine Ports am Windows-Rechner; Port 445
 * gehört Windows selbst; die Daten liegen in einem Docker-Volume statt auf
 * NTFS. Bewusst mit `ErrorActionPreference = Continue`: in Windows PowerShell
 * 5.1 würde sonst jede stderr-Zeile von docker zum Abbruch.
 */
async function installScriptWindows(node: Node): Promise<string> {
  const profile = JSON.stringify(await nodeProfile(node));
  const image = nodeImage();
  if (!/^[a-z0-9./:_@-]+$/i.test(image)) throw new Error('NODE_IMAGE enthält unzulässige Zeichen');
  const tunnel = isTunnelNode(node);
  const p = WINDOWS_PUBLISHED_PORTS;
  const i = AGENT_INTERNAL_PORTS;
  const portArgs = tunnel
    ? `'--cap-add', 'NET_ADMIN', '--device', '/dev/net/tun', '-p', "$($WgPort):$($WgPort)/udp"`
    : `'-p', '${p.docker}:${i.docker}', '-p', '${p.status}:${i.status}', '-p', '${p.rcon}:${i.rcon}', '-p', '${p.smb}:${i.smb}'`;
  const firewall = tunnel
    ? `    New-NetFirewallRule -DisplayName 'MCPanel Node WireGuard' -Direction Inbound -Protocol UDP -LocalPort $WgPort -Action Allow | Out-Null`
    : `    New-NetFirewallRule -DisplayName 'MCPanel Node Agent' -Direction Inbound -Protocol TCP -LocalPort ${p.docker},${p.status},${p.rcon},${p.smb} -RemoteAddress LocalSubnet -Action Allow | Out-Null`;
  const hint = tunnel
    ? 'Im Router UDP $WgPort sowie TCP/UDP $McPorts (Minecraft) auf diesen Rechner weiterleiten.'
    : 'Spieler im LAN verbinden sich mit ' + node.tunnelIp + '; für Zugriff von außen die Ports $McPorts im Router auf diesen Rechner weiterleiten.';
  const safeName = node.name.replace(/[^\p{L}\p{N} ._-]/gu, '');
  return `# MCPanel – Installation der Node "${safeName}" (Windows, Docker Desktop)
# Erneut ausführen ist unschädlich: der Agent wird mit demselben Profil neu gestartet.
& {
  $ErrorActionPreference = 'Continue'
  $Image = ${psQuote(image)}
  $Name = 'mcpanel-node'
  $Volume = '${WINDOWS_DATA_VOLUME}'
  $Network = ${psQuote(config.dockerNetwork)}
  $WgPort = ${node.listenPort}
  $McPorts = '${config.portRange.min}-${config.portRange.max}'
  function Say([string]$Text) { Write-Host "[mcpanel-node] $Text" -ForegroundColor Green }
  function Warn([string]$Text) { Write-Host "[mcpanel-node] $Text" -ForegroundColor Yellow }
  function Fail([string]$Text) { Write-Host "[mcpanel-node] $Text" -ForegroundColor Red; throw $Text }

  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail 'Docker Desktop fehlt. Installieren (z. B. "winget install -e --id Docker.DockerDesktop"), starten und den Befehl erneut ausführen.'
  }
  $osType = docker info --format '{{.OSType}}' 2>$null
  if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop läuft nicht. Bitte starten und den Befehl erneut ausführen.' }
  if ("$osType".Trim() -ne 'linux') { Fail 'Docker Desktop nutzt Windows-Container. Bitte auf Linux-Container umschalten.' }
  $api = "$(docker version --format '{{.Server.APIVersion}}' 2>$null)".Trim()
  if (-not $api -or [version]$api -lt [version]'1.45') { Fail 'Docker Desktop ist zu alt (Docker Engine 26 oder neuer nötig). Bitte aktualisieren.' }

  Say "Lade $Image ..."
  docker pull -q $Image | Out-Null
  if ($LASTEXITCODE -ne 0) {
    docker image inspect $Image 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "Abbild $Image nicht ladbar." }
  }

  docker volume create $Volume | Out-Null
  docker network inspect $Network 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { docker network create $Network | Out-Null }

  # Das Profil reist Base64-kodiert: Windows PowerShell 5.1 setzt beim Weiterleiten
  # an Programme sonst eine BOM davor oder verstümmelt Umlaute.
  $profileData = '${Buffer.from(profile, 'utf8').toString('base64')}'
  docker run --rm -v "$($Volume):/opt/mcpanel-node" --entrypoint sh $Image -c "umask 077 && mkdir -p /opt/mcpanel-node/servers && echo $profileData | base64 -d > /opt/mcpanel-node/node.json"
  if ($LASTEXITCODE -ne 0) { Fail 'Das Profil ließ sich nicht im Volume ablegen.' }

  docker rm -f $Name 2>$null | Out-Null
  $runArgs = @('run', '-d', '--name', $Name, '--restart', 'unless-stopped', '--network', $Network,
    '--health-cmd', 'test -f /run/mcpanel-node/ready', '--health-interval', '30s',
    '-e', 'MCPANEL_ROLE=node', '-e', 'NODE_CONFIG=/opt/mcpanel-node/node.json',
    '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', "$($Volume):/opt/mcpanel-node",
    ${portArgs}, $Image)
  docker @runArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'Der Agent-Container ließ sich nicht starten.' }

  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Get-NetFirewallRule -DisplayName 'MCPanel Node*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
${firewall}
    New-NetFirewallRule -DisplayName 'MCPanel Node Minecraft TCP' -Direction Inbound -Protocol TCP -LocalPort $McPorts -Action Allow | Out-Null
    New-NetFirewallRule -DisplayName 'MCPanel Node Minecraft UDP' -Direction Inbound -Protocol UDP -LocalPort $McPorts -Action Allow | Out-Null
    Say 'Windows-Firewall: Regeln „MCPanel Node …“ angelegt'
  } else {
    Warn 'Ohne Administratorrechte keine Firewall-Regeln. Für Zugriff aus dem Netz PowerShell als Administrator öffnen und den Befehl erneut ausführen.'
  }

  Say 'Warte auf den Agenten ...'
  for ($try = 0; $try -lt 60; $try++) {
    $logs = (docker logs $Name 2>&1 | Out-String)
    if ($logs -match 'Bereit') {
      Say 'Fertig! Das Panel verbindet sich jetzt mit dieser Node.'
      Say "${hint}"
      Say 'Docker Desktop muss laufen, damit die Node erreichbar ist – am besten mit Windows starten lassen.'
      return
    }
    if ($logs -match 'ABBRUCH') {
      Write-Host $logs
      Fail 'Der Agent konnte nicht starten.'
    }
    Start-Sleep -Seconds 2
  }
  docker logs --tail 20 $Name
  Fail "Der Agent meldet sich nicht. Protokoll: docker logs $Name"
}
`;
}

/** Ein Befehl zum Einfügen auf der Node – das Skript steckt darin, Base64-kodiert. */
export async function installCommand(node: Node): Promise<string> {
  const script = Buffer.from(await installScript(node), 'utf8').toString('base64');
  return isWindowsNode(node)
    ? `iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${script}')))`
    : `echo '${script}' | base64 -d | $(command -v sudo) sh`;
}

export function uninstallCommand(node: Pick<Node, 'dataRoot' | 'connection' | 'platform'>): string {
  if (isWindowsNode(node)) {
    return `docker rm -f mcpanel-node; Get-NetFirewallRule -DisplayName 'MCPanel Node*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`;
  }
  return isTunnelNode(node)
    ? `docker rm -f mcpanel-node; ip link del wg-mcpanel 2>/dev/null; rm -f ${node.dataRoot}/node.json`
    : `docker rm -f mcpanel-node; rm -f ${node.dataRoot}/node.json`;
}

// ---------------------------------------------------------------------------
// Übersicht und Lastverteilung
// ---------------------------------------------------------------------------

export interface NodeMetrics {
  cpus: number;
  load: [number, number, number];
  memTotalMb: number;
  memAvailableMb: number;
  diskTotalMb: number;
  diskFreeMb: number;
  dockerVersion: string;
  hostname: string;
}

export interface NodeOverview {
  /** `null` = Hauptserver */
  id: string | null;
  name: string;
  local: boolean;
  /** `null` beim Hauptserver */
  connection: NodeConnection | null;
  platform: NodePlatform | null;
  publicHost: string;
  listenPort: number | null;
  tunnelIp: string | null;
  dataRoot: string;
  agentVersion: string;
  lastSeenAt: Date | null;
  createdAt: Date | null;
  status: 'online' | 'offline' | 'pending';
  error: string | null;
  handshakeAt: Date | null;
  metrics: NodeMetrics | null;
  servers: number;
  /** Summe der Container-Speichergrenzen aller Server dieser Node */
  allocatedMemoryMb: number;
}

async function localMetrics(): Promise<NodeMetrics> {
  const [disk, version] = await Promise.all([
    fs.statfs(config.dataRoot).catch(() => null),
    dockerSvc.docker.version().then((v) => v.Version).catch(() => ''),
  ]);
  let memTotal = os.totalmem() / 1048576;
  let memAvailable = os.freemem() / 1048576;
  try {
    const raw = await fs.readFile('/proc/meminfo', 'utf8');
    const value = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(raw)?.[1] ?? 0) / 1024;
    memTotal = value('MemTotal') || memTotal;
    memAvailable = value('MemAvailable') || memAvailable;
  } catch { /* kein Linux */ }
  const load = os.loadavg();
  return {
    cpus: os.cpus().length,
    load: [load[0], load[1], load[2]].map((v) => Math.round(v * 100) / 100) as [number, number, number],
    memTotalMb: Math.round(memTotal),
    memAvailableMb: Math.round(memAvailable),
    diskTotalMb: disk ? Math.round((disk.blocks * disk.bsize) / 1048576) : 0,
    diskFreeMb: disk ? Math.round((disk.bavail * disk.bsize) / 1048576) : 0,
    dockerVersion: version,
    hostname: os.hostname(),
  };
}

export async function nodeOverview(): Promise<NodeOverview[]> {
  const [nodes, servers, host] = await Promise.all([
    prisma.node.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.server.findMany(),
    getPublicHost(),
  ]);
  const allocation = new Map<string | null, { count: number; memory: number }>();
  for (const server of servers) {
    const key = server.nodeId ?? null;
    const entry = allocation.get(key) ?? { count: 0, memory: 0 };
    entry.count++;
    entry.memory += Math.round(dockerSvc.serverMemoryLimitBytes(server) / 1048576);
    allocation.set(key, entry);
  }

  const local: NodeOverview = {
    id: null,
    name: 'Hauptserver',
    local: true,
    connection: null,
    platform: null,
    publicHost: host,
    listenPort: null,
    tunnelIp: null,
    dataRoot: config.hostDataRoot,
    agentVersion: config.build.version,
    lastSeenAt: new Date(),
    createdAt: null,
    status: 'online',
    error: null,
    handshakeAt: null,
    metrics: await localMetrics(),
    servers: allocation.get(null)?.count ?? 0,
    allocatedMemoryMb: allocation.get(null)?.memory ?? 0,
  };

  return [local, ...nodes.map((node): NodeOverview => {
    const state = runtime.get(node.id);
    const ready = isNodeReady(node.id);
    const status = state?.status;
    return {
      id: node.id,
      name: node.name,
      local: false,
      connection: isTunnelNode(node) ? 'wireguard' : 'direct',
      platform: platformOf(node),
      publicHost: node.publicHost,
      listenPort: isTunnelNode(node) ? node.listenPort : null,
      tunnelIp: node.tunnelIp,
      dataRoot: node.dataRoot,
      agentVersion: status?.version ?? node.agentVersion,
      lastSeenAt: node.lastSeenAt,
      createdAt: node.createdAt,
      status: ready ? 'online' : node.lastSeenAt ? 'offline' : 'pending',
      error: ready ? null : state?.error ?? nodeNotReadyReason(node.id),
      handshakeAt: state?.peer?.handshakeAt ?? null,
      metrics: status ? {
        cpus: status.cpus,
        load: status.load,
        memTotalMb: status.memTotalMb,
        memAvailableMb: status.memAvailableMb,
        diskTotalMb: status.diskTotalMb,
        diskFreeMb: status.diskFreeMb,
        dockerVersion: status.dockerVersion,
        hostname: status.hostname,
      } : null,
      servers: allocation.get(node.id)?.count ?? 0,
      allocatedMemoryMb: allocation.get(node.id)?.memory ?? 0,
    };
  })];
}

/**
 * Lastverteilung beim Anlegen: die verbundene Node (oder der Hauptserver)
 * mit dem meisten noch nicht zugewiesenen Arbeitsspeicher. Gemessen wird
 * gegen die Summe der Container-Grenzen, nicht gegen den gerade freien
 * Speicher – gestoppte Server sollen ihren Platz behalten.
 */
export async function pickNodeForServer(memoryMb: number): Promise<string | null> {
  const overview = await nodeOverview();
  const required = Math.round(dockerSvc.containerMemoryBytes(memoryMb) / 1048576);
  const candidates = overview
    .filter((node) => node.status === 'online' && node.metrics)
    .map((node) => ({ id: node.id, free: node.metrics!.memTotalMb - node.allocatedMemoryMb }))
    .sort((a, b) => b.free - a.free);
  // Passt der Server nirgends ganz hinein, trotzdem den luftigsten Platz nehmen –
  // Grenzen sind keine Reservierung, und gestoppte Server belegen nichts.
  const best = candidates.find((node) => node.free >= required) ?? candidates[0];
  return best ? best.id : null;
}

export async function getNode(id: string): Promise<Node> {
  const node = await prisma.node.findUnique({ where: { id } });
  if (!node) throw notFound('Node nicht gefunden');
  return node;
}

export { nodeLocation };
