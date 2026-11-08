/**
 * WireGuard auf der Panel-Seite.
 *
 * Das Panel ist der aktive Teil: es kennt Adresse und Port jeder Node und
 * wählt sich dort ein (PersistentKeepalive hält die Verbindung durch NAT
 * offen). So braucht der Hauptserver – oft ein Heimserver hinter einem
 * Router – keinen einzigen offenen Port; nur die Node lauscht auf UDP.
 *
 * Die Schnittstelle lebt im Netz-Namensraum des Backend-Containers und
 * braucht dort CAP_NET_ADMIN. Bevorzugt wird WireGuard aus dem Kernel, sonst
 * wireguard-go (dann zusätzlich /dev/net/tun).
 */
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';

const run = promisify(execFile);

// ---------------------------------------------------------------------------
// Schlüssel
// ---------------------------------------------------------------------------

/** PKCS#8-Kopf eines rohen X25519-Schlüssels (RFC 8410). */
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');

export interface WgKeyPair { privateKey: string; publicKey: string }

/** Öffentlicher Schlüssel zu einem privaten – beides Base64 wie bei `wg`. */
export function wgPublicKey(privateKey: string): string {
  const raw = Buffer.from(privateKey, 'base64');
  if (raw.length !== 32) throw new Error('Ungültiger WireGuard-Schlüssel');
  const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32).toString('base64');
}

export function wgKeyPair(): WgKeyPair {
  const raw = crypto.randomBytes(32);
  // Klemmen wie `wg genkey`; X25519 klemmt ohnehin, so ist der Schlüssel aber
  // auch byte-genau derselbe, den `wg pubkey` erwartet.
  raw[0] &= 248;
  raw[31] = (raw[31] & 127) | 64;
  const privateKey = raw.toString('base64');
  return { privateKey, publicKey: wgPublicKey(privateKey) };
}

const keyFile = () => path.join(config.dataRoot, '.wireguard-key');

let panelKey: WgKeyPair | null = null;

/** Schlüssel des Panels; beim ersten Aufruf erzeugt und im Datenverzeichnis abgelegt. */
export async function panelKeyPair(): Promise<WgKeyPair> {
  if (panelKey) return panelKey;
  let privateKey = '';
  try {
    privateKey = (await fs.readFile(keyFile(), 'utf8')).trim();
    wgPublicKey(privateKey);
  } catch {
    privateKey = wgKeyPair().privateKey;
    await fs.mkdir(config.dataRoot, { recursive: true });
    await fs.writeFile(keyFile(), privateKey + '\n', { mode: 0o600 });
  }
  panelKey = { privateKey, publicKey: wgPublicKey(privateKey) };
  return panelKey;
}

// ---------------------------------------------------------------------------
// Adressen
// ---------------------------------------------------------------------------

function parseSubnet(cidr: string): { base: number; prefix: number } {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!match) throw new Error(`NODE_TUNNEL_SUBNET ist kein gültiges IPv4-Netz: ${cidr}`);
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((o) => o > 255) || prefix !== 24) {
    throw new Error('NODE_TUNNEL_SUBNET muss ein /24-Netz sein, z. B. 10.66.0.0/24');
  }
  const base = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8)) >>> 0;
  return { base, prefix };
}

