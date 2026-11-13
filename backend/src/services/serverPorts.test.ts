import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = { id: string; serverId: string; source: string; label: string; protocol: string; hostPort: number; containerPort: number; forward: boolean };

const m = vi.hoisted(() => ({
  root: '',
  rows: [] as Row[],
  servers: [] as { id: string; port: number }[],
  proxy: { enabled: false, port: 25565 },
  seq: 0,
  settings: new Map<string, string>(),
}));

vi.mock('../config.js', () => ({ serverDir: (id: string) => `${m.root}/${id}` }));
vi.mock('./proxy.js', () => ({ getProxyConfig: async () => m.proxy }));
vi.mock('./settings.js', () => ({
  getSetting: async (key: string, fallback = '') => m.settings.get(key) ?? fallback,
  setSetting: async (key: string, value: string) => { m.settings.set(key, value); },
}));
vi.mock('../db.js', () => {
  const match = (row: Row, where: any = {}) => Object.entries(where).every(([key, value]: [string, any]) => {
    if (value && typeof value === 'object' && 'not' in value) return (row as any)[key] !== value.not;
    if (value && typeof value === 'object' && 'in' in value) return value.in.includes((row as any)[key]);
    return (row as any)[key] === value;
  });
  return {
    prisma: {
      server: { findMany: async () => m.servers },
      serverPort: {
        findMany: async ({ where }: any = {}) => m.rows.filter((row) => match(row, where)).sort((a, b) => a.hostPort - b.hostPort),
        findFirst: async ({ where }: any) => m.rows.find((row) => match(row, where)) ?? null,
        count: async ({ where }: any) => m.rows.filter((row) => match(row, where)).length,
        create: async ({ data }: any) => {
          if (m.rows.some((row) => row.hostPort === data.hostPort)) throw Object.assign(new Error('unique'), { code: 'P2002' });
          const row = { id: `p${++m.seq}`, forward: true, ...data };
          m.rows.push(row);
          return row;
        },
        update: async ({ where, data }: any) => Object.assign(m.rows.find((row) => row.id === where.id)!, data),
        delete: async ({ where }: any) => { m.rows = m.rows.filter((row) => row.id !== where.id); },
        deleteMany: async ({ where }: any) => { m.rows = m.rows.filter((row) => !match(row, where)); },
      },
    },
  };
});

const { addManualPort, nextFreePort, reassignBusyPort, removeManualPort, syncServerPorts } = await import('./serverPorts.js');
const { extraPortsOf } = await import('../lib/serverPorts.js');
const { setServerNode } = await import('../lib/serverLocation.js');

const server = (id: string) => ({ id, name: id, port: 25565 }) as Server;

