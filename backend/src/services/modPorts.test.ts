import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectModPorts, MOD_PORTS, writeModPort } from './modPorts.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-modports-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function put(relative: string, content = '') {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), content);
}

describe('detectModPorts', () => {
  it('erkennt Simple Voice Chat ohne Konfiguration mit dem Standardport', async () => {
    await put('mods/voicechat-fabric-1.21.1-2.5.26.jar');
    const [found] = await detectModPorts(root);
    expect(found).toMatchObject({ containerPort: 24454, configPath: null });
    expect(found.spec.key).toBe('voicechat');
  });

  it('liest den Port aus der Konfiguration und überspringt „Spielport mitbenutzen“', async () => {
    await put('mods/voicechat-neoforge-2.5.jar');
    await put('config/voicechat/voicechat-server.properties', '# Simple Voice Chat\nport=25000\nmax_voice_distance=48\n');
    expect((await detectModPorts(root))[0]).toMatchObject({ containerPort: 25000, configPath: 'config/voicechat/voicechat-server.properties' });

    await put('config/voicechat/voicechat-server.properties', 'port=-1\n');
    expect(await detectModPorts(root)).toEqual([]);
  });

  it('erkennt Plugins und ignoriert deaktivierte Jars', async () => {
    await put('plugins/voicechat-bukkit-2.5.26.jar');
    await put('plugins/BlueMap-5.4-spigot.jar.disabled');
    expect((await detectModPorts(root)).map((f) => f.spec.key)).toEqual(['voicechat']);
  });

  it('liest den Bedrock-Port aus Geysers YAML-Block statt aus anderen Blöcken', async () => {
    await put('plugins/Geyser-Spigot.jar');
    await put('plugins/Geyser-Spigot/config.yml', 'remote:\n  port: 25565\nbedrock:\n  address: 0.0.0.0\n  port: 19200\n  clone-remote-port: false\n');
    expect((await detectModPorts(root))[0]).toMatchObject({ containerPort: 19200, configPath: 'plugins/Geyser-Spigot/config.yml' });
  });

  it('liest BlueMap, Dynmap und Votifier', async () => {
    await put('mods/bluemap-5.4-fabric.jar');
    await put('config/bluemap/webserver.conf', 'enabled: true\nport: 8200\n');
    await put('plugins/Dynmap-3.7-spigot.jar');
    await put('plugins/dynmap/configuration.txt', 'deftemplatesuffix: hires\nwebserver-port: 8124\n');
    await put('plugins/nuvotifier-2.7.2.jar');
    const found = Object.fromEntries((await detectModPorts(root)).map((f) => [f.spec.key, f.containerPort]));
    expect(found).toEqual({ bluemap: 8200, dynmap: 8124, votifier: 8192 });
  });

  it('greift bei kaputten Werten auf den Standard zurück', async () => {
    await put('mods/voicechat-fabric.jar');
    await put('config/voicechat/voicechat-server.properties', 'port=99999\n');
    expect((await detectModPorts(root))[0].containerPort).toBe(24454);
  });

  it('folgt keinen symbolischen Links aus dem Serverordner heraus', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-outside-'));
    try {
      await put('mods/voicechat-fabric.jar');
      await fs.writeFile(path.join(outside, 'secret.properties'), 'port=31337\n');
      await fs.mkdir(path.join(root, 'config'), { recursive: true });
      await fs.symlink(outside, path.join(root, 'config', 'voicechat'));
      expect((await detectModPorts(root))[0].containerPort).toBe(24454);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('writeModPort', () => {
  const voicechat = MOD_PORTS.find((spec) => spec.key === 'voicechat')!;

  it('legt eine fehlende Konfiguration passend zum Servertyp an', async () => {
    await put('mods/voicechat-fabric.jar');
    const file = await writeModPort(root, { spec: voicechat, containerPort: 24454, configPath: null }, 24455);
    expect(file).toBe('config/voicechat/voicechat-server.properties');
    expect(await fs.readFile(path.join(root, file), 'utf8')).toBe('port=24455\n');

    await fs.rm(path.join(root, 'mods'), { recursive: true });
    await fs.rm(path.join(root, 'config'), { recursive: true });
    await put('plugins/voicechat-bukkit.jar');
    expect(await writeModPort(root, { spec: voicechat, containerPort: 24454, configPath: null }, 24456))
      .toBe('plugins/voicechat/voicechat-server.properties');
  });

  it('ersetzt nur die Portzeile und lässt den Rest stehen', async () => {
    await put('config/voicechat/voicechat-server.properties', '# Kommentar\nport=24454\nbind_address=\n');
    await writeModPort(root, { spec: voicechat, containerPort: 24454, configPath: 'config/voicechat/voicechat-server.properties' }, 24460);
    expect(await fs.readFile(path.join(root, 'config/voicechat/voicechat-server.properties'), 'utf8'))
      .toBe('# Kommentar\nport=24460\nbind_address=\n');
    expect((await fs.readdir(path.join(root, 'config/voicechat'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
