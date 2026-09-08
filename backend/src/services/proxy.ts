import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { domainToASCII } from 'node:url';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { badRequest, conflict } from '../lib/errors.js';
import { docker, ensureImage, ensureNetwork } from './docker.js';
import { getSetting, setSetting } from './settings.js';
import { withQueuedOperation } from './operations.js';

export const ROUTER_IMAGE = 'itzg/mc-router:1.46.5';
export const ROUTER_NAME = 'mcpanel-router';
const OWNER_LABEL = 'mcpanel.router';
export interface ProxyConfig { enabled: boolean; port: number }

export function normalizeHostname(raw: string): string {
  const name = domainToASCII(raw.trim().replace(/\.$/, '').toLowerCase());
  if (!name || name.length > 253 || net.isIP(name) || !name.includes('.') ||
      name.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw badRequest('Subdomain ungültig: DNS-Name ohne Port, Protokoll oder Wildcard erforderlich');
  }
  return name;
}

export function normalizeHostnames(names: string[]): string[] {
  if (names.length > 20) throw badRequest('Höchstens 20 Subdomains pro Server');
  const normalized = names.map(normalizeHostname);
  if (new Set(normalized).size !== normalized.length) throw conflict('Subdomain doppelt angegeben');
  return normalized;
}

export async function getProxyConfig(): Promise<ProxyConfig> {
  const raw = await getSetting('proxy.config');
  return raw ? JSON.parse(raw) : { enabled: false, port: 25565 };
}

export function routesDocument(rows: { hostname: string; server: { containerName: string } }[]) {
  return { mappings: Object.fromEntries(rows.map(row => [row.hostname, `${row.server.containerName}:25565`])) };
}

async function syncProxyRoutesUnlocked(): Promise<void> {
  const rows = await prisma.serverHostname.findMany({ include: { server: { select: { containerName: true } } } });
  const dir = path.join(config.dataRoot, 'proxy');
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `routes-${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmp, JSON.stringify(routesDocument(rows)), { mode: 0o644 });
    await fs.rename(tmp, path.join(dir, 'routes.json'));
    // mc-router 1.46.5 watches the old inode after an atomic rename. SIGHUP
    // explicitly reloads the current file without dropping existing players.
    const current = await routerContainer();
    if (current?.info.State.Running) await current.container.kill({ signal: 'SIGHUP' });
  } finally { await fs.rm(tmp, { force: true }); }
}

async function routerContainer() {
  const container = docker.getContainer(ROUTER_NAME);
  try {
    const info = await container.inspect();
    if (info.Config.Labels?.[OWNER_LABEL] !== 'true') throw conflict('Containername mcpanel-router ist bereits anderweitig belegt');
    return { container, info };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

async function reconcileProxyUnlocked(next?: ProxyConfig): Promise<void> {
  const desired = next ?? await getProxyConfig();
  await syncProxyRoutes();
  const existing = await routerContainer();
  if (!desired.enabled) {
    if (existing) await existing.container.remove({ force: true });
    return;
  }
  const occupied = await prisma.server.findFirst({ where: { port: desired.port, directConnect: true } });
  if (occupied) throw conflict(`Proxy-Port ${desired.port} wird von „${occupied.name}“ verwendet. Zuerst dessen Direktport ändern oder Direktzugriff deaktivieren.`);
  if (existing && existing.info.HostConfig.PortBindings?.['25565/tcp']?.[0]?.HostPort === String(desired.port)
      && existing.info.Config.Image === ROUTER_IMAGE) {
    if (!existing.info.State.Running) await existing.container.start();
    return;
  }
  await ensureNetwork();
  await ensureImage(ROUTER_IMAGE);
  if (existing) await existing.container.remove({ force: true });
  const container = await docker.createContainer({
    name: ROUTER_NAME, Image: ROUTER_IMAGE, Labels: { [OWNER_LABEL]: 'true' },
    Env: ['ROUTES_CONFIG=/routes/routes.json'],
    ExposedPorts: { '25565/tcp': {} },
    HostConfig: {
      Binds: [`${config.hostDataRoot.replace(/\/$/, '')}/proxy:/routes:ro`],
      NetworkMode: config.dockerNetwork, RestartPolicy: { Name: 'unless-stopped' },
      PortBindings: { '25565/tcp': [{ HostPort: String(desired.port) }] },
      Memory: 128 * 1024 * 1024,
    },
  });
  await container.start();
}

export async function configureProxy(next: ProxyConfig): Promise<void> {
  return withQueuedOperation('panel-proxy', 'Proxy-Konfiguration', async () => {
    const previous = await getProxyConfig();
    try {
      await reconcileProxy(next);
      await setSetting('proxy.config', JSON.stringify(next));
    } catch (err) {
      await reconcileProxy(previous).catch(() => {});
      throw err;
    }
  });
}

export async function proxyStatus() {
  const desired = await getProxyConfig();
  try {
    const current = await routerContainer();
    const running = Boolean(current?.info.State.Running);
    let reachable = false;
    if (running) reachable = await new Promise<boolean>(resolve => {
      const socket = net.createConnection({ host: ROUTER_NAME, port: 25565 });
      const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
      socket.setTimeout(1500, () => done(false));
      socket.once('error', () => done(false));
      socket.once('connect', () => done(true));
    });
    return { ...desired, running, reachable, image: ROUTER_IMAGE, error: null };
  } catch (err) {
    return { ...desired, running: false, reachable: false, image: ROUTER_IMAGE, error: err instanceof Error ? err.message : 'Docker nicht erreichbar' };
  }
}

export const syncProxyRoutes = () => withQueuedOperation('panel-proxy', 'Proxy-Routen', syncProxyRoutesUnlocked);
export const reconcileProxy = (next?: ProxyConfig) => withQueuedOperation('panel-proxy', 'Proxy-Konfiguration', () => reconcileProxyUnlocked(next));
