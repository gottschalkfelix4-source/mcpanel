import Docker from 'dockerode';
import type { Container, ContainerInfo } from 'dockerode';
import type { Server } from '@prisma/client';
import { config, serverHostDir } from '../config.js';

export const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
});

export type PowerState = 'running' | 'starting' | 'stopped' | 'missing' | 'error';

export const LABEL_SERVER = 'mcpanel.server';

/**
 * Wird gerufen, bevor ein Container absichtlich anhält. Der Benachrichtigungs-
 * Wächter unterscheidet daran einen geplanten Stopp von einem Absturz – ein
 * per SIGKILL beendeter Container hinterlässt sonst denselben Exit-Code wie
 * ein echter Crash. Als Rückruf gelöst, damit docker.ts nichts importieren
 * muss (sonst entstünde ein Ringschluss mit notify.ts).
 */
let plannedStopHook: ((serverId: string) => void) | null = null;

export function onPlannedStop(fn: (serverId: string) => void): void {
  plannedStopHook = fn;
}

function announcePlannedStop(serverId: string): void {
  plannedStopHook?.(serverId);
}

/**
 * Passende Java-Version zur Minecraft-Version.
 *
 * Mojang bindet jede Ausgabe an eine JVM-Generation, und Mods brechen auf zu
 * neuen JVMs: ein 1.20.1-Pack auf Java 25 stirbt zum Beispiel im nativen Code
 * des Spark-Profilers. Deshalb wählen wir das Image nicht pauschal als
 * "latest", sondern anhand der Version.
 */
export function javaTagForVersion(mcVersion: string): string {
  const match = mcVersion.match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!match) return 'java21'; // LATEST, Snapshots, Unbekanntes

  const minor = Number(match[1]);
  const patch = Number(match[2] ?? 0);

  if (minor <= 16) return 'java8';
  if (minor <= 19) return 'java17';
  if (minor === 20) return patch >= 5 ? 'java21' : 'java17';
  return 'java21';
}

/** Image eines Servers: explizite Vorgabe schlägt automatische Wahl. */
export function imageForServer(server: Server): string {
  const explicit = (server.extraEnv as Record<string, string> | null)?.MC_IMAGE;
  if (explicit) return explicit;
  if (config.mcImage) return config.mcImage;
  return `${config.mcImageRepo}:${javaTagForVersion(server.mcVersion)}`;
}

export async function ensureNetwork(): Promise<void> {
  const nets = await docker.listNetworks({ filters: { name: [config.dockerNetwork] } });
  if (!nets.find((n) => n.Name === config.dockerNetwork)) {
    await docker.createNetwork({ Name: config.dockerNetwork, Driver: 'bridge' });
  }
}

export async function ensureImage(image: string, onProgress?: (msg: string) => void): Promise<void> {
  const local = await docker.listImages({ filters: { reference: [image] } });
  if (local.length > 0) return;
  onProgress?.(`Lade Image ${image} ...`);
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err) => (err ? reject(err) : resolve()),
      (event: { status?: string; progress?: string }) => {
        if (event.status) {
          onProgress?.(event.status + (event.progress ? ' ' + event.progress : ''));
        }
      },
    );
  });
}

export async function findContainer(server: Server): Promise<Container | null> {
  try {
    const c = docker.getContainer(server.containerName);
    await c.inspect();
    return c;
  } catch {
    return null;
  }
}

