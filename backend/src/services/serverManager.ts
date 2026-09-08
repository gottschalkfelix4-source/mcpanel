import { withServerOperation, withQueuedOperation } from './operations.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server, ServerType } from '@prisma/client';
import { backupsDir, cacheDir, config, serverBackupDir, serverDir, serversDir } from '../config.js';
import { prisma } from '../db.js';
import { conflict } from '../lib/errors.js';
import * as dockerSvc from './docker.js';
import { getDiskUsage, invalidateDiskUsage } from './diskUsage.js';
import { getPlayerCount } from './playerCount.js';
import { getPublicHost } from './settings.js';
import { getProxyConfig } from './proxy.js';

export interface CreateServerInput {
  name: string;
  description?: string;
  ownerId: string;
  type: ServerType;
  mcVersion: string;
  memoryMb: number;
  port?: number;
  extraEnv?: Record<string, string>;
  /** Kontingente; 0 bedeutet unbegrenzt. */
  quota?: { quotaDiskMb: number; quotaBackups: number; quotaMemoryMb: number };
}

export async function ensureDataDirs(): Promise<void> {
  await fs.mkdir(serversDir(), { recursive: true });
  await fs.mkdir(backupsDir(), { recursive: true });
  await fs.mkdir(path.join(cacheDir(), 'modpacks'), { recursive: true });
}

/** Sucht den nächsten freien Port im konfigurierten Bereich. */
export async function allocatePort(preferred?: number, database: Pick<typeof prisma, 'server'> = prisma): Promise<number> {
  const used = new Set((await database.server.findMany({ select: { port: true } })).map((s) => s.port));
  const proxy = await getProxyConfig();
  if (proxy.enabled) used.add(proxy.port);
  if (preferred) {
    if (used.has(preferred)) throw conflict('Der gewünschte Port ist bereits belegt');
    return preferred;
  }
  for (let p = config.portRange.min; p <= config.portRange.max; p++) {
    if (!used.has(p)) return p;
  }
  throw conflict('Keine freien Ports mehr im konfigurierten Bereich');
}

async function createServerUnlocked(input: CreateServerInput): Promise<Server> {
  const rconPassword = crypto.randomBytes(16).toString('hex');
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);

  const server = await prisma.$transaction(async tx => {
    await tx.$executeRaw`LOCK TABLE "Server" IN EXCLUSIVE MODE`;
    const port = await allocatePort(input.port, tx);
    return tx.server.create({
    data: {
      id,
      name: input.name,
      description: input.description ?? '',
      ownerId: input.ownerId,
      containerName: `${config.containerPrefix}-${id}`,
      port,
      rconPort: 25575,
      rconPassword,
      memoryMb: input.memoryMb,
      type: input.type,
      mcVersion: input.mcVersion,
      extraEnv: input.extraEnv ?? {},
      quotaDiskMb: input.quota?.quotaDiskMb ?? 0,
      quotaBackups: input.quota?.quotaBackups ?? 0,
      quotaMemoryMb: input.quota?.quotaMemoryMb ?? 0,
    },
    });
  });

  try {
  await fs.mkdir(serverDir(server.id), { recursive: true });
  await fs.mkdir(serverBackupDir(server.id), { recursive: true });
  // itzg akzeptiert EULA über die Umgebung, wir legen die Datei trotzdem an.
  await fs.writeFile(path.join(serverDir(server.id), 'eula.txt'), 'eula=true\n', 'utf8').catch(() => {});

  await dockerSvc.ensureNetwork();
  await dockerSvc.ensureImage(dockerSvc.imageForServer(server));
  await dockerSvc.createContainer(server);

  return server;
  } catch (err) {
    // Never delete files if Docker cannot confirm removal (BUG-20).
    await dockerSvc.removeContainer(server);
    await prisma.server.delete({ where: { id: server.id } });
    await fs.rm(serverDir(server.id), { recursive: true, force: true });
    await fs.rm(serverBackupDir(server.id), { recursive: true, force: true });
    throw err;
  }
}

async function deleteServerUnlocked(server: Server, deleteFiles: boolean): Promise<void> {
  await dockerSvc.removeContainer(server);
  await prisma.server.delete({ where: { id: server.id } });
  invalidateDiskUsage(server.id);
  if (deleteFiles) {
    await fs.rm(serverDir(server.id), { recursive: true, force: true });
    await fs.rm(serverBackupDir(server.id), { recursive: true, force: true });
  }
}

/**
 * Übernimmt geänderte Einstellungen. Änderungen an RAM/Version/Typ/Env
 * erfordern einen neuen Container – der wird hier transparent neu erstellt.
 */
