import type { ContainerInspectInfo } from 'dockerode';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { docker, findContainer } from './docker.js';
import { proxyStatus, ROUTER_NAME } from './proxy.js';
import { getPublicHost } from './settings.js';

export interface PublishedPort {
  hostIp: string;
  hostPort: number;
  containerPort: number;
  protocol: string;
  active: boolean;
}
export interface RoutingRuntime {
  state: 'running' | 'stopped' | 'missing' | 'unknown';
  ports: PublishedPort[];
  error: string | null;
}

/** ExposedPorts alone is not a host publication. Read actual and configured bindings. */
export function routingRuntime(info: ContainerInspectInfo): RoutingRuntime {
  const ports = new Map<string, PublishedPort>();
  const add = (bindings: Record<string, { HostIp: string; HostPort: string }[] | null> | undefined, active: boolean) => {
    for (const [target, addresses] of Object.entries(bindings ?? {})) {
      const [containerPort, protocol] = target.split('/');
      for (const address of addresses ?? []) {
        const hostPort = Number(address.HostPort);
        if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) continue;
        const hostIp = address.HostIp || '0.0.0.0';
        const key = `${hostIp}:${hostPort}/${protocol}`;
        if (!ports.has(key)) ports.set(key, { hostIp, hostPort, containerPort: Number(containerPort), protocol, active });
      }
    }
  };
  add(info.NetworkSettings.Ports, info.State.Running);
  add(info.HostConfig.PortBindings, false);
  return { state: info.State.Running ? 'running' : 'stopped', ports: [...ports.values()], error: null };
}

async function readRuntime(read: () => Promise<ContainerInspectInfo | null>): Promise<RoutingRuntime> {
  try {
    const info = await read();
    return info ? routingRuntime(info) : { state: 'missing', ports: [], error: null };
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return { state: 'missing', ports: [], error: null };
    return { state: 'unknown', ports: [], error: error instanceof Error ? error.message : 'Docker-Abfrage fehlgeschlagen' };
  }
}

export function routerPortPlan(owners: { id: string; name: string; requiredPort: number | null; runtime: RoutingRuntime }[]) {
  return owners.flatMap(owner => {
    const entries = new Map<string, { port: number; protocol: string }>();
    if (owner.requiredPort !== null) entries.set(`${owner.requiredPort}/tcp`, { port: owner.requiredPort, protocol: 'tcp' });
    for (const port of owner.runtime.ports) entries.set(`${port.hostPort}/${port.protocol}`, { port: port.hostPort, protocol: port.protocol });
    return [...entries.values()].map(entry => ({
      ...entry, ownerId: owner.id, ownerName: owner.name,
      required: entry.protocol === 'tcp' && entry.port === owner.requiredPort,
      bindings: owner.runtime.ports.filter(port => port.hostPort === entry.port && port.protocol === entry.protocol),
      state: owner.runtime.state,
    }));
  }).sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
}

export async function proxyOverview() {
  const [status, publicHost, rows] = await Promise.all([
    proxyStatus(), getPublicHost(),
    prisma.server.findMany({ orderBy: { name: 'asc' }, include: { hostnames: { orderBy: { position: 'asc' } } } }),
  ]);
  const proxyRuntime = await readRuntime(async () => {
    const info = await docker.getContainer(ROUTER_NAME).inspect();
    if (info.Config.Labels?.['mcpanel.router'] !== 'true') throw new Error('Der Proxy-Containername ist anderweitig belegt');
    return info;
  });
  const servers = await Promise.all(rows.map(async server => ({
    id: server.id, name: server.name, type: server.type,
    hostnames: server.hostnames.map(row => row.hostname),
    directConnect: server.directConnect, port: server.port,
    internalAddress: `${server.containerName}:25565`,
    runtime: await readRuntime(async () => (await findContainer(server))?.inspect() ?? null),
  })));
  const proxy = { ...status, runtime: proxyRuntime };
  return {
    proxy, publicHost, servers, network: config.dockerNetwork,
    checkedAt: new Date().toISOString(), externalReachability: 'not_checked' as const,
    ports: routerPortPlan([
      { id: 'proxy', name: 'Minecraft-Proxy', requiredPort: proxy.enabled ? proxy.port : null, runtime: proxyRuntime },
      ...servers.map(server => ({ id: server.id, name: server.name, requiredPort: server.directConnect ? server.port : null, runtime: server.runtime })),
    ]),
  };
}
