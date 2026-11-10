/**
 * Portweiterleitungen auf einer UniFi-Konsole (Dream Machine Pro & Co.).
 *
 * Das Panel hält die Weiterleitungen für Zusatzports (Simple Voice Chat,
 * Geyser, Web-Karten …) und auf Wunsch für die Spielports selbst aktuell –
 * niemand muss nach der Installation einer Mod noch an den Router.
 *
 * Schnittstelle: Die offizielle UniFi-Integrations-API kennt keine
 * Portweiterleitungen. Genutzt wird deshalb die klassische Netzwerk-API der
 * Konsole (`/proxy/network/api/s/<site>/rest/portforward`), angemeldet wahlweise
 * mit einem API-Schlüssel (Kopfzeile `X-API-KEY`) oder einem lokalen Benutzer
 * (Sitzungs-Cookie + CSRF-Token).
 *
 * Eigentum: Das Panel fasst nur Regeln an, deren Name mit „MCPanel “ beginnt.
 * Liegt auf einem benötigten Port bereits eine fremde Regel, wird sie nicht
 * überschrieben, sondern als Konflikt gemeldet.
 *
 * TLS: Konsolen haben fast immer ein selbstsigniertes Zertifikat. Ohne
 * Zertifikatsprüfung pinnt das Panel den SHA-256-Fingerabdruck, der beim
 * Verbindungstest gesehen und mit dem Speichern bestätigt wurde. Der
 * Fingerabdruck wird geprüft, bevor auch nur ein Byte der Anfrage – und damit
 * der Schlüssel – das Panel verlässt.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { z } from 'zod';
import { prisma } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { nodeLocation } from '../lib/serverLocation.js';
import { withQueuedOperation } from './operations.js';
import { getProxyConfig } from './proxy.js';
import { getSetting, setSetting } from './settings.js';

const SETTING_KEY = 'unifi.config';
export const RULE_PREFIX = 'MCPanel ';
const TIMEOUT_MS = 15_000;

export type WanInterface = 'wan' | 'wan2' | 'both';
export type RuleProtocol = 'tcp' | 'udp' | 'tcp_udp';

export interface UnifiConfig {
  enabled: boolean;
  /** Adresse der Konsole, z. B. https://192.168.1.1 */
  url: string;
  site: string;
  auth: 'apikey' | 'login';
  apiKey: string;
  username: string;
  password: string;
  /** Normale Zertifikatsprüfung (nur mit gültigem Zertifikat sinnvoll) */
  verifyTls: boolean;
  /** Gepinnter SHA-256-Fingerabdruck, wenn `verifyTls` aus ist */
  fingerprint: string;
  /** LAN-IP des Docker-Hosts, auf den weitergeleitet wird */
  forwardIp: string;
  wanInterface: WanInterface;
  /** Auch Spielports (bzw. den Subdomain-Proxy) freigeben */
  forwardGamePorts: boolean;
  /**
   * Erkannte Mod-Ports ohne Bestätigung freigeben. Aus = ein Administrator
   * schaltet jede Freigabe einzeln ein. Die Portnummer steht in Dateien des
   * Servers – wer dort schreiben darf, bestimmt sonst, was der Router öffnet.
   */
  autoForwardDetected: boolean;
}

export const EMPTY_CONFIG: UnifiConfig = {
  enabled: false, url: '', site: 'default', auth: 'apikey', apiKey: '', username: '', password: '',
  verifyTls: false, fingerprint: '', forwardIp: '', wanInterface: 'wan', forwardGamePorts: false,
  autoForwardDetected: false,
};

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export const unifiInputSchema = z.object({
  enabled: z.boolean(),
  url: z.string().trim().max(255).refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && (url.pathname === '/' || url.pathname === '');
    } catch { return false; }
  }, 'Bitte die Adresse der Konsole mit https:// angeben, z. B. https://192.168.1.1'),
  site: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Ungültiger Site-Name').default('default'),
  auth: z.enum(['apikey', 'login']),
  /** Leer = gespeicherten Wert behalten */
  apiKey: z.string().max(512).optional(),
  username: z.string().trim().max(128).default(''),
  password: z.string().max(512).optional(),
  verifyTls: z.boolean().default(false),
  /** Fingerabdruck aus dem Verbindungstest, den der Administrator bestätigt */
  fingerprint: z.string().trim().max(128).regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$|^$/i, 'Ungültiger Fingerabdruck').default(''),
  forwardIp: z.string().trim().refine((value) => value === '' || IPV4.test(value), 'Bitte eine IPv4-Adresse im Heimnetz angeben'),
  wanInterface: z.enum(['wan', 'wan2', 'both']).default('wan'),
  forwardGamePorts: z.boolean().default(false),
  autoForwardDetected: z.boolean().default(false),
});

