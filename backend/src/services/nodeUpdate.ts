/**
 * Node-Agent per Knopfdruck aktualisieren.
 *
 * Ablauf aus Sicht des Panels, alles über die Docker-Weiterleitung des Agenten:
 *
 *   1. Abbild auf der Node frisch laden (dieselbe Fassung wie das Panel)
 *   2. bisherigen Agent-Container auslesen und daraus die Einstellungen für den
 *      neuen ableiten (`agentSpec`)
 *   3. Hilfscontainer `mcpanel-node-update` aus dem neuen Abbild starten – er
 *      tauscht den Agenten am Docker-Socket der Node aus (`node/updater.ts`)
 *   4. warten, bis die Node wieder antwortet, und am Hilfscontainer ablesen,
 *      ob es geklappt hat
 *
 * Minecraft-Server laufen währenddessen weiter; nur Konsole, Dateien und RCON
 * sind für einige Sekunden nicht erreichbar.
 */
import type Docker from 'dockerode';
import type { Node } from '@prisma/client';
import { prisma } from '../db.js';
import { conflict, notFound } from '../lib/errors.js';
import { AGENT_INTERNAL_PORTS, WINDOWS_PUBLISHED_PORTS } from '../node/protocol.js';
import type { UpdatePlan } from '../node/updater.js';
import { assertNodeReady, rawNodeDocker } from './nodeClients.js';

export const AGENT_CONTAINER = 'mcpanel-node';
export const UPDATER_CONTAINER = 'mcpanel-node-update';
/** So lange darf der neue Agent bis „Bereit“ brauchen, bevor der alte zurückkommt. */
const AGENT_READY_TIMEOUT_MS = 120_000;
/** So lange wartet das Panel insgesamt auf die Rückkehr der Node. */
const RETURN_TIMEOUT_MS = 5 * 60_000;

export interface NodeUpdateState {
  state: 'running' | 'done' | 'failed';
  message: string;
  image: string;
  fromVersion: string;
  toVersion: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

const updates = new Map<string, NodeUpdateState>();

export function nodeUpdateState(nodeId: string): NodeUpdateState | null {
  return updates.get(nodeId) ?? null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Zeitüberschreitung')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

const isNotFound = (err: unknown) => (err as { statusCode?: number })?.statusCode === 404;

/** Umgebungseinträge, die vom Abbild stammen (PATH, MCPANEL_VERSION …), nicht übernehmen. */
function ownEntries(values: string[] | undefined, fromImages: Set<string>): string[] {
  return (values ?? []).filter((entry) => !fromImages.has(entry.split('=')[0]));
}

function ownLabels(labels: Record<string, string> | undefined, fromImages: Set<string>): Record<string, string> {
  return Object.fromEntries(Object.entries(labels ?? {}).filter(([key]) => !fromImages.has(key)));
}

/**
 * Einstellungen des neuen Agent-Containers: alles, was der Installationsbefehl
 * gesetzt hat (Netz, Rechte, Geräte, Einhängungen, Ports, Healthcheck), mit dem
 * neuen Abbild. Was vom alten Abbild stammt, fällt weg – sonst meldete der neue
 * Agent etwa weiter die alte `MCPANEL_VERSION`.
 *
 * Bei Windows-Nodes ohne VPN werden die Ports ergänzt, die neuere Fassungen
 * brauchen (etwa die RCON-Weiterleitung) – so heilt ein Update auch eine
 * Installation aus einer älteren Fassung.
 */
export function agentSpec(
  info: Docker.ContainerInspectInfo,
  image: string,
  imageConfigs: Array<{ Env?: string[]; Labels?: Record<string, string> | null } | undefined>,
  node: Pick<Node, 'platform' | 'connection'>,
): Record<string, unknown> {
  const imageEnv = new Set(imageConfigs.flatMap((c) => (c?.Env ?? []).map((entry) => entry.split('=')[0])));
  const imageLabels = new Set(imageConfigs.flatMap((c) => Object.keys(c?.Labels ?? {})));
  const host = info.HostConfig as Docker.HostConfig;

  const portBindings: Record<string, Array<{ HostIp?: string; HostPort?: string }>> = { ...(host.PortBindings ?? {}) };
  if (node.platform === 'windows' && node.connection === 'direct') {
    for (const key of Object.keys(AGENT_INTERNAL_PORTS) as Array<keyof typeof AGENT_INTERNAL_PORTS>) {
      const binding = `${AGENT_INTERNAL_PORTS[key]}/tcp`;
      if (!portBindings[binding]?.length) portBindings[binding] = [{ HostIp: '', HostPort: String(WINDOWS_PUBLISHED_PORTS[key]) }];
    }
  }
  const exposed = Object.fromEntries(Object.keys(portBindings).map((key) => [key, {}]));

  const hostConfig: Record<string, unknown> = {
    NetworkMode: host.NetworkMode,
    Binds: host.Binds ?? undefined,
    Mounts: (host as { Mounts?: unknown[] }).Mounts?.length ? (host as { Mounts?: unknown[] }).Mounts : undefined,
    RestartPolicy: host.RestartPolicy ?? { Name: 'unless-stopped' },
    CapAdd: host.CapAdd ?? undefined,
    CapDrop: host.CapDrop ?? undefined,
    Devices: host.Devices?.length ? host.Devices : undefined,
    Privileged: host.Privileged || undefined,
    SecurityOpt: host.SecurityOpt ?? undefined,
    PortBindings: Object.keys(portBindings).length ? portBindings : undefined,
    LogConfig: host.LogConfig?.Type ? host.LogConfig : undefined,
    ExtraHosts: host.ExtraHosts ?? undefined,
    Dns: host.Dns?.length ? host.Dns : undefined,
  };
  return {
    Image: image,
    Env: ownEntries(info.Config.Env, imageEnv),
    Labels: ownLabels(info.Config.Labels, imageLabels),
    Healthcheck: info.Config.Healthcheck ?? undefined,
    ExposedPorts: Object.keys(exposed).length ? exposed : undefined,
    HostConfig: JSON.parse(JSON.stringify(hostConfig)),
  };
}

/** Abbild auf der Node laden – auch wenn es dort schon liegt („latest“ wandert). */
async function pullImage(docker: Docker, image: string, onProgress: (msg: string) => void): Promise<void> {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err) => (err ? reject(err) : resolve()),
      (event: { status?: string; progress?: string }) => {
        if (event.status) onProgress(event.status + (event.progress ? ` ${event.progress}` : ''));
      },
    );
  });
}

