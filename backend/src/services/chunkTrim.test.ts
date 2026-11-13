import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ root: '' }));
vi.mock('../config.js', () => ({ serverDir: (id: string) => path.join(m.root, id) }));

const { chunkInArea, trimChunks } = await import('./chunkTrim.js');

const SECTOR = 4096;
const server = { id: 'srv' };
const dir = () => path.join(m.root, 'srv');

beforeEach(async () => {
  m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-trim-'));
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(path.join(dir(), 'server.properties'), 'level-name=world\n');
});
afterEach(() => fs.rm(m.root, { recursive: true, force: true }));

/** Inhalt eines Chunks – eindeutig je Position, damit Verwechslungen auffallen. */
function chunkData(chunkX: number, chunkZ: number, sectors: number): Buffer {
  const data = Buffer.alloc(sectors * SECTOR);
  crypto.createHash('sha256').update(`${chunkX}/${chunkZ}`).digest().copy(data, 5);
  data.writeUInt32BE(sectors * SECTOR - 4, 0);
  data[4] = 2; // zlib
  data.write(`chunk ${chunkX} ${chunkZ}`, 40);
  return data;
}

/**
 * Regionsdatei wie Minecraft sie schreibt. `chunks` sind lokale Indizes
 * (x + z * 32); Sektoren absichtlich mit Lücken und in fremder Reihenfolge.
 */
async function region(relative: string, regionX: number, regionZ: number, chunks: number[], sectors = (i: number) => 1 + (i % 3)) {
  const header = Buffer.alloc(2 * SECTOR);
  const parts: Buffer[] = [];
  let next = 3; // ein freier Sektor als Lücke
  for (const index of [...chunks].reverse()) {
    const count = sectors(index);
    const cx = regionX * 32 + (index & 31);
    const cz = regionZ * 32 + (index >> 5);
    header.writeUInt32BE(((next << 8) | count) >>> 0, index * 4);
    header.writeUInt32BE(1_700_000_000 + index, SECTOR + index * 4);
    parts.push(Buffer.alloc(SECTOR * (next - 2 - parts.reduce((s, p) => s + p.length, 0) / SECTOR)));
    parts.push(chunkData(cx, cz, count));
    next += count;
  }
  const file = path.join(dir(), relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.concat([header, ...parts]));
}

/** Chunks einer Regionsdatei samt Inhalt und Zeitstempel. */
async function lies(relative: string): Promise<Map<number, { data: Buffer; time: number; offset: number }>> {
  const buf = await fs.readFile(path.join(dir(), relative));
  const result = new Map<number, { data: Buffer; time: number; offset: number }>();
  for (let i = 0; i < 1024; i++) {
    const loc = buf.readUInt32BE(i * 4);
    if (loc === 0) continue;
    const offset = loc >>> 8;
    const count = loc & 0xff;
    result.set(i, { data: buf.subarray(offset * SECTOR, (offset + count) * SECTOR), time: buf.readUInt32BE(SECTOR + i * 4), offset });
  }
  return result;
}

const exists = (relative: string) => fs.lstat(path.join(dir(), relative)).then(() => true, () => false);

describe('chunkInArea', () => {
  it('nimmt die Chunkmitte als Maßstab', () => {
    const circle = { shape: 'circle' as const, centerX: 0, centerZ: 0, radius: 100 };
    expect(chunkInArea(circle, 0, 0)).toBe(true); // Mitte bei 8/8
    expect(chunkInArea(circle, 5, 0)).toBe(true); // 88
    expect(chunkInArea(circle, 6, 0)).toBe(false); // 104
    expect(chunkInArea(circle, -7, 0)).toBe(false); // -104
    expect(chunkInArea({ ...circle, shape: 'square' }, 4, 4)).toBe(true); // Ecke 72/72
    expect(chunkInArea(circle, 4, 4)).toBe(false); // 72² + 72² = 10 368 > 100²
  });
});

