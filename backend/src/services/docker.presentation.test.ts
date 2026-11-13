import type { Server } from '@prisma/client';
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  inspect: vi.fn(), remove: vi.fn(), start: vi.fn(), stop: vi.fn(), logs: vi.fn(), create: vi.fn(), list: vi.fn(), get: vi.fn(), stats: vi.fn(),
}));
vi.mock('../config.js', () => ({
  config: { dockerNetwork: 'mc-network', mcDns: [], mcImageRepo: 'itzg/minecraft-server' },
  serverHostDir: (id: string) => `/host/servers/${id}`,
}));
// Läuft der Test selbst in einem Container (/.dockerenv), sucht die echte Funktion
// den eigenen Panel-Container – das hat mit diesen Tests nichts zu tun.
vi.mock('./dockerNetwork.js', () => ({ connectPanelToNetwork: vi.fn() }));
vi.mock('dockerode', () => ({ default: class {
  getContainer = m.get;
  listContainers = m.list;
  createContainer = m.create;
  listNetworks = async () => [{ Name: 'mc-network' }];
  getNetwork = () => ({ inspect: async () => ({ IPAM: { Config: [{ Subnet: '172.30.0.0/16', Gateway: '172.30.0.1' }] } }) });
  listImages = async () => [{}];
} }));
const { createContainer, findContainer, ensureContainer, buildEnv, containerMemoryBytes, getStats, javaTagForVersion, getState, stop, frameDecoder } = await import('./docker.js');
const server = {
  id: 'abc123', name: 'Meine Welt', containerName: 'mc-abc123', type: 'FABRIC',
  mcVersion: '1.21.1', memoryMb: 4096, port: 25565, rconPassword: 'test', extraEnv: {},
  modpackIconUrl: null,
} as Server;
const container = { inspect: m.inspect, remove: m.remove, start: m.start, stop: m.stop, logs: m.logs, stats: m.stats };
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
    HostConfig: { Memory: containerMemoryBytes(server.memoryMb), PortBindings: { '25565/tcp': [{ HostPort: '25565' }], '25565/udp': [{ HostPort: '25565' }] } },
    NetworkSettings: { Networks: { 'mc-network': { Aliases: ['mc-abc123'] } } },
  };
}

it.each(['name', 'icon', 'alias', 'memory'])('updates stale %s only when stopped and preserves current containers', async field => {
  await createContainer(server);
  const info = currentInfo();
  m.create.mockClear();
  m.inspect.mockResolvedValue(info);
  await ensureContainer(server);
  expect(m.create).not.toHaveBeenCalled();
  if (field === 'name') info.Name = '/mc-abc123';
  if (field === 'icon') info.Config.Labels['net.unraid.docker.icon'] = 'https://example.com/old.png';
  if (field === 'alias') info.NetworkSettings.Networks['mc-network'].Aliases = [];
  if (field === 'memory') info.Config.Env = info.Config.Env.filter(value => !value.startsWith('INIT_MEMORY=') && !value.startsWith('MAX_MEMORY='));
  info.State.Running = true;
  await ensureContainer(server);
  expect(m.remove).not.toHaveBeenCalled();
  info.State.Running = false;
  await ensureContainer(server);
  expect(m.remove).toHaveBeenCalledWith({ force: true, v: false });
  expect(m.create).toHaveBeenCalledOnce();
});