/** Baut die Environment-Liste für das itzg/minecraft-server Image. */
export function buildEnv(server: Server): string[] {
  const extra = (server.extraEnv ?? {}) as Record<string, string>;

  const env: Record<string, string> = {
    EULA: 'TRUE',
    TYPE: server.type === 'MODPACK' ? (extra.TYPE ?? 'FORGE') : server.type,
    VERSION: server.mcVersion || 'LATEST',
    MEMORY: `${server.memoryMb}M`,
    USE_AIKAR_FLAGS: 'true',
    ENABLE_RCON: 'true',
    RCON_PASSWORD: server.rconPassword,
    RCON_PORT: '25575',
    SERVER_PORT: '25565',
    // server.properties verwalten wir selbst über den Config-Tab.
    OVERRIDE_SERVER_PROPERTIES: 'false',
    SKIP_SUDO: 'true',
    STOP_SERVER_ANNOUNCE_DELAY: '5',
    TZ: process.env.TZ ?? 'Europe/Berlin',
    ...extra,
  };

  return Object.entries(env)
    .filter(([k]) => k !== 'MC_IMAGE')
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`);
}

/**
 * Speichergrenze des Containers.
 *
 * Über dem Java-Heap brauchen Metaspace, Code-Cache, GC-Strukturen,
 * Thread-Stacks und Direct Buffers Platz. Gemessen an einem Modpack mit ~400
 * Mods und 8 GB Heap: 9,58 GB anonymer Speicher, also gut 1,6 GB Aufschlag.
 *
 * Die Grenze ist ein Limit, keine Reservierung – großzügig zu rechnen kostet
 * nichts, ein zu knappes Limit dagegen killt den Server mitten im Spiel.
 */
export function containerMemoryBytes(memoryMb: number): number {
  const overhead = Math.min(4096, Math.max(1024, Math.round(memoryMb * 0.5)));
  return (memoryMb + overhead) * 1024 * 1024;
}

export async function createContainer(server: Server): Promise<Container> {
  await ensureNetwork();

  const memBytes = containerMemoryBytes(server.memoryMb);

  return docker.createContainer({
    name: server.containerName,
    Image: imageForServer(server),
    Env: buildEnv(server),
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    Labels: {
      [LABEL_SERVER]: server.id,
      'mcpanel.name': server.name,
    },
    ExposedPorts: {
      '25565/tcp': {},
      '25565/udp': {},
      '25575/tcp': {},
    },
    HostConfig: {
      Binds: [`${serverHostDir(server.id)}:/data`],
      PortBindings: {
        '25565/tcp': [{ HostPort: String(server.port) }],
        '25565/udp': [{ HostPort: String(server.port) }],
      },
      RestartPolicy: { Name: 'no' },
      Memory: memBytes,
      NetworkMode: config.dockerNetwork,
    },
  });
}

/**
 * Prüft, ob der vorhandene Container noch zu den gespeicherten Einstellungen
 * passt. Verglichen wird nur, was das Panel selbst setzt.
 */
async function configMatches(container: Container, server: Server): Promise<boolean> {
  try {
    const info = await container.inspect();

    if (info.Config.Image !== imageForServer(server)) return false;
    if (info.HostConfig.Memory !== containerMemoryBytes(server.memoryMb)) return false;
    if (info.HostConfig.PortBindings?.['25565/tcp']?.[0]?.HostPort !== String(server.port)) {
      return false;
    }

    const split = (entry: string): [string, string] => {
      const i = entry.indexOf('=');
      return [entry.slice(0, i), entry.slice(i + 1)];
    };
    const actual = new Map((info.Config.Env ?? []).map(split));
    for (const [key, value] of buildEnv(server).map(split)) {
      if (actual.get(key) !== value) return false;
    }

    return true;
  } catch {
    return false;
  }
}

export async function ensureContainer(server: Server): Promise<Container> {
  const existing = await findContainer(server);

  if (existing) {
    const info = await existing.inspect().catch(() => null);
    // Abweichungen nur beim gestoppten Container beheben – ein laufender
    // Server soll nicht unangekündigt neu aufgesetzt werden.
    if (info && !info.State.Running && !(await configMatches(existing, server))) {
      return recreateContainer(server);
    }
    return existing;
  }

  await ensureImage(imageForServer(server));
  return createContainer(server);
}

export async function removeContainer(server: Server): Promise<void> {
  const c = await findContainer(server);
  if (!c) return;
  announcePlannedStop(server.id);
  try {
    await c.remove({ force: true, v: false });
  } catch {
    /* bereits weg */
  }
}

/** Container löschen und mit den aktuellen Einstellungen neu anlegen. */
export async function recreateContainer(server: Server): Promise<Container> {
  await removeContainer(server);
  await ensureImage(imageForServer(server));
  return createContainer(server);
}

export async function getState(server: Server): Promise<{
  state: PowerState;
  health: string | null;
  startedAt: string | null;
}> {
  const c = await findContainer(server);
  if (!c) return { state: 'missing', health: null, startedAt: null };
  try {
    const info = await c.inspect();
    const health = info.State.Health?.Status ?? null;
    let state: PowerState = 'stopped';
    if (info.State.Running) {
      // Nur "starting" solange Docker selbst noch in der Startphase ist.
      // "unhealthy" heißt nicht, dass der Server unbenutzbar ist: bei großen
      // Modpacks antwortet der Status-Ping erst spät oder gar nicht, obwohl
      // Spieler längst verbinden können. Der Zustand wird separat gemeldet.
      state = health === 'starting' ? 'starting' : 'running';
    } else if (info.State.Dead || info.State.ExitCode > 0) {
      state = 'error';
    }
    return { state, health, startedAt: info.State.StartedAt ?? null };
  } catch {
    return { state: 'missing', health: null, startedAt: null };
  }
}

export async function start(server: Server): Promise<void> {
  const c = await ensureContainer(server);
  const info = await c.inspect();
  if (!info.State.Running) await c.start();
}

export async function stop(server: Server, timeout = 60): Promise<void> {
  const c = await findContainer(server);
  if (!c) return;
  announcePlannedStop(server.id);
  try {
    await c.stop({ t: timeout });
  } catch (e) {
    const err = e as { statusCode?: number };
    if (err.statusCode !== 304) throw e;
  }
}

export async function kill(server: Server): Promise<void> {
  const c = await findContainer(server);
  if (!c) return;
  announcePlannedStop(server.id);
  try {
    await c.kill();
  } catch {
    /* schon gestoppt */
  }
}

export async function restart(server: Server): Promise<void> {
  await stop(server);
  await start(server);
}

/** Ressourcennutzung (einmalige Momentaufnahme). */
export async function getStats(server: Server) {
  const c = await findContainer(server);
  if (!c) return null;
  try {
    const s = (await c.stats({ stream: false })) as unknown as {
      cpu_stats: {
        cpu_usage: { total_usage: number };
        system_cpu_usage: number;
        online_cpus?: number;
      };
      precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number };
      memory_stats: { usage?: number; limit?: number; stats?: { cache?: number } };
    };
    const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
    const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
    const cpus = s.cpu_stats.online_cpus ?? 1;
    const cpuPercent = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
    const cache = s.memory_stats.stats?.cache ?? 0;
    const memUsed = Math.max(0, (s.memory_stats.usage ?? 0) - cache);
    return {
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memoryUsed: memUsed,
      memoryLimit: s.memory_stats.limit ?? 0,
    };
  } catch {
    return null;
  }
}

/** Letzte N Zeilen des Container-Logs. */
export async function tailLogs(server: Server, lines = 300): Promise<string> {
  const c = await findContainer(server);
  if (!c) return '';
  const buf = (await c.logs({ stdout: true, stderr: true, tail: lines })) as unknown as Buffer;
  return stripDockerHeaders(buf);
}

/** Live-Log-Stream. Gibt eine Abbruchfunktion zurück. */
export async function followLogs(
  server: Server,
  onChunk: (chunk: string) => void,
): Promise<() => void> {
  const c = await findContainer(server);
  if (!c) return () => {};
  const stream = (await c.logs({
    stdout: true,
    stderr: true,
    follow: true,
    tail: 0,
  })) as unknown as NodeJS.ReadableStream;

  const handler = (buf: Buffer) => onChunk(stripDockerHeaders(buf));
  stream.on('data', handler);
  stream.on('error', () => {});

  return () => {
    stream.removeListener('data', handler);
    (stream as unknown as { destroy?: () => void }).destroy?.();
  };
}

/** Befehl über stdin schicken (Fallback, wenn RCON nicht erreichbar ist). */
export async function writeStdin(server: Server, line: string): Promise<void> {
  const c = await findContainer(server);
  if (!c) throw new Error('Container läuft nicht');
  const stream = await c.attach({
    stream: true,
    stdin: true,
    stdout: false,
    stderr: false,
    hijack: true,
  });
  stream.write(line.endsWith('\n') ? line : line + '\n');
  stream.end();
}

export async function listPanelContainers(): Promise<ContainerInfo[]> {
  return docker.listContainers({ all: true, filters: { label: [LABEL_SERVER] } });
}

/**
 * Ohne TTY multiplext Docker Logs mit einem 8-Byte-Header pro Frame,
 * mit TTY kommen die Bytes roh. Beide Fälle hier abfangen.
 */
function stripDockerHeaders(buf: Buffer): string {
  if (!Buffer.isBuffer(buf)) return String(buf);
  const out: Buffer[] = [];
  let off = 0;
  let multiplexed = false;
  while (off + 8 <= buf.length) {
    const type = buf[off];
    if (type > 2 || buf[off + 1] !== 0 || buf[off + 2] !== 0 || buf[off + 3] !== 0) break;
    const len = buf.readUInt32BE(off + 4);
    if (off + 8 + len > buf.length) break;
    out.push(buf.subarray(off + 8, off + 8 + len));
    off += 8 + len;
    multiplexed = true;
  }
  if (multiplexed && off === buf.length) return Buffer.concat(out).toString('utf8');
  return buf.toString('utf8');
}