let cached: UnifiConfig | null = null;

export async function getUnifiConfig(): Promise<UnifiConfig> {
  if (cached) return cached;
  const raw = await getSetting(SETTING_KEY, '');
  try {
    cached = raw ? { ...EMPTY_CONFIG, ...(JSON.parse(raw) as Partial<UnifiConfig>) } : { ...EMPTY_CONFIG };
  } catch {
    cached = { ...EMPTY_CONFIG };
  }
  return cached;
}

export async function saveUnifiConfig(next: UnifiConfig): Promise<void> {
  await setSetting(SETTING_KEY, JSON.stringify(next));
  cached = next;
  session = null;
}

/** Eingabe mit dem gespeicherten Stand zusammenführen – leere Geheimnisse bleiben erhalten. */
export async function mergeUnifiInput(input: z.infer<typeof unifiInputSchema>): Promise<UnifiConfig> {
  const current = await getUnifiConfig();
  const hostOf = (value: string) => { try { return new URL(value).host; } catch { return ''; } };
  const sameHost = hostOf(input.url) === hostOf(current.url);
  return {
    ...input,
    url: input.url.replace(/\/+$/, ''),
    // Ein gespeichertes Geheimnis geht nur an die Adresse, für die es
    // hinterlegt wurde – sonst ließe es sich an einen fremden Host schicken.
    apiKey: input.apiKey?.length ? input.apiKey.trim() : sameHost ? current.apiKey : '',
    password: input.password?.length ? input.password : sameHost ? current.password : '',
  };
}

/** Für die Oberfläche: Geheimnisse nie zurückgeben. */
export function publicUnifiConfig(config: UnifiConfig) {
  const { apiKey, password, ...rest } = config;
  return { ...rest, hasApiKey: apiKey.length > 0, hasPassword: password.length > 0 };
}

export function assertUsable(config: UnifiConfig): void {
  if (!config.url) throw badRequest('Bitte die Adresse der UniFi-Konsole angeben');
  if (config.auth === 'apikey' && !config.apiKey) throw badRequest('Bitte einen API-Schlüssel angeben');
  if (config.auth === 'login' && (!config.username || !config.password)) {
    throw badRequest('Bitte Benutzername und Passwort eines lokalen UniFi-Kontos angeben');
  }
  if (!config.verifyTls && !config.fingerprint) {
    throw badRequest('Bitte zuerst „Verbindung testen“ und den Zertifikats-Fingerabdruck bestätigen');
  }
}

// ---------------------------------------------------------------------------
// HTTP über eine vorab geprüfte TLS-Verbindung
// ---------------------------------------------------------------------------

export class UnifiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

interface Connected {
  socket: tls.TLSSocket;
  fingerprint: string;
}

function openTls(config: UnifiConfig): Promise<Connected> {
  const url = new URL(config.url);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || 443);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host, port,
      servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: config.verifyTls,
      ALPNProtocols: ['http/1.1'],
    });
    const fail = (err: Error) => { socket.destroy(); reject(err); };
    socket.setTimeout(TIMEOUT_MS, () => fail(new UnifiError(`Keine Antwort von ${url.host}`)));
    socket.once('error', (err) => reject(new UnifiError(`Konsole nicht erreichbar: ${err.message}`)));
    socket.once('secureConnect', () => {
      socket.setTimeout(0);
      resolve({ socket, fingerprint: socket.getPeerCertificate().fingerprint256 ?? '' });
    });
  });
}

/** Nur den Fingerabdruck holen – für den Verbindungstest vor dem Speichern. */
export async function readFingerprint(config: UnifiConfig): Promise<string> {
  const { socket, fingerprint } = await openTls({ ...config, verifyTls: false });
  socket.destroy();
  return fingerprint;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function rawRequest(config: UnifiConfig, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<RawResponse> {
  const { socket, fingerprint } = await openTls(config);
  if (!config.verifyTls && fingerprint.toUpperCase() !== config.fingerprint.toUpperCase()) {
    socket.destroy();
    throw new UnifiError(
      'Das Zertifikat der UniFi-Konsole hat sich geändert. Wenn das gewollt war (z. B. nach einem Update), ' +
      'in den Einstellungen die Verbindung neu testen und den Fingerabdruck bestätigen.',
    );
  }
  const url = new URL(config.url);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      method, path,
      createConnection: () => socket,
      headers: {
        Host: url.host,
        Accept: 'application/json',
        ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        Connection: 'close',
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) { req.destroy(new UnifiError('Antwort der Konsole ist zu groß')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new UnifiError('Zeitüberschreitung bei der UniFi-Konsole')));
    req.on('error', (err) => reject(err instanceof UnifiError ? err : new UnifiError(`Anfrage fehlgeschlagen: ${err.message}`)));
    req.end(payload);
  });
}