async function put(serverId: string, relative: string, content = '') {
  const file = path.join(m.root, serverId, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

beforeEach(async () => {
  m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-serverports-'));
  m.rows = [];
  m.servers = [{ id: 'a', port: 25565 }, { id: 'b', port: 25566 }];
  m.proxy = { enabled: false, port: 25565 };
  m.settings.clear();
});
afterEach(async () => { await fs.rm(m.root, { recursive: true, force: true }); });

describe('syncServerPorts', () => {
  it('vergibt den Standardport und trägt ihn in die Registry für Docker ein', async () => {
    await put('a', 'mods/voicechat-fabric.jar');
    const result = await syncServerPorts(server('a'));
    expect(result.changed).toBe(true);
    expect(result.ports).toMatchObject([{ source: 'voicechat', hostPort: 24454, containerPort: 24454, protocol: 'udp' }]);
    expect(extraPortsOf('a')).toEqual([{ hostPort: 24454, containerPort: 24454, protocol: 'udp' }]);
    expect((await syncServerPorts(server('a'))).changed).toBe(false);
  });

  it('gibt dem zweiten Sprachchat einen freien Port und schreibt ihn in dessen Konfiguration', async () => {
    await put('a', 'mods/voicechat-fabric.jar');
    await put('b', 'mods/voicechat-fabric.jar');
    await put('b', 'config/voicechat/voicechat-server.properties', 'port=24454\nmax_voice_distance=48\n');
    await syncServerPorts(server('a'));
    const result = await syncServerPorts(server('b'));
    expect(result.ports).toMatchObject([{ hostPort: 24455, containerPort: 24455 }]);
    expect(await fs.readFile(path.join(m.root, 'b/config/voicechat/voicechat-server.properties'), 'utf8'))
      .toBe('port=24455\nmax_voice_distance=48\n');
    expect(result.notes.join(' ')).toContain('24455');
  });

  it('legt bei Web-Karten nur einen anderen Hostport auf den unveränderten Containerport', async () => {
    await put('a', 'mods/dynmap-fabric.jar');
    await put('b', 'mods/dynmap-fabric.jar');
    await put('b', 'dynmap/configuration.txt', 'webserver-port: 8123\n');
    await syncServerPorts(server('a'));
    expect((await syncServerPorts(server('b'))).ports).toMatchObject([{ hostPort: 8124, containerPort: 8123 }]);
    expect(await fs.readFile(path.join(m.root, 'b/dynmap/configuration.txt'), 'utf8')).toBe('webserver-port: 8123\n');
  });

  it('veröffentlicht BlueMap auf dem Hauptserver nicht und auf Nodes nur ohne Router-Freigabe', async () => {
    await put('a', 'mods/bluemap-fabric.jar');
    expect((await syncServerPorts(server('a'))).ports).toEqual([]);

    // Ein früher veröffentlichter BlueMap-Port wird wieder geschlossen.
    m.rows.push({ id: 'alt', serverId: 'a', source: 'bluemap', label: 'BlueMap', protocol: 'tcp', hostPort: 8100, containerPort: 8100, forward: true });
    const closed = await syncServerPorts(server('a'));
    expect(closed.ports).toEqual([]);
    expect(closed.notes.join(' ')).toContain('nur noch über das Panel');

    setServerNode('b', 'keller');
    try {
      await put('b', 'mods/bluemap-fabric.jar');
      expect((await syncServerPorts(server('b'))).ports).toMatchObject([{ source: 'bluemap', hostPort: 8100, forward: false }]);
    } finally {
      setServerNode('b', null);
    }
  });

  it('meidet Spielports, Proxyport und reservierte Ports', async () => {
    m.servers.push({ id: 'c', port: 24454 });
    m.proxy = { enabled: true, port: 24455 };
    await put('a', 'mods/voicechat-fabric.jar');
    expect((await syncServerPorts(server('a'))).ports[0].hostPort).toBe(24456);
    await put('b', 'plugins/squaremap-paper.jar');
    expect((await syncServerPorts(server('b'))).ports[0]).toMatchObject({ hostPort: 8081, containerPort: 8080 });
  });

  it('übernimmt einen von Hand geänderten, freien Sprachchat-Port', async () => {
    await put('a', 'mods/voicechat-fabric.jar');
    await syncServerPorts(server('a'));
    await put('a', 'config/voicechat/voicechat-server.properties', 'port=30000\n');
    expect((await syncServerPorts(server('a'))).ports).toMatchObject([{ hostPort: 30000, containerPort: 30000 }]);
  });

  it('gibt Ports entfernter Erweiterungen frei, manuelle bleiben', async () => {
    await put('a', 'mods/voicechat-fabric.jar');
    await syncServerPorts(server('a'));
    await addManualPort(server('a'), { label: 'Eigene Mod', protocol: 'tcp', hostPort: 9000 });
    await fs.rm(path.join(m.root, 'a/mods/voicechat-fabric.jar'));
    const result = await syncServerPorts(server('a'));
    expect(result.ports.map((p) => p.hostPort)).toEqual([9000]);
    expect(result.notes.join(' ')).toContain('nicht mehr installiert');
    expect(extraPortsOf('a').map((p) => p.hostPort)).toEqual([9000]);
  });
});

describe('Router-Freigabe erkannter Ports', () => {
  it('bleibt aus, bis ein Administrator sie einschaltet – auch bei geändertem Port', async () => {
    await put('a', 'mods/voicechat-fabric.jar');
    const [created] = (await syncServerPorts(server('a'))).ports;
    expect(created.forward).toBe(false);
    // Admin schaltet ein, danach trägt jemand einen anderen Port in die Datei ein.
    m.rows[0].forward = true;
    await put('a', 'config/voicechat/voicechat-server.properties', 'port=31000\n');
    expect((await syncServerPorts(server('a'))).ports[0]).toMatchObject({ hostPort: 31000, forward: false });
  });

  it('wird nur mit der pauschalen Erlaubnis sofort gesetzt', async () => {
    m.settings.set('unifi.config', JSON.stringify({ autoForwardDetected: true }));
    const { saveUnifiConfig, getUnifiConfig } = await import('./unifi.js');
    await saveUnifiConfig({ ...(await getUnifiConfig()), autoForwardDetected: true });
    try {
      await put('a', 'mods/voicechat-fabric.jar');
      expect((await syncServerPorts(server('a'))).ports[0].forward).toBe(true);
    } finally {
      await saveUnifiConfig({ ...(await getUnifiConfig()), autoForwardDetected: false });
    }
  });

  it('nimmt keine Ports unter 1024 aus der Konfiguration', async () => {
    await put('a', 'mods/voicechat-fabric.jar');
    await put('a', 'config/voicechat/voicechat-server.properties', 'port=445\n');
    const [port] = (await syncServerPorts(server('a'))).ports;
    expect(port.hostPort).toBeGreaterThanOrEqual(1024);
    expect(await fs.readFile(path.join(m.root, 'a/config/voicechat/voicechat-server.properties'), 'utf8')).toBe(`port=${port.hostPort}\n`);
  });
});

describe('manuelle Ports', () => {
  it('lehnt belegte und reservierte Ports ab', async () => {
    await expect(addManualPort(server('a'), { label: 'x', protocol: 'tcp', hostPort: 25566 })).rejects.toMatchObject({ statusCode: 409 });
    await expect(addManualPort(server('a'), { label: 'x', protocol: 'tcp', hostPort: 8080 })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('lässt erkannte Ports nicht von Hand löschen', async () => {
    await put('a', 'mods/voicechat-fabric.jar');
    const [port] = (await syncServerPorts(server('a'))).ports;
    await expect(removeManualPort('a', port.id)).rejects.toMatchObject({ statusCode: 400 });
    await expect(removeManualPort('b', port.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});

it('nextFreePort sucht aufwärts und fängt notfalls unten wieder an', () => {
  expect(nextFreePort(100, new Set([100, 101]))).toBe(102);
  expect(nextFreePort(65535, new Set([65535]))).toBe(1024);
});

describe('reassignBusyPort', () => {
  it('weicht einem fremd belegten Port aus und meidet ihn dauerhaft', async () => {
    await put('a', 'mods/dynmap-fabric.jar');
    await syncServerPorts(server('a'));
    expect(await reassignBusyPort(server('a'), 8123)).toBe(true);
    expect(extraPortsOf('a')).toEqual([{ hostPort: 8124, containerPort: 8123, protocol: 'tcp' }]);
    // Ein anderer Server mit Dynmap bekommt 8123 ebenfalls nicht.
    await put('b', 'mods/dynmap-fabric.jar');
    expect((await syncServerPorts(server('b'))).ports[0].hostPort).toBe(8125);
  });

  it('schreibt beim Sprachchat den neuen Port in die Konfiguration', async () => {
    await put('a', 'mods/voicechat-fabric.jar');
    await syncServerPorts(server('a'));
    expect(await reassignBusyPort(server('a'), 24454)).toBe(true);
    expect(extraPortsOf('a')).toEqual([{ hostPort: 24455, containerPort: 24455, protocol: 'udp' }]);
    expect(await fs.readFile(path.join(m.root, 'a/config/voicechat/voicechat-server.properties'), 'utf8')).toBe('port=24455\n');
    // Beim nächsten Start bleibt es dabei.
    expect((await syncServerPorts(server('a'))).changed).toBe(false);
  });

  it('lässt fremde Ports in Ruhe', async () => {
    expect(await reassignBusyPort(server('a'), 25565)).toBe(false);
  });
});

describe('Spiel- und RCON-Port als Zusatzport', () => {
  it('veröffentlicht RCON nicht, wenn ein Plugin 25575 als seinen Port angibt', async () => {
    await put('a', 'plugins/votifier.jar');
    await put('a', 'plugins/Votifier/config.yml', 'port: 25575\n');
    const { ports } = await syncServerPorts(server('a'));
    expect(ports.some((port) => port.containerPort === 25575 || port.hostPort === 25575)).toBe(false);
  });

  it('trägt dem Sprachchat einen anderen Port ein, statt 25575 zu übernehmen', async () => {
    await put('a', 'mods/voicechat-fabric.jar');
    await put('a', 'config/voicechat/voicechat-server.properties', 'port=25575\n');
    const [port] = (await syncServerPorts(server('a'))).ports;
    expect([25565, 25575]).not.toContain(port.hostPort);
    expect(port.containerPort).toBe(port.hostPort);
    expect(await fs.readFile(path.join(m.root, 'a/config/voicechat/voicechat-server.properties'), 'utf8')).toBe(`port=${port.hostPort}\n`);
  });
});
