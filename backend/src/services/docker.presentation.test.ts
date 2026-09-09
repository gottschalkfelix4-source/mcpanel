import type { Server } from '@prisma/client';
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  inspect: vi.fn(), remove: vi.fn(), start: vi.fn(), create: vi.fn(), list: vi.fn(), get: vi.fn(),
}));
vi.mock('../config.js', () => ({
  config: { dockerNetwork: 'mc-network', mcDns: [], mcImageRepo: 'itzg/minecraft-server' },
  serverHostDir: (id: string) => `/host/servers/${id}`,
}));
vi.mock('dockerode', () => ({ default: class {
  getContainer = m.get;
  listContainers = m.list;
  createContainer = m.create;
  listNetworks = async () => [{ Name: 'mc-network' }];
  listImages = async () => [{}];
} }));
const { createContainer, findContainer, ensureContainer, buildEnv, containerMemoryBytes } = await import('./docker.js');
const server = {
  id: 'abc123', name: 'Meine Welt', containerName: 'mc-abc123', type: 'FABRIC',
  mcVersion: '1.21.1', memoryMb: 4096, port: 25565, rconPassword: 'test', extraEnv: {},
  modpackIconUrl: null,
} as Server;
const container = { inspect: m.inspect, remove: m.remove, start: m.start };
beforeEach(() => {
  vi.resetAllMocks();
  m.get.mockReturnValue(container);
  m.inspect.mockRejectedValue({ statusCode: 404 });
  m.list.mockResolvedValue([]);
  m.create.mockResolvedValue(container);
});

it('creates a readable name and Unraid icon while retaining the stable DNS alias and data mount', async () => {
  await createContainer(server);
  expect(m.create).toHaveBeenCalledWith(expect.objectContaining({
    name: 'Meine-Welt',
    Labels: expect.objectContaining({ 'mcpanel.server': 'abc123', 'mcpanel.name': 'Meine Welt', 'net.unraid.docker.icon': 'https://fabricmc.net/assets/logo.png' }),
    NetworkingConfig: { EndpointsConfig: { 'mc-network': { Aliases: ['mc-abc123'] } } },
    HostConfig: expect.objectContaining({ Binds: ['/host/servers/abc123:/data'] }),
  }));
});

it('resolves name collisions without touching the existing occupant', async () => {
  m.create.mockRejectedValueOnce({ statusCode: 409 });
  await createContainer(server);
  expect(m.create.mock.calls.map(([options]) => options.name)).toEqual(['Meine-Welt', 'Meine-Welt-abc123']);
  expect(m.remove).not.toHaveBeenCalled();
});

it('does not retry an unrelated Docker failure', async () => {
  m.create.mockRejectedValue({ statusCode: 500 });
  await expect(createContainer(server)).rejects.toMatchObject({ statusCode: 500 });
  expect(m.create).toHaveBeenCalledOnce();
});

it('finds renamed containers by ownership and never adopts an unrelated container', async () => {
  m.inspect.mockResolvedValue({ Config: { Labels: { 'mcpanel.server': 'someone-else' } } });
  expect(await findContainer(server)).toBeNull();
  m.list.mockResolvedValue([{ Id: 'docker-id' }]);
  expect(await findContainer(server)).toBe(container);
  expect(m.list).toHaveBeenCalledWith({ all: true, filters: { label: ['mcpanel.server=abc123'] } });
  expect(m.get).toHaveBeenLastCalledWith('docker-id');
});

it('preserves legacy lookup and propagates outages', async () => {
  m.inspect.mockResolvedValueOnce({ Config: { Labels: { 'mcpanel.server': 'abc123' } } });
  expect(await findContainer(server)).toBe(container);
  expect(m.list).not.toHaveBeenCalled();
  m.inspect.mockRejectedValue({ statusCode: 503 });
  await expect(findContainer(server)).rejects.toMatchObject({ statusCode: 503 });
});

function currentInfo() {
  return {
    Name: '/Meine-Welt', State: { Running: false },
    Config: { Image: 'itzg/minecraft-server:java21', Env: buildEnv(server), Labels: m.create.mock.calls[0][0].Labels },
    HostConfig: { Memory: containerMemoryBytes(server.memoryMb), PortBindings: { '25565/tcp': [{ HostPort: '25565' }] } },
    NetworkSettings: { Networks: { 'mc-network': { Aliases: ['mc-abc123'] } } },
  };
}

it.each(['name', 'icon', 'alias'])('updates stale %s only when stopped and preserves current containers', async field => {
  await createContainer(server);
  const info = currentInfo();
  m.create.mockClear();
  m.inspect.mockResolvedValue(info);
  await ensureContainer(server);
  expect(m.create).not.toHaveBeenCalled();
  if (field === 'name') info.Name = '/mc-abc123';
  if (field === 'icon') info.Config.Labels['net.unraid.docker.icon'] = 'https://example.com/old.png';
  if (field === 'alias') info.NetworkSettings.Networks['mc-network'].Aliases = [];
  info.State.Running = true;
  await ensureContainer(server);
  expect(m.remove).not.toHaveBeenCalled();
  info.State.Running = false;
  await ensureContainer(server);
  expect(m.remove).toHaveBeenCalledWith({ force: true, v: false });
  expect(m.create).toHaveBeenCalledOnce();
});

it('does not repeatedly recreate a container using the collision suffix', async () => {
  await createContainer(server);
  const info = currentInfo();
  info.Name = '/Meine-Welt-abc123';
  m.create.mockClear();
  m.inspect.mockResolvedValue(info);
  await ensureContainer(server);
  expect(m.remove).not.toHaveBeenCalled();
});