// ---------------------------------------------------------------------------
// Anmeldung
// ---------------------------------------------------------------------------

interface Session {
  key: string;
  cookie: string;
  csrf: string;
}
let session: Session | null = null;

function sessionKey(config: UnifiConfig): string {
  return crypto.createHash('sha256').update(`${config.url}\n${config.site}\n${config.username}\n${config.password}`).digest('hex');
}

async function login(config: UnifiConfig): Promise<Session> {
  const res = await rawRequest(config, 'POST', '/api/auth/login', {}, {
    username: config.username, password: config.password, remember: false,
  });
  if (res.status === 499 || /2fa|Ubic2faTokenRequired/i.test(res.body)) {
    throw new UnifiError('Dieses Konto verlangt einen zweiten Faktor. Bitte einen lokalen Benutzer ohne 2FA anlegen oder einen API-Schlüssel nutzen.', res.status);
  }
  if (res.status === 401 || res.status === 403) throw new UnifiError('Anmeldung an der UniFi-Konsole fehlgeschlagen – Benutzername oder Passwort falsch', res.status);
  if (res.status === 429) throw new UnifiError('Zu viele Anmeldeversuche – die Konsole sperrt kurzzeitig. Bitte später erneut versuchen.', res.status);
  if (res.status !== 200) throw new UnifiError(`Anmeldung an der UniFi-Konsole fehlgeschlagen (HTTP ${res.status})`, res.status);
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []).map((line) => line.split(';')[0]).filter(Boolean);
  const csrf = String(res.headers['x-csrf-token'] ?? res.headers['x-updated-csrf-token'] ?? '').trim();
  if (!cookies.length) throw new UnifiError('Die Konsole hat keine Sitzung ausgegeben');
  return { key: sessionKey(config), cookie: cookies.join('; '), csrf };
}

async function authHeaders(config: UnifiConfig, write: boolean): Promise<Record<string, string>> {
  if (config.auth === 'apikey') return { 'X-API-KEY': config.apiKey };
  if (!session || session.key !== sessionKey(config)) session = await login(config);
  return { Cookie: session.cookie, ...(write && session.csrf ? { 'X-CSRF-Token': session.csrf } : {}) };
}

interface Envelope<T> {
  meta?: { rc?: string; msg?: string };
  data?: T[];
}

/** Anfrage an die Netzwerk-API mit Fehlerübersetzung und einmaliger Neuanmeldung. */
async function api<T>(config: UnifiConfig, method: string, path: string, body?: unknown, retried = false): Promise<T[]> {
  const write = method !== 'GET';
  const fullPath = `/proxy/network/api/s/${encodeURIComponent(config.site)}${path}`;
  const res = await rawRequest(config, method, fullPath, await authHeaders(config, write), body);
  const updated = res.headers['x-updated-csrf-token'];
  if (session && typeof updated === 'string' && updated) session.csrf = updated.trim();

  if ((res.status === 401 || res.status === 403) && config.auth === 'login' && !retried) {
    session = null;
    return api<T>(config, method, path, body, true);
  }
  if (res.status === 401) {
    throw new UnifiError(config.auth === 'apikey'
      ? 'Der API-Schlüssel wurde abgelehnt. Nicht jede Fassung der Netzwerk-Anwendung erlaubt Portweiterleitungen per API-Schlüssel – dann bitte „Lokaler Benutzer“ wählen.'
      : 'Die UniFi-Konsole hat die Anmeldung abgelehnt.', 401);
  }
  if (res.status === 403) {
    throw new UnifiError('Dem Konto fehlen die Rechte für Portweiterleitungen (Netzwerk: Administrator nötig).', 403);
  }
  if (res.status === 404) {
    throw new UnifiError(`Die Netzwerk-API wurde nicht gefunden – stimmen Adresse und Site „${config.site}“? (Unterstützt werden UniFi-OS-Konsolen wie UDM Pro, UDR, UCG, Cloud Key Gen2+.)`, 404);
  }
  let parsed: Envelope<T>;
  try {
    parsed = JSON.parse(res.body) as Envelope<T>;
  } catch {
    throw new UnifiError(`Unerwartete Antwort der Konsole (HTTP ${res.status})`, res.status);
  }
  if (res.status >= 400 || parsed.meta?.rc !== 'ok') {
    if (parsed.meta?.msg === 'api.err.LoginRequired' && config.auth === 'login' && !retried) {
      session = null;
      return api<T>(config, method, path, body, true);
    }
    throw new UnifiError(`Die Konsole hat abgelehnt: ${parsed.meta?.msg ?? `HTTP ${res.status}`}`, res.status);
  }
  return parsed.data ?? [];
}

