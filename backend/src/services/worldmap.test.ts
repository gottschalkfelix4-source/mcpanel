import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ root: '' }));
vi.mock('../config.js', () => ({ serverDir: (id: string) => path.join(m.root, id), config: { jwtSecret: 'test-geheimnis' } }));
vi.mock('../db.js', () => ({ prisma: {} }));

const { headerBits, regionDirs, scanChunks } = await import('./regionScan.js');
const { parseDimension, parsePosition } = await import('./playerPositions.js');
const { acceptBlueMapDownload, modrinthLoaders, pickVersion } = await import('./mapAddons.js');
const { createMapToken, verifyMapToken, MAP_TOKEN_TTL_MS } = await import('../lib/mapToken.js');
const { upstreamPath } = await import('./bluemapProxy.js');

beforeEach(async () => { m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-karte-')); });
afterEach(async () => { await fs.rm(m.root, { recursive: true, force: true }); });

async function put(relative: string, content: string | Buffer) {
  const file = path.join(m.root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

/** Regionsdatei mit belegten Chunks an den angegebenen Indizes (x + z*32). */
function region(indices: number[]): Buffer {
  const data = Buffer.alloc(8192);
  for (const i of indices) data.writeUInt32BE((2 << 8) | 1, i * 4);
  return data;
}

describe('Regionsscan', () => {
  it('liest belegte Chunks aus dem Kopf der Regionsdatei', () => {
    const { bits, count } = headerBits(region([0, 33, 1023]));
    expect(count).toBe(3);
    expect(bits[0]).toBe(1);
    expect(bits[4] & 0b10).toBe(0b10);
    expect(bits[127]).toBe(0b1000_0000);
  });

  it('findet Regionen je Dimension und Weltname und ignoriert Fremdes', async () => {
    await put('srv/server.properties', 'level-name=meine-welt\n');
    await put('srv/meine-welt/region/r.0.0.mca', region([0, 1, 2]));
    await put('srv/meine-welt/region/r.-1.2.mca', region([5]));
    await put('srv/meine-welt/region/r.3.3.mca', Buffer.alloc(100));
    await put('srv/meine-welt/region/notizen.txt', 'x');
    await put('srv/meine-welt/DIM-1/region/r.0.0.mca', region([7]));
    const overworld = await scanChunks('srv', 'overworld');
    expect(overworld.chunks).toBe(4);
    expect(overworld.regions.map((r) => [r.x, r.z, r.count]).sort()).toEqual([[-1, 2, 1], [0, 0, 3]]);
    expect((await scanChunks('srv', 'nether')).chunks).toBe(1);
    expect((await scanChunks('srv', 'end')).regions).toEqual([]);
    expect(regionDirs('world', 'end')).toEqual(['world/DIM1/region', 'world_the_end/DIM1/region']);
  });

  it('lehnt einen Weltnamen mit Pfadanteilen ab', async () => {
    await put('srv/server.properties', 'level-name=../../etc\n');
    await expect(scanChunks('srv', 'overworld')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('Spielerpositionen', () => {
  it('liest Position und Dimension aus der Antwort von data get entity', () => {
    expect(parsePosition('Felix has the following entity data: [312.5d, 64.0d, -148.30000001d]')).toEqual({ x: 312.5, y: 64, z: -148.30000001 });
    expect(parsePosition('No entity was found')).toBeNull();
    expect(parseDimension('Felix has the following entity data: "minecraft:the_nether"')).toBe('minecraft:the_nether');
    expect(parseDimension('Felix has the following entity data: -1')).toBe('minecraft:the_nether');
    expect(parseDimension('Unknown or incomplete command')).toBeNull();
  });
});

describe('Erweiterungen', () => {
  const version = (id: string, loaders: string[], games: string[], date: string) =>
    ({ id, loaders, gameVersions: games, datePublished: date, downloadUrl: `https://cdn/${id}.jar`, versionNumber: id, filename: `chunky-${id}.jar` }) as any;

  it('wählt die neueste Datei für Loader und Version', () => {
    const versions = [
      version('alt', ['neoforge'], ['1.21.1'], '2025-01-01'),
      version('neu', ['neoforge'], ['1.21.1'], '2026-05-01'),
      version('fabric', ['fabric'], ['1.21.1'], '2026-06-01'),
      version('andere', ['neoforge'], ['1.20.4'], '2026-07-01'),
    ];
    expect(pickVersion(versions, ['neoforge'], '1.21.1')?.id).toBe('neu');
    expect(pickVersion(versions, ['forge'], '1.21.1')).toBeNull();
    expect(pickVersion(versions, ['neoforge'], 'LATEST')?.id).toBe('andere');
  });

  it('leitet die Modrinth-Loader aus dem Servertyp ab', () => {
    expect(modrinthLoaders({ type: 'NEOFORGE', extraEnv: {} } as any)).toEqual(['neoforge']);
    expect(modrinthLoaders({ type: 'MODPACK', extraEnv: { TYPE: 'FABRIC' } } as any)).toEqual(['fabric']);
    expect(modrinthLoaders({ type: 'QUILT', extraEnv: {} } as any)).toEqual(['quilt', 'fabric']);
    expect(modrinthLoaders({ type: 'PAPER', extraEnv: {} } as any)).toContain('paper');
    expect(modrinthLoaders({ type: 'VANILLA', extraEnv: {} } as any)).toBeNull();
  });

  it('schaltet BlueMaps Download frei, ändert aber nur diese Zeile', async () => {
    expect(await acceptBlueMapDownload({ id: 'srv' })).toBe('missing');
    await put('srv/config/bluemap/core.conf', '# BlueMap\naccept-download: false\nrender-thread-count: 1\n');
    expect(await acceptBlueMapDownload({ id: 'srv' })).toBe('changed');
    expect(await fs.readFile(path.join(m.root, 'srv/config/bluemap/core.conf'), 'utf8')).toBe('# BlueMap\naccept-download: true\nrender-thread-count: 1\n');
    expect(await acceptBlueMapDownload({ id: 'srv' })).toBe('already');
  });
});

describe('Kartentoken und Proxy-Pfade', () => {
  it('gilt nur unverändert und bis zum Ablauf', () => {
    const token = createMapToken('srv', 'u1', 3, 1000);
    expect(verifyMapToken(token, 2000)).toEqual({ serverId: 'srv', userId: 'u1', sessionVersion: 3 });
    expect(verifyMapToken(token, 1000 + MAP_TOKEN_TTL_MS + 1)).toBeNull();
    const [body, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ s: 'fremd', u: 'u1', e: 9e15, v: 3 })).toString('base64url');
    expect(verifyMapToken(`${forged}.${signature}`, 2000)).toBeNull();
    expect(verifyMapToken(`${body}.${signature}x`, 2000)).toBeNull();
    expect(verifyMapToken('kaputt', 2000)).toBeNull();
  });

  it('reicht nur Pfade unterhalb des Webroots durch', () => {
    expect(upstreamPath('/api/map-view/TOK/maps/world/settings.json?123', 'TOK')).toBe('/maps/world/settings.json?123');
    expect(upstreamPath('/api/map-view/TOK/', 'TOK')).toBe('/');
    expect(upstreamPath('/api/map-view/TOK/../../etc/passwd', 'TOK')).toBeNull();
    expect(upstreamPath('/api/map-view/TOK/%2e%2e/geheim', 'TOK')).toBeNull();
    expect(upstreamPath('/api/map-view/ANDERS/x', 'TOK')).toBeNull();
  });
});