/** Letzte Zeilen eines Containerprotokolls ohne Docker-Rahmenköpfe. */
function readableLogs(raw: Buffer | string): string[] {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  return text
    .split('\n')
    .map((line) => line.replace(/^[\x00-\x08][\x00]{3}[\s\S]{4}/, '').replace(/[\x00-\x08\x0b-\x1f]/g, '').trim())
    .filter(Boolean);
}

export interface UpdateDeps {
  docker: Docker;
  /** Nach dem Austausch die Verbindungsprüfung sofort anstoßen */
  recheck: () => Promise<void>;
  /** Abbildname für den Agenten (wie im Installationsbefehl) */
  image: string;
  wait?: (ms: number) => Promise<void>;
  returnTimeoutMs?: number;
}

/**
 * Der eigentliche Ablauf; wirft mit einer deutschen Meldung. `report` erhält
 * Zwischenstände für die Oberfläche.
 */
export async function performAgentUpdate(
  node: Node,
  deps: UpdateDeps,
  report: (message: string) => void,
): Promise<{ changed: boolean; version: string | null }> {
  const { docker, image } = deps;
  const wait = deps.wait ?? sleep;

  report(`Abbild ${image} wird auf der Node geladen …`);
  let lastReport = 0;
  await pullImage(docker, image, (line) => {
    const now = Date.now();
    if (now - lastReport < 1500) return;
    lastReport = now;
    report(`Abbild wird geladen: ${line}`);
  }).catch((err) => {
    throw new Error(`Abbild ${image} ließ sich auf der Node nicht laden: ${err instanceof Error ? err.message : err}`);
  });

  let info: Docker.ContainerInspectInfo;
  try {
    info = await docker.getContainer(AGENT_CONTAINER).inspect();
  } catch (err) {
    if (isNotFound(err)) throw new Error(`Auf der Node gibt es keinen Container „${AGENT_CONTAINER}“ – bitte einmal den Installationsbefehl ausführen.`);
    throw err;
  }
  const fresh = await docker.getImage(image).inspect();
  const previous = await docker.getImage(info.Image).inspect().catch(() => undefined);
  const spec = agentSpec(info, image, [fresh.Config, previous?.Config], node);
  const version = fresh.Config.Env?.find((entry) => entry.startsWith('MCPANEL_VERSION='))?.slice('MCPANEL_VERSION='.length) || null;

  const samePorts = JSON.stringify((spec.HostConfig as { PortBindings?: unknown }).PortBindings ?? {})
    === JSON.stringify(info.HostConfig.PortBindings ?? {});
  if (fresh.Id === info.Image && samePorts) return { changed: false, version };

  // Ein Helfer aus einem früheren Lauf stünde sonst im Weg.
  await docker.getContainer(UPDATER_CONTAINER).remove({ force: true }).catch((err) => {
    if (!isNotFound(err)) throw err;
  });

  const plan: UpdatePlan = { name: AGENT_CONTAINER, spec, timeoutMs: AGENT_READY_TIMEOUT_MS };
  report('Agent wird ausgetauscht – die Node ist kurz nicht erreichbar …');
  const helper = await docker.createContainer({
    name: UPDATER_CONTAINER,
    Image: image,
    Env: ['MCPANEL_ROLE=node-update', `UPDATE_PLAN=${Buffer.from(JSON.stringify(plan), 'utf8').toString('base64')}`],
    Labels: { 'mcpanel.node-update': 'true' },
    Healthcheck: { Test: ['NONE'] },
    HostConfig: {
      Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
      NetworkMode: 'none',
      RestartPolicy: { Name: 'no' },
    },
  });
  await helper.start();

  // Der Helfer wartet zwei Sekunden, bevor er den Agenten stoppt. Danach ist
  // die Node weg, bis der neue (oder im Fehlerfall der alte) Agent antwortet.
  const deadline = Date.now() + (deps.returnTimeoutMs ?? RETURN_TIMEOUT_MS);
  await wait(4000);
  while (Date.now() < deadline) {
    const state = await withTimeout(docker.getContainer(UPDATER_CONTAINER).inspect(), 5000).catch(() => null);
    if (state && !state.State.Running) {
      const logs = readableLogs(await withTimeout(docker.getContainer(UPDATER_CONTAINER).logs({ stdout: true, stderr: true, tail: 40 }), 5000)
        .catch(() => '') as Buffer | string);
      await docker.getContainer(UPDATER_CONTAINER).remove({ force: true }).catch(() => {});
      await deps.recheck().catch(() => {});
      if (state.State.ExitCode === 0) return { changed: true, version };
      const failure = [...logs].reverse().find((line) => /FEHLER|Fehlgeschlagen/.test(line))
        ?.replace(/^.*?(FEHLER|Fehlgeschlagen):\s*/, '') ?? `Hilfscontainer endete mit Code ${state.State.ExitCode}`;
      throw new Error(`Update fehlgeschlagen: ${failure}`);
    }
    report(state ? 'Agent wird ausgetauscht …' : 'Warte, bis die Node wieder antwortet …');
    await wait(3000);
  }
  throw new Error('Die Node meldet sich nach dem Update nicht zurück. Auf der Node „docker logs mcpanel-node-update“ und „docker logs mcpanel-node“ prüfen.');
}