const toIp = (value: number) => [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');

export function tunnelPrefix(): number {
  return parseSubnet(config.nodes.tunnelSubnet).prefix;
}

/** Adresse des Panels im Tunnel – immer die .1 */
export function panelTunnelIp(): string {
  return toIp(parseSubnet(config.nodes.tunnelSubnet).base + 1);
}

/** Erste freie Node-Adresse (.2 bis .254). */
export function nextTunnelIp(used: Iterable<string>): string {
  const taken = new Set(used);
  const { base } = parseSubnet(config.nodes.tunnelSubnet);
  for (let host = 2; host <= 254; host++) {
    const ip = toIp(base + host);
    if (!taken.has(ip)) return ip;
  }
  throw new Error('Im Tunnelnetz ist keine Adresse mehr frei');
}

// ---------------------------------------------------------------------------
// Schnittstelle
// ---------------------------------------------------------------------------

export interface TunnelState {
  /** Schnittstelle steht und ist konfiguriert */
  up: boolean;
  /** Warum nicht – für die Oberfläche */
  error: string | null;
  mode: 'kernel' | 'userspace' | null;
  panelIp: string;
  publicKey: string;
}

let state: TunnelState = { up: false, error: null, mode: null, panelIp: '', publicKey: '' };

export function tunnelState(): TunnelState {
  return { ...state };
}

async function linkExists(name: string): Promise<boolean> {
  try {
    await run('ip', ['link', 'show', 'dev', name], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function describeTunnelError(raw: string): string {
  if (/Operation not permitted|EPERM/i.test(raw)) {
    return 'Dem Panel-Container fehlt das Recht NET_ADMIN. Im Compose-File bzw. Unraid-Template „--cap-add=NET_ADMIN“ ergänzen und den Container neu erstellen.';
  }
  if (/ENOENT|not found/i.test(raw) && /\bip\b|\bwg\b|wireguard-go/.test(raw)) {
    return 'Im Panel-Abbild fehlen die WireGuard-Werkzeuge (wireguard-tools, iproute2). Bitte das Abbild aktualisieren.';
  }
  if (/tun/i.test(raw)) {
    return 'Der Kernel hat kein WireGuard-Modul und /dev/net/tun fehlt. Entweder das Modul laden (modprobe wireguard) oder den Container mit „--device /dev/net/tun“ starten.';
  }
  return `WireGuard konnte nicht eingerichtet werden: ${raw.slice(0, 300)}`;
}

/** Legt die Schnittstelle an (falls nötig) und setzt Schlüssel und Adresse. */
export async function ensureTunnel(): Promise<TunnelState> {
  const name = config.nodes.interfaceName;
  const keys = await panelKeyPair();
  const panelIp = panelTunnelIp();
  try {
    let mode = state.mode;
    if (!(await linkExists(name))) {
      try {
        await run('ip', ['link', 'add', 'dev', name, 'type', 'wireguard'], { timeout: 10_000 });
        mode = 'kernel';
      } catch (kernelError) {
        // Kein Modul im Kernel (Synology & Co.): Userspace-Implementierung.
        try {
          await startUserspace(name);
          mode = 'userspace';
        } catch (userspaceError) {
          const first = kernelError instanceof Error ? kernelError.message : String(kernelError);
          const second = userspaceError instanceof Error ? userspaceError.message : String(userspaceError);
          throw new Error(/Operation not permitted/i.test(first) ? first : `${first} / ${second}`);
        }
      }
    }
    await run('wg', ['set', name, 'private-key', keyFile()], { timeout: 10_000 });
    await run('ip', ['address', 'replace', `${panelIp}/${tunnelPrefix()}`, 'dev', name], { timeout: 10_000 });
    await run('ip', ['link', 'set', 'mtu', '1420', 'up', 'dev', name], { timeout: 10_000 });
    state = { up: true, error: null, mode: mode ?? 'kernel', panelIp, publicKey: keys.publicKey };
  } catch (err) {
    state = {
      up: false,
      error: describeTunnelError(err instanceof Error ? err.message : String(err)),
      mode: null,
      panelIp,
      publicKey: keys.publicKey,
    };
  }
  return tunnelState();
}

async function startUserspace(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // wireguard-go legt das Gerät an und geht danach selbst in den Hintergrund.
    const child = spawn('wireguard-go', [name], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `wireguard-go beendet mit ${code}`))));
  });
  for (let i = 0; i < 20; i++) {
    if (await linkExists(name)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('wireguard-go hat keine Schnittstelle angelegt (/dev/net/tun?)');
}

// ---------------------------------------------------------------------------
// Gegenstellen
// ---------------------------------------------------------------------------

export interface TunnelPeer {
  publicKey: string;
  host: string;
  port: number;
  tunnelIp: string;
}

export interface PeerStatus {
  endpoint: string | null;
  /** Letzter erfolgreicher Handschlag, `null` = noch nie */
  handshakeAt: Date | null;
  rxBytes: number;
  txBytes: number;
}

const endpointOf = (peer: TunnelPeer) =>
  `${peer.host.includes(':') && !peer.host.startsWith('[') ? `[${peer.host}]` : peer.host}:${peer.port}`;

/**
 * Bringt die Gegenstellen auf den Stand der Datenbank. Wird regelmäßig
 * aufgerufen – so löst sich auch ein DNS-Name neu auf, falls der VPS eine
 * andere Adresse bekommt.
 */
export async function syncPeers(peers: TunnelPeer[]): Promise<Map<string, string>> {
  const errors = new Map<string, string>();
  if (!state.up) return errors;
  const name = config.nodes.interfaceName;
  const current = await peerStatus().catch(() => new Map<string, PeerStatus>());
  const wanted = new Set(peers.map((peer) => peer.publicKey));
  for (const key of current.keys()) {
    if (!wanted.has(key)) await run('wg', ['set', name, 'peer', key, 'remove'], { timeout: 10_000 }).catch(() => {});
  }
  for (const peer of peers) {
    try {
      await run('wg', [
        'set', name, 'peer', peer.publicKey,
        'endpoint', endpointOf(peer),
        'allowed-ips', `${peer.tunnelIp}/32`,
        'persistent-keepalive', '25',
      ], { timeout: 15_000 });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      errors.set(peer.publicKey, /resolve|Name or service|not known/i.test(raw)
        ? `Adresse „${peer.host}“ lässt sich nicht auflösen`
        : `Tunnel-Gegenstelle konnte nicht gesetzt werden: ${raw.slice(0, 200)}`);
    }
  }
  return errors;
}

export async function removePeer(publicKey: string): Promise<void> {
  if (!state.up) return;
  await run('wg', ['set', config.nodes.interfaceName, 'peer', publicKey, 'remove'], { timeout: 10_000 }).catch(() => {});
}

export async function peerStatus(): Promise<Map<string, PeerStatus>> {
  const result = new Map<string, PeerStatus>();
  if (!state.up) return result;
  const { stdout } = await run('wg', ['show', config.nodes.interfaceName, 'dump'], { timeout: 10_000 });
  return parseWgDump(stdout);
}

/** `wg show <if> dump`: erste Zeile die Schnittstelle, danach eine je Gegenstelle. */
export function parseWgDump(dump: string): Map<string, PeerStatus> {
  const result = new Map<string, PeerStatus>();
  const lines = dump.trim().split('\n').slice(1);
  for (const line of lines) {
    const [publicKey, , endpoint, , handshake, rx, tx] = line.split('\t');
    if (!publicKey) continue;
    const seconds = Number(handshake);
    result.set(publicKey, {
      endpoint: endpoint && endpoint !== '(none)' ? endpoint : null,
      handshakeAt: seconds > 0 ? new Date(seconds * 1000) : null,
      rxBytes: Number(rx) || 0,
      txBytes: Number(tx) || 0,
    });
  }
  return result;
}