function envFor(overrides: Partial<Server> = {}) {
  return Object.fromEntries(buildEnv({ ...server, ...overrides }).map(entry => {
    const separator = entry.indexOf('=');
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

it('prüft Minecraft standardmäßig über IPv4, damit localhost nicht auf die unbeantwortete IPv6-Adresse zeigt', () => {
  expect(envFor().SERVER_HOST).toBe('127.0.0.1');
});

it('behält einen ausdrücklich konfigurierten Host für die Statusprüfung bei', () => {
  expect(envFor({ extraEnv: { SERVER_HOST: '::1' } }).SERVER_HOST).toBe('::1');
});

it('gives ATM10 a small initial heap without reducing its 16 GB maximum or 20 GB container limit', () => {
  const env = envFor({ type: 'MODPACK', memoryMb: 16384, extraEnv: { TYPE: 'NEOFORGE' } });
  expect(env).toMatchObject({ MEMORY: '16384M', MAX_MEMORY: '16384M', INIT_MEMORY: '2048M', USE_AIKAR_FLAGS: 'false' });
  expect(containerMemoryBytes(16384)).toBe(20 * 1024 ** 3);
});

it('keeps plugin flags and explicit administrator overrides', () => {
  expect(envFor({ type: 'PAPER' }).USE_AIKAR_FLAGS).toBe('true');
  expect(envFor({ extraEnv: { INIT_MEMORY: '6G', MAX_MEMORY: '10G', USE_AIKAR_FLAGS: 'true', JVM_OPTS: '-Dexample=a=b' } }))
    .toMatchObject({ INIT_MEMORY: '6G', MAX_MEMORY: '10G', USE_AIKAR_FLAGS: 'true', JVM_OPTS: '-Dexample=a=b' });
});

it('respects smaller heaps, custom maximums and blank overrides', () => {
  expect(envFor({ memoryMb: 512 }).INIT_MEMORY).toBe('512M');
  expect(envFor({ extraEnv: { MAX_MEMORY: '1G' } }).INIT_MEMORY).toBe('1G');
  expect(envFor({ extraEnv: { MEMORY: '512M' } })).toMatchObject({ INIT_MEMORY: '512M', MAX_MEMORY: '512M' });
  expect(envFor({ extraEnv: { INIT_MEMORY: '', MEMORY: '', MAX_MEMORY: '' } })).toMatchObject({ INIT_MEMORY: '2048M', MAX_MEMORY: '4096M' });
});

it('returns corrected Docker working-set usage through the live stats path', async () => {
  m.inspect.mockResolvedValue({ Config: { Labels: { 'mcpanel.server': server.id } } });
  m.stats.mockResolvedValue({
    cpu_stats: { cpu_usage: { total_usage: 20 }, system_cpu_usage: 200, online_cpus: 1 },
    precpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 100 },
    memory_stats: { usage: 1900, limit: 2000, stats: { inactive_file: 400 } },
  });
  expect(await getStats(server)).toEqual({ cpuPercent: 10, memoryUsed: 1500, memoryLimit: 2000 });
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

/**
 * Die Zuordnung stammt aus `javaVersion.majorVersion` im Versionsmanifest von
 * Mojang (Stand 09/2026). Zu alt gewaehlt bricht der Start sofort ab:
 * `UnsupportedClassVersionError … class file version 69.0`, so ist 26.3 auf
 * dem java21-Abbild gestorben.
 */
it('waehlt das Java-Abbild nach der Minecraft-Version', () => {
  expect(javaTagForVersion('1.12.2')).toBe('java8');
  expect(javaTagForVersion('1.16.5')).toBe('java8');
  expect(javaTagForVersion('1.17.1')).toBe('java17');
  expect(javaTagForVersion('1.20.1')).toBe('java17');
  expect(javaTagForVersion('1.20.4')).toBe('java17');
  expect(javaTagForVersion('1.20.5')).toBe('java21');
  expect(javaTagForVersion('1.21.1')).toBe('java21');
  expect(javaTagForVersion('1.21.11')).toBe('java21');
});

it('gibt der Jahreszaehlung ab 26.x das neueste Java', () => {
  expect(javaTagForVersion('26.1')).toBe('java25');
  expect(javaTagForVersion('26.3')).toBe('java25');
  expect(javaTagForVersion('27.1.2')).toBe('java25');
});

it('raet bei LATEST und Schnappschuessen lieber zu neu als zu alt', () => {
  expect(javaTagForVersion('LATEST')).toBe('java25');
  expect(javaTagForVersion('26w14a')).toBe('java25');
});

function exitedInfo(id: string, exitCode = 0) {
  return { Id: id, Config: { Labels: { 'mcpanel.server': id } }, State: {
    Running: false, Dead: false, ExitCode: exitCode,
    StartedAt: '2026-10-12T08:28:20Z', FinishedAt: '2026-10-12T08:29:15Z',
  } };
}

it('erkennt den echten Fabric-Fehlstart trotz Exitcode 0 und prüft dessen Protokoll nur einmal', async () => {
  const s = { ...server, id: 'fehler-null' };
  m.inspect.mockResolvedValue(exitedInfo(s.id));
  m.logs.mockResolvedValue(Buffer.from('Failed to start the minecraft server\nmc-server-runner Done'));
  expect((await getState(s)).state).toBe('error');
  expect((await getState(s)).state).toBe('error');
  expect(m.logs).toHaveBeenCalledOnce();
  expect(m.logs).toHaveBeenCalledWith(expect.objectContaining({ since: Date.parse('2026-10-12T08:28:20Z') / 1000 }));
});

it('meldet normale Fehlerzeilen beim sauberen Ende nicht als Absturz', async () => {
  const s = { ...server, id: 'sauber-null' };
  m.inspect.mockResolvedValue(exitedInfo(s.id));
  m.logs.mockResolvedValue(Buffer.from('ERROR: No data fixer registered\nStopping server\nmc-server-runner Done'));
  expect((await getState(s)).state).toBe('stopped');
});

it('behält einen ausdrücklich geplanten Stopp auch bei einem Startfehler als Stopp bei', async () => {
  const s = { ...server, id: 'geplant-null' };
  m.inspect.mockResolvedValue(exitedInfo(s.id));
  await stop(s);
  expect((await getState(s)).state).toBe('stopped');
  expect(m.logs).not.toHaveBeenCalled();
});

it('verwirft die Absturzzuordnung nach einem neuen Containerlauf', async () => {
  const s = { ...server, id: 'neuer-lauf' };
  const info = exitedInfo(s.id);
  m.inspect.mockResolvedValue(info);
  m.logs.mockResolvedValueOnce(Buffer.from('Minecraft has crashed!')).mockResolvedValue(Buffer.from('Stopping server'));
  expect((await getState(s)).state).toBe('error');
  info.State.StartedAt = '2026-10-12T09:00:00Z';
  info.State.FinishedAt = '2026-10-12T09:05:00Z';
  expect((await getState(s)).state).toBe('stopped');
  expect(m.logs).toHaveBeenCalledTimes(2);
});

it('setzt Docker-Logframes auch über Paketgrenzen und geteilte UTF-8-Zeichen hinweg zusammen', () => {
  const frame = (type: number, text: Buffer) => {
    const header = Buffer.alloc(8);
    header[0] = type;
    header.writeUInt32BE(text.length, 4);
    return Buffer.concat([header, text]);
  };
  const stream = Buffer.concat([frame(1, Buffer.from('Größe ok')), frame(2, Buffer.from('Fehler!'))]);
  const decode = frameDecoder();
  let out = '';
  // Byteweise füttern: trennt Header, Längenfeld und das zweibytige „ö“.
  for (const byte of stream) out += decode(Buffer.from([byte]));
  expect(out).toBe('Größe okFehler!');
  expect(frameDecoder()(frame(1, Buffer.from('abc')).subarray(0, 9))).toBe('');
});

it('veröffentlicht Zusatzports und setzt den gestoppten Container bei geänderten Ports neu auf', async () => {
  const { setExtraPorts } = await import('../lib/serverPorts.js');
  setExtraPorts(server.id, [
    { hostPort: 24455, containerPort: 24455, protocol: 'udp' },
    { hostPort: 8101, containerPort: 8100, protocol: 'tcp' },
    { hostPort: 9000, containerPort: 9000, protocol: 'tcp_udp' },
  ]);
  try {
    await createContainer(server);
    const options = m.create.mock.calls[0][0];
    expect(options.HostConfig.PortBindings).toMatchObject({
      '25565/tcp': [{ HostPort: '25565' }],
      '24455/udp': [{ HostPort: '24455' }],
      '8100/tcp': [{ HostPort: '8101' }],
      '9000/tcp': [{ HostPort: '9000' }],
      '9000/udp': [{ HostPort: '9000' }],
    });
    expect(Object.keys(options.ExposedPorts)).toEqual(expect.arrayContaining(['24455/udp', '8100/tcp', '9000/udp', '25575/tcp']));

    // Container mit genau diesen Freigaben bleibt stehen …
    const info = { ...currentInfo(), HostConfig: { ...currentInfo().HostConfig, PortBindings: options.HostConfig.PortBindings } };
    m.create.mockClear();
    m.inspect.mockResolvedValue(info);
    await ensureContainer(server);
    expect(m.create).not.toHaveBeenCalled();

    // … ein neuer Port (z. B. Geyser installiert) erzwingt beim nächsten Start den Neuaufbau.
    setExtraPorts(server.id, [{ hostPort: 19132, containerPort: 19132, protocol: 'udp' }]);
    await ensureContainer(server);
    expect(m.remove).toHaveBeenCalledWith({ force: true, v: false });
    expect(m.create.mock.calls[0][0].HostConfig.PortBindings['19132/udp']).toEqual([{ HostPort: '19132' }]);
  } finally {
    setExtraPorts(server.id, []);
  }
});

it('weicht beim Start einem auf dem Host belegten Zusatzport aus und startet erneut', async () => {
  const { setExtraPorts } = await import('../lib/serverPorts.js');
  const { onServerStart, start, busyHostPort } = await import('./docker.js');
  setExtraPorts(server.id, [{ hostPort: 8123, containerPort: 8123, protocol: 'tcp' }]);
  const portBusy = vi.fn(async () => {
    setExtraPorts(server.id, [{ hostPort: 8124, containerPort: 8123, protocol: 'tcp' }]);
    return true;
  });
  const after = vi.fn();
  onServerStart({ portBusy, after });
  try {
    await createContainer(server);
    m.inspect.mockResolvedValue({ ...currentInfo(), State: { Running: false } });
    m.list.mockResolvedValue([]);
    m.start
      .mockRejectedValueOnce(new Error('driver failed programming external connectivity on endpoint Meine-Welt: Bind for 0.0.0.0:8123 failed: port is already allocated'))
      .mockResolvedValueOnce(undefined);
    await start(server);
    expect(portBusy).toHaveBeenCalledWith(server, 8123);
    expect(m.start).toHaveBeenCalledTimes(2);
    expect(m.create.mock.calls.at(-1)![0].HostConfig.PortBindings['8123/tcp']).toEqual([{ HostPort: '8124' }]);
    expect(after).toHaveBeenCalledOnce();

    // Der Spielport selbst wird nicht verschoben – klare Meldung statt Endlosschleife.
    portBusy.mockClear();
    m.start.mockRejectedValueOnce(new Error('Bind for 0.0.0.0:25565 failed: port is already allocated'));
    await expect(start(server)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('Hostport 25565') });
    expect(portBusy).not.toHaveBeenCalled();
  } finally {
    setExtraPorts(server.id, []);
    onServerStart({});
  }
  expect(busyHostPort('listen tcp4 0.0.0.0:19132: bind: address already in use')).toBe(19132);
  expect(busyHostPort('irgendwas anderes')).toBeNull();
});

// Wer nur „Servereinstellungen“ hat, darf über Variablen weder fremde Jars
// nachladen lassen noch sich zum Operator machen.
it('schützt Variablen, über die das Abbild fremde Dateien lädt oder Operatoren setzt', async () => {
  const { isProtectedEnvKey } = await import('./docker.js');
  for (const key of ['MC_IMAGE', 'jvm_opts', 'PLUGINS', 'MODS', 'MODPACK', 'GENERIC_PACK', 'GENERIC_PACKS', 'PACKWIZ_URL',
    'PAPER_DOWNLOAD_URL', 'FORGE_INSTALLER_URL', 'FABRIC_LAUNCHER_URL', 'CF_API_KEY', 'MODRINTH_PROJECTS', 'OPS', 'WORLD', 'LD_PRELOAD', 'PATH']) {
    expect(isProtectedEnvKey(key), key).toBe(true);
  }
  for (const key of ['MOTD', 'DIFFICULTY', 'TYPE', 'VERSION', 'MAX_PLAYERS', 'VIEW_DISTANCE', 'TZ', 'ENABLE_WHITELIST', 'LEVEL', 'SEED', 'PVP']) {
    expect(isProtectedEnvKey(key), key).toBe(false);
  }
});

// Der sichtbare Name folgt dem Servernamen – ohne gemerkte Id lief jede Suche
// erst ins Leere und dann über listContainers.
it('merkt sich die Container-Id und braucht danach nur noch einen Aufruf', async () => {
  const merk = { ...server, id: 'merk-1' } as Server;
  m.list.mockResolvedValue([{ Id: 'echte-id' }]);
  await findContainer(merk);
  expect(m.list).toHaveBeenCalledTimes(1);
  m.list.mockClear();
  m.get.mockClear();
  m.inspect.mockResolvedValue({ Id: 'echte-id', Config: { Labels: { 'mcpanel.server': 'merk-1' } } });
  expect(await findContainer(merk)).toBe(container);
  expect(m.get).toHaveBeenCalledTimes(1);
  expect(m.get).toHaveBeenCalledWith('echte-id');
  expect(m.list).not.toHaveBeenCalled();
});

it('sucht neu, wenn die gemerkte Id inzwischen einem anderen gehört oder fehlt', async () => {
  const merk = { ...server, id: 'merk-2' } as Server;
  m.list.mockResolvedValue([{ Id: 'alte-id' }]);
  await findContainer(merk);
  m.inspect.mockResolvedValue({ Config: { Labels: { 'mcpanel.server': 'jemand-anders' } } });
  m.list.mockResolvedValue([]);
  expect(await findContainer(merk)).toBeNull();
});

it('liefert eine ältere Messung sofort und misst im Hintergrund neu', async () => {
  const mess = { ...server, id: 'mess-1' } as Server;
  m.list.mockResolvedValue([{ Id: 'mess-id' }]);
  m.inspect.mockResolvedValue({ Id: 'mess-id', Config: { Labels: { 'mcpanel.server': 'mess-1' } } });
  const sample = (cpu: number) => ({
    cpu_stats: { cpu_usage: { total_usage: cpu }, system_cpu_usage: 1000, online_cpus: 1 },
    precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
    memory_stats: { usage: 100, limit: 1000 },
  });
  m.stats.mockResolvedValueOnce(sample(100));
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    expect((await getStats(mess))?.cpuPercent).toBe(10);
    vi.setSystemTime(Date.now() + 9000);
    let release!: (value: unknown) => void;
    m.stats.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    // Die neue Messung hängt noch – trotzdem kommt sofort die vorige.
    expect((await getStats(mess))?.cpuPercent).toBe(10);
    release(sample(500));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect((await getStats(mess))?.cpuPercent).toBe(50);
  } finally {
    vi.useRealTimers();
  }
});