/**
 * Startet das Update im Hintergrund. Den Fortschritt liefert `nodeUpdateState`
 * (die Node-Übersicht fragt ihn ab).
 */
export async function startAgentUpdate(nodeId: string, deps: Omit<UpdateDeps, 'docker'>): Promise<NodeUpdateState> {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) throw notFound('Node nicht gefunden');
  if (updates.get(nodeId)?.state === 'running') throw conflict('Für diese Node läuft bereits ein Update.');
  assertNodeReady(nodeId);

  const entry: NodeUpdateState = {
    state: 'running',
    message: 'Update wird vorbereitet …',
    image: deps.image,
    fromVersion: node.agentVersion,
    toVersion: null,
    startedAt: new Date(),
    finishedAt: null,
  };
  updates.set(nodeId, entry);
  const finish = (state: 'done' | 'failed', message: string) => {
    entry.state = state;
    entry.message = message;
    entry.finishedAt = new Date();
  };

  void performAgentUpdate(node, { ...deps, docker: rawNodeDocker(nodeId) }, (message) => { entry.message = message; })
    .then(({ changed, version }) => {
      entry.toVersion = version;
      finish('done', changed
        ? `Agent aktualisiert${version ? ` auf ${version}` : ''}.`
        : `Agent ist bereits auf dem neuesten Stand${version ? ` (${version})` : ''}.`);
    })
    .catch((err) => finish('failed', err instanceof Error ? err.message : String(err)));
  return entry;
}