describe('trimChunks', () => {
  // Region 0/0 deckt die Chunks 0–31 je Achse ab; vom Quadrat ±40 Blöcke um
  // 0/0 bleiben darin nur die Chunks 0–2 (Mitten 8, 24, 40).
  const input = { dimension: 'overworld' as const, shape: 'square' as const, centerX: 0, centerZ: 0, radius: 40, mode: 'outside' as const };

  it('schätzt, ohne etwas zu ändern', async () => {
    await region('world/region/r.0.0.mca', 0, 0, [0, 1, 2, 3, 33, 100, 1023]);
    const vorher = await fs.readFile(path.join(dir(), 'world/region/r.0.0.mca'));
    const plan = await trimChunks(server, input, { apply: false });
    expect(plan).toMatchObject({ chunks: 7, removed: 3, filesDeleted: 0, filesRewritten: 1, skipped: [] });
    expect(plan.bytes).toBeGreaterThan(0);
    expect((await fs.readFile(path.join(dir(), 'world/region/r.0.0.mca'))).equals(vorher)).toBe(true);
  });

  it('behält nur den Bereich: Inhalt und Zeitstempel bleiben, die Datei wird lückenlos', async () => {
    // Behalten: 0 (0/0), 1 (1/0), 2 (2/0), 33 (1/1). Weg: 3 (3/0), 100 (4/3), 1023 (31/31).
    await region('world/region/r.0.0.mca', 0, 0, [0, 1, 2, 3, 33, 100, 1023]);
    const vorher = await lies('world/region/r.0.0.mca');
    const groesseVorher = (await fs.stat(path.join(dir(), 'world/region/r.0.0.mca'))).size;

    const result = await trimChunks(server, input, { apply: true });

    expect(result).toMatchObject({ chunks: 7, removed: 3, filesDeleted: 0, filesRewritten: 1, skipped: [] });
    const nachher = await lies('world/region/r.0.0.mca');
    expect([...nachher.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 33]);
    for (const index of [0, 1, 2, 33]) {
      expect(nachher.get(index)!.data.equals(vorher.get(index)!.data)).toBe(true);
      expect(nachher.get(index)!.time).toBe(vorher.get(index)!.time);
    }
    const groesse = (await fs.stat(path.join(dir(), 'world/region/r.0.0.mca'))).size;
    expect(groesse).toBeLessThan(groesseVorher);
    expect(groesse % SECTOR).toBe(0);
    // Keine Lücken: die Chunks folgen direkt auf die Tabelle.
    const belegt = [...nachher.values()].reduce((sum, chunk) => sum + chunk.data.length, 0);
    expect(groesse).toBe(2 * SECTOR + belegt);
    expect(Math.min(...[...nachher.values()].map((chunk) => chunk.offset))).toBe(2);
  });

  it('löscht Regionsdateien ganz außerhalb – samt Entities, POI und ausgelagerten Chunks', async () => {
    await region('world/region/r.0.0.mca', 0, 0, [0]);
    await region('world/region/r.5.5.mca', 5, 5, [0, 1, 2]);
    await region('world/entities/r.5.5.mca', 5, 5, [0, 2]);
    await region('world/poi/r.5.5.mca', 5, 5, [1]);
    await fs.writeFile(path.join(dir(), 'world/region/c.160.160.mcc'), 'groß');
    await fs.writeFile(path.join(dir(), 'world/region/c.1.1.mcc'), 'bleibt');

    const result = await trimChunks(server, input, { apply: true });

    expect(result).toMatchObject({ chunks: 4, removed: 3, filesDeleted: 1, filesRewritten: 0 });
    expect(await exists('world/region/r.5.5.mca')).toBe(false);
    expect(await exists('world/entities/r.5.5.mca')).toBe(false);
    expect(await exists('world/poi/r.5.5.mca')).toBe(false);
    expect(await exists('world/region/c.160.160.mcc')).toBe(false);
    expect(await exists('world/region/c.1.1.mcc')).toBe(true);
    expect(await exists('world/region/r.0.0.mca')).toBe(true);
  });

  it('kürzt Entities im selben Zug wie die Regionen', async () => {
    await region('world/region/r.0.0.mca', 0, 0, [0, 3]);
    await region('world/entities/r.0.0.mca', 0, 0, [0, 3]);
    await trimChunks(server, input, { apply: true });
    expect([...(await lies('world/entities/r.0.0.mca')).keys()]).toEqual([0]);
  });

  it('setzt im Modus „innerhalb“ genau den Bereich zurück', async () => {
    await region('world/region/r.0.0.mca', 0, 0, [0, 1, 3, 100]);
    await trimChunks(server, { ...input, mode: 'inside' }, { apply: true });
    expect([...(await lies('world/region/r.0.0.mca')).keys()].sort((a, b) => a - b)).toEqual([3, 100]);
  });

  it('arbeitet nur in der gewählten Dimension', async () => {
    await region('world/region/r.5.5.mca', 5, 5, [0]);
    await region('world/DIM-1/region/r.5.5.mca', 5, 5, [0]);
    await trimChunks(server, { ...input, dimension: 'nether' }, { apply: true });
    expect(await exists('world/region/r.5.5.mca')).toBe(true);
    expect(await exists('world/DIM-1/region/r.5.5.mca')).toBe(false);
  });

  it('lässt eine beschädigte Datei unverändert und meldet sie', async () => {
    await region('world/region/r.0.0.mca', 0, 0, [0, 3]);
    const file = path.join(dir(), 'world/region/r.0.0.mca');
    const buf = await fs.readFile(file);
    buf.writeUInt32BE(((9999 << 8) | 1) >>> 0, 3 * 4); // zeigt hinter das Dateiende
    await fs.writeFile(file, buf);

    const result = await trimChunks(server, input, { apply: true });

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatch(/r\.0\.0\.mca/);
    expect((await fs.readFile(file)).equals(buf)).toBe(true);
    expect((await fs.readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('lässt Dateien ohne betroffene Chunks unangetastet', async () => {
    await region('world/region/r.0.0.mca', 0, 0, [0, 1]);
    const file = path.join(dir(), 'world/region/r.0.0.mca');
    const vorher = await fs.stat(file);
    const result = await trimChunks(server, input, { apply: true });
    expect(result).toMatchObject({ removed: 0, filesRewritten: 0, filesDeleted: 0 });
    expect((await fs.stat(file)).mtimeMs).toBe(vorher.mtimeMs);
  });

  it('folgt keinem verlinkten Weltordner', async () => {
    const fremd = path.join(m.root, 'fremd', 'region');
    await fs.mkdir(fremd, { recursive: true });
    await fs.writeFile(path.join(fremd, 'r.9.9.mca'), Buffer.alloc(2 * SECTOR));
    await fs.mkdir(path.join(dir(), 'world'), { recursive: true });
    await fs.symlink(fremd, path.join(dir(), 'world', 'region'));
    await expect(trimChunks(server, input, { apply: true })).rejects.toThrow();
    expect(await fs.readdir(fremd)).toEqual(['r.9.9.mca']);
  });
});