async function updateServerSettingsUnlocked(
  server: Server,
  data: Partial<
    Pick<
      Server,
      | 'name' | 'description' | 'memoryMb' | 'mcVersion' | 'type' | 'autoStart' | 'port' | 'directConnect'
      | 'quotaDiskMb' | 'quotaBackups' | 'quotaMemoryMb'
    >
  > & {
    extraEnv?: Record<string, string>;
  },
): Promise<{ server: Server; recreated: boolean }> {
  if (data.port !== undefined || data.directConnect === true) {
    const proxy = await getProxyConfig();
    if (proxy.enabled && (data.port ?? server.port) === proxy.port && (data.directConnect ?? server.directConnect)) {
      throw conflict('Dieser Port ist für den Minecraft-Proxy reserviert');
    }
  }
  const needsRecreate =
    (data.port !== undefined && data.port !== server.port) ||
    (data.directConnect !== undefined && data.directConnect !== server.directConnect) ||
    (data.memoryMb !== undefined && data.memoryMb !== server.memoryMb) ||
    (data.mcVersion !== undefined && data.mcVersion !== server.mcVersion) ||
    (data.type !== undefined && data.type !== server.type) ||
    (data.extraEnv !== undefined && JSON.stringify(Object.entries(data.extraEnv).sort()) !==
      JSON.stringify(Object.entries((server.extraEnv ?? {}) as Record<string, string>).sort()));

  // Inspect before persisting: a Docker outage must not leave unapplied settings.
  const previousState = needsRecreate ? await dockerSvc.getState(server) : null;
  const updated = await prisma.server.update({
    where: { id: server.id },
    data: {
      ...(data.port !== undefined ? { port: data.port } : {}),
      ...(data.directConnect !== undefined ? { directConnect: data.directConnect } : {}),
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.memoryMb !== undefined ? { memoryMb: data.memoryMb } : {}),
      ...(data.mcVersion !== undefined ? { mcVersion: data.mcVersion } : {}),
      ...(data.type !== undefined ? { type: data.type } : {}),
      ...(data.autoStart !== undefined ? { autoStart: data.autoStart } : {}),
      ...(data.extraEnv !== undefined ? { extraEnv: data.extraEnv } : {}),
      ...(data.quotaDiskMb !== undefined ? { quotaDiskMb: data.quotaDiskMb } : {}),
      ...(data.quotaBackups !== undefined ? { quotaBackups: data.quotaBackups } : {}),
      ...(data.quotaMemoryMb !== undefined ? { quotaMemoryMb: data.quotaMemoryMb } : {}),
    },
  });

  if (!needsRecreate) return { server: updated, recreated: false };

  const wasRunning = previousState?.state === 'running' || previousState?.state === 'starting';
  try {
    if (wasRunning) await dockerSvc.stop(updated);
    await dockerSvc.recreateContainer(updated);
    if (wasRunning) await dockerSvc.start(updated);
  } catch (err) {
    const restore = Object.fromEntries(Object.keys(data).map(key => [key, server[key as keyof Server]]));
    await prisma.server.update({ where: { id: server.id }, data: restore });
    await dockerSvc.recreateContainer(server);
    if (wasRunning) await dockerSvc.start(server);
    throw err;
  }

  return { server: updated, recreated: true };
}

/** Kompakte Darstellung für Listen und Dashboard. */
export async function serializeServer(server: Server, extra?: { withStats?: boolean }) {
  const { state, health, startedAt } = await dockerSvc.getState(server);
  const running = state === 'running';
  const host = await getPublicHost();
  const hostnames = await prisma.serverHostname.findMany({ where: { serverId: server.id }, orderBy: { position: 'asc' } });
  const proxy = await getProxyConfig();
  const directAddress = `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${server.port}`;
  const stats = extra?.withStats && running ? await dockerSvc.getStats(server) : null;
  const players = extra?.withStats ? getPlayerCount(server, running) : null;

  return {
    id: server.id,
    name: server.name,
    description: server.description,
    ownerId: server.ownerId,
    type: server.type,
    mcVersion: server.mcVersion,
    memoryMb: server.memoryMb,
    port: server.port,
    address: proxy.enabled && hostnames.length ? `${hostnames[0].hostname}${proxy.port === 25565 ? '' : `:${proxy.port}`}` : server.directConnect ? directAddress : '',
    directAddress,
    directConnect: server.directConnect,
    proxy: { ...proxy, hostnames: hostnames.map(row => row.hostname) },
    autoStart: server.autoStart,
    state,
    health,
    startedAt,
    stats,
    players,
    modpack: server.modpackProjectId
      ? {
          provider: server.modpackProvider,
          projectId: server.modpackProjectId,
          versionId: server.modpackVersionId,
          name: server.modpackName,
          versionName: server.modpackVersionName,
          iconUrl: server.modpackIconUrl,
        }
      : null,
    createdAt: server.createdAt,
  };
}

export async function serverDiskUsage(server: Server) {
  return getDiskUsage(server.id);
}

/** Startet beim Panel-Start alle Server mit aktiviertem Autostart. */
export async function runAutostart(): Promise<void> {
  const servers = await prisma.server.findMany({ where: { autoStart: true } });
  for (const server of servers) {
    try {
      await dockerSvc.start(server);
    } catch (err) {
      console.error(`Autostart für ${server.name} fehlgeschlagen:`, err);
    }
  }
}

export const deleteServer = (...args: Parameters<typeof deleteServerUnlocked>) => withServerOperation(args[0].id, "deleteServer", () => deleteServerUnlocked(...args));

export const updateServerSettings = (...args: Parameters<typeof updateServerSettingsUnlocked>) => withServerOperation(args[0].id, "updateServerSettings", () => withQueuedOperation('panel-proxy', 'Serverports', () => updateServerSettingsUnlocked(...args)));

export const createServer = (input: CreateServerInput) => withQueuedOperation('panel-proxy', 'Serverports', () => createServerUnlocked(input));