// ---------------------------------------------------------------------------
// Regeln planen und abgleichen
// ---------------------------------------------------------------------------

export interface PortForwardRule {
  _id?: string;
  name: string;
  enabled: boolean;
  pfwd_interface?: string;
  src?: string;
  dst_port: string;
  fwd: string;
  fwd_port: string;
  proto: string;
  log?: boolean;
  [key: string]: unknown;
}

export interface DesiredRule {
  name: string;
  port: number;
  protocol: RuleProtocol;
  ip: string;
}

export interface RulePlan {
  create: DesiredRule[];
  update: { existing: PortForwardRule; desired: DesiredRule }[];
  remove: PortForwardRule[];
  /** Benötigter Port ist durch eine fremde Regel belegt */
  conflicts: { desired: DesiredRule; existing: PortForwardRule }[];
}

const isOwn = (rule: PortForwardRule) => typeof rule.name === 'string' && rule.name.startsWith(RULE_PREFIX);

/** Belegt die Regel den Port? dst_port kann „25565“, „8000-8100“ oder „80,443“ sein. */
export function rulePorts(dstPort: string): (port: number) => boolean {
  const parts = String(dstPort ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  return (port) => parts.some((part) => {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) return port >= Number(range[1]) && port <= Number(range[2]);
    return Number(part) === port;
  });
}

const protocolsOverlap = (a: string, b: string) => a === b || a === 'tcp_udp' || b === 'tcp_udp';

export function planRules(existing: PortForwardRule[], desired: DesiredRule[], wan: WanInterface): RulePlan {
  const plan: RulePlan = { create: [], update: [], remove: [], conflicts: [] };
  const own = existing.filter(isOwn);
  const used = new Set<PortForwardRule>();

  for (const want of desired) {
    const mine = own.find((rule) => !used.has(rule) && String(rule.dst_port) === String(want.port));
    if (mine) {
      used.add(mine);
      const same = mine.name === want.name && mine.enabled === true && mine.fwd === want.ip
        && String(mine.fwd_port) === String(want.port) && mine.proto === want.protocol
        && (mine.pfwd_interface ?? 'wan') === wan;
      if (!same) plan.update.push({ existing: mine, desired: want });
      continue;
    }
    const foreign = existing.find((rule) => !isOwn(rule) && rule.enabled !== false
      && rulePorts(String(rule.dst_port))(want.port) && protocolsOverlap(String(rule.proto), want.protocol));
    if (foreign) plan.conflicts.push({ desired: want, existing: foreign });
    else plan.create.push(want);
  }
  plan.remove = own.filter((rule) => !used.has(rule));
  return plan;
}

function ruleBody(want: DesiredRule, wan: WanInterface): PortForwardRule {
  return {
    name: want.name,
    enabled: true,
    pfwd_interface: wan,
    src: 'any',
    dst_port: String(want.port),
    fwd: want.ip,
    fwd_port: String(want.port),
    proto: want.protocol,
    log: false,
  };
}

/** Regelname: „MCPanel <Server> <Zweck>“, kurz genug für die Oberfläche der Konsole. */
export function ruleName(server: string, purpose: string): string {
  const clean = (value: string) => value.replace(/[^\p{L}\p{N} ._()+-]/gu, '').replace(/\s+/g, ' ').trim();
  return `${RULE_PREFIX}${clean(server)} ${clean(purpose)}`.slice(0, 64).trim();
}

const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export interface DesiredResult {
  rules: DesiredRule[];
  /** Ports, die bewusst nicht weitergeleitet werden, mit Grund */
  skipped: { name: string; reason: string }[];
}

/** Welche Weiterleitungen sollte es nach aktuellem Stand geben? */
export async function desiredRules(config: UnifiConfig): Promise<DesiredResult> {
  const result: DesiredResult = { rules: [], skipped: [] };
  const servers = await prisma.server.findMany({
    select: { id: true, name: true, port: true, directConnect: true, nodeId: true, extraPorts: true },
    orderBy: { name: 'asc' },
  });

  const targetFor = (nodeId: string | null): { ip: string } | { reason: string } => {
    if (!nodeId) return config.forwardIp ? { ip: config.forwardIp } : { reason: 'Keine Ziel-IP des Hauptservers eingetragen' };
    const node = nodeLocation(nodeId);
    if (!node) return { reason: 'Node unbekannt' };
    if (!IPV4.test(node.publicHost) || !PRIVATE_IPV4.test(node.publicHost)) {
      return { reason: `Node ${node.name} steht nicht im Heimnetz (${node.publicHost})` };
    }
    return { ip: node.publicHost };
  };

  for (const server of servers) {
    const target = targetFor(server.nodeId);
    const wanted: { purpose: string; port: number; protocol: RuleProtocol }[] = [];
    for (const port of server.extraPorts) {
      if (port.forward) wanted.push({ purpose: port.label, port: port.hostPort, protocol: port.protocol as RuleProtocol });
    }
    if (config.forwardGamePorts && (server.directConnect || server.nodeId)) {
      wanted.push({ purpose: 'Spiel', port: server.port, protocol: 'tcp_udp' });
    }
    for (const want of wanted) {
      const name = ruleName(server.name, want.purpose);
      if ('reason' in target) result.skipped.push({ name, reason: target.reason });
      else result.rules.push({ name, port: want.port, protocol: want.protocol, ip: target.ip });
    }
  }

  if (config.forwardGamePorts) {
    const proxy = await getProxyConfig();
    if (proxy.enabled) {
      const name = ruleName('Proxy', 'Subdomains');
      if (config.forwardIp) result.rules.push({ name, port: proxy.port, protocol: 'tcp', ip: config.forwardIp });
      else result.skipped.push({ name, reason: 'Keine Ziel-IP des Hauptservers eingetragen' });
    }
  }

  // Doppelte Ports (z. B. Spielport und Proxy gleich) nur einmal anlegen.
  const seen = new Set<number>();
  result.rules = result.rules.filter((rule) => (seen.has(rule.port) ? false : (seen.add(rule.port), true)));
  return result;
}

export interface SyncStatus {
  at: string;
  ok: boolean;
  error: string | null;
  created: number;
  updated: number;
  removed: number;
  rules: { name: string; port: number; protocol: RuleProtocol; ip: string }[];
  conflicts: { name: string; port: number; existing: string }[];
  skipped: { name: string; reason: string }[];
}

let lastStatus: SyncStatus | null = null;
export const lastSyncStatus = () => lastStatus;

const PORTFORWARD = '/rest/portforward';

async function applyPlan(config: UnifiConfig, plan: RulePlan): Promise<void> {
  // Erst entfernen: ein umgezogener Port soll nicht an der alten Regel scheitern.
  for (const rule of plan.remove) await api(config, 'DELETE', `${PORTFORWARD}/${encodeURIComponent(String(rule._id))}`);
  for (const { existing, desired } of plan.update) {
    await api(config, 'PUT', `${PORTFORWARD}/${encodeURIComponent(String(existing._id))}`, { ...existing, ...ruleBody(desired, config.wanInterface) });
  }
  for (const desired of plan.create) await api(config, 'POST', PORTFORWARD, ruleBody(desired, config.wanInterface));
}

/** Weiterleitungen jetzt abgleichen. Wirft nicht – das Ergebnis steht im Status. */
export function syncUnifi(log: (msg: string) => void = () => {}): Promise<SyncStatus | null> {
  return withQueuedOperation('panel-unifi', 'UniFi-Abgleich', async () => {
    const config = await getUnifiConfig();
    if (!config.enabled) return null;
    const status: SyncStatus = {
      at: new Date().toISOString(), ok: false, error: null, created: 0, updated: 0, removed: 0,
      rules: [], conflicts: [], skipped: [],
    };
    try {
      assertUsable(config);
      const desired = await desiredRules(config);
      const existing = await api<PortForwardRule>(config, 'GET', PORTFORWARD);
      const plan = planRules(existing, desired.rules, config.wanInterface);
      await applyPlan(config, plan);
      Object.assign(status, {
        ok: true,
        created: plan.create.length, updated: plan.update.length, removed: plan.remove.length,
        rules: desired.rules.filter((rule) => !plan.conflicts.some((c) => c.desired === rule)),
        conflicts: plan.conflicts.map((c) => ({ name: c.desired.name, port: c.desired.port, existing: c.existing.name })),
        skipped: desired.skipped,
      });
      if (plan.create.length + plan.update.length + plan.remove.length > 0) {
        log(`UniFi: ${plan.create.length} angelegt, ${plan.update.length} angepasst, ${plan.remove.length} entfernt`);
      }
      for (const c of status.conflicts) log(`UniFi: Port ${c.port} ist bereits durch „${c.existing}“ belegt – ${c.name} nicht angelegt`);
    } catch (err) {
      status.error = err instanceof Error ? err.message : String(err);
      log(`UniFi-Abgleich fehlgeschlagen: ${status.error}`);
    }
    lastStatus = status;
    return status;
  });
}

/** Alle eigenen Regeln entfernen – beim Abschalten der Anbindung. */
export function removeAllRules(config: UnifiConfig): Promise<number> {
  return withQueuedOperation('panel-unifi', 'UniFi-Abgleich', async () => {
    assertUsable(config);
    const existing = await api<PortForwardRule>(config, 'GET', PORTFORWARD);
    const own = existing.filter(isOwn);
    for (const rule of own) await api(config, 'DELETE', `${PORTFORWARD}/${encodeURIComponent(String(rule._id))}`);
    lastStatus = null;
    return own.length;
  });
}

/**
 * Verbindung prüfen: Fingerabdruck lesen und – sofern bestätigt – die
 * Regelliste abrufen. Ändert nichts an der Konsole.
 */
export async function testUnifi(config: UnifiConfig): Promise<{ ok: boolean; fingerprint: string; message: string; rules?: number }> {
  let fingerprint = '';
  try {
    fingerprint = config.verifyTls ? '' : await readFingerprint(config);
  } catch (err) {
    return { ok: false, fingerprint, message: err instanceof Error ? err.message : String(err) };
  }
  if (!config.verifyTls && fingerprint.toUpperCase() !== config.fingerprint.toUpperCase()) {
    return {
      ok: false, fingerprint,
      message: 'Bitte den Zertifikats-Fingerabdruck der Konsole prüfen und bestätigen. Er steht in der Konsole unter Einstellungen → Steuerebene bzw. im Browser beim Aufruf der Adresse.',
    };
  }
  try {
    const previous = session;
    session = null;
    const rules = await api<PortForwardRule>(config, 'GET', PORTFORWARD);
    session = previous && previous.key === sessionKey(config) ? previous : session;
    return { ok: true, fingerprint, message: `Verbunden – ${rules.length} Portweiterleitung(en) auf der Konsole, davon ${rules.filter(isOwn).length} vom Panel.`, rules: rules.length };
  } catch (err) {
    return { ok: false, fingerprint, message: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Auslöser
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let logger: (msg: string) => void = (msg) => console.log(`[unifi] ${msg}`);

export function setUnifiLogger(fn: (msg: string) => void): void {
  logger = fn;
}

/**
 * Abgleich anstoßen – gebündelt, weil ein Start, eine Portänderung und eine
 * Einstellung oft kurz hintereinander kommen.
 */
export function scheduleUnifiSync(delayMs = 3000, attempt = 0): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void getUnifiConfig()
      .then((config) => (config.enabled ? syncUnifi(logger) : null))
      .then((status) => {
        // Konsole gerade nicht erreichbar (Neustart, Update)? Später erneut –
        // sonst bliebe eine Freigabe offen oder fehlte bis zum nächsten Anlass.
        if (status && !status.ok && attempt < RETRY_DELAYS.length && !timer) {
          scheduleUnifiSync(RETRY_DELAYS[attempt], attempt + 1);
        }
      })
      .catch((err) => logger(String(err)));
  }, delayMs);
  timer.unref?.();
}

const RETRY_DELAYS = [60_000, 180_000, 600_000];
let reconcileTimer: NodeJS.Timeout | null = null;

/** Zusätzlich alle 15 Minuten abgleichen – fängt alles, was ein Anlass verpasst hat. */
export function startUnifiReconcile(): void {
  if (reconcileTimer) return;
  reconcileTimer = setInterval(() => { if (!timer) scheduleUnifiSync(0); }, 15 * 60_000);
  reconcileTimer.unref();
}
