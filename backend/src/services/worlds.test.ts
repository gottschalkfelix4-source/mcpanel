import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import type { Server } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Weltverwaltung mit echtem Dateisystem in einem temporären Datenverzeichnis;
 * Datenbank, Docker, RCON und Backups sind ersetzt.
 */
const m = vi.hoisted(() => ({
  root: '',
  state: 'exited',
  calls: [] as string[],
  serverUpdate: vi.fn(async () => ({})),
  rcon: vi.fn(async (_server: unknown, command: string) => { m.calls.push(`rcon:${command}`); return ''; }),
  createBackup: vi.fn(async () => { m.calls.push('backup'); return {}; }),
}));

vi.mock('../config.js', () => ({
  serverDir: (id: string) => path.join(m.root, 'servers', id),
  serverBackupDir: (id: string) => path.join(m.root, 'backups', id),
}));
vi.mock('../db.js', () => ({ prisma: { server: { update: m.serverUpdate } } }));
vi.mock('./docker.js', () => ({ getState: vi.fn(async () => ({ state: m.state })) }));
vi.mock('./rcon.js', () => ({ rconCommand: m.rcon }));
vi.mock('./backups.js', () => ({ createBackup: m.createBackup }));
vi.mock('./files.js', () => ({ dirSize: vi.fn(async () => 1000) }));
vi.mock('./diskUsage.js', () => ({ invalidateDiskUsage: vi.fn() }));
vi.mock('./quota.js', () => ({ assertDiskAvailable: vi.fn() }));
vi.mock('./serverImport.js', () => ({ extractServerZip: vi.fn(), inspectServerZip: vi.fn() }));

const worlds = await import('./worlds.js');

const task = { id: 't', update: vi.fn(async () => {}), log: vi.fn(async () => {}) } as any;
const server = (extraEnv: Record<string, string> = {}) => ({ id: 'srv', name: 'Test', extraEnv }) as unknown as Server;
const dir = () => path.join(m.root, 'servers', 'srv');

async function world(name: string) {
  await fs.mkdir(path.join(dir(), name, 'region'), { recursive: true });
  await fs.writeFile(path.join(dir(), name, 'level.dat'), 'daten');
  await fs.writeFile(path.join(dir(), name, 'region', 'r.0.0.mca'), 'region');
}

async function props() {
  return fs.readFile(path.join(dir(), 'server.properties'), 'utf8');
}

beforeEach(async () => {
  m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-welten-'));
  m.state = 'exited';
  m.calls = [];
  vi.clearAllMocks();
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(path.join(dir(), 'server.properties'), 'level-name=world\nlevel-seed=123\n');
  await world('world');
  await world('world_nether');
  await world('Kreativ');
});

afterEach(async () => {
  await fs.rm(m.root, { recursive: true, force: true });
});

describe('Weltnamen', () => {
  it('akzeptiert normale Namen und lehnt Pfade ab', () => {
    expect(worlds.assertWorldName(' Welt 2 ')).toBe('Welt 2');
    for (const bad of ['', '..', 'a/b', '..\\x', '.versteckt', 'a..b', 'x'.repeat(65)]) {
      expect(() => worlds.assertWorldName(bad)).toThrow(/Ungültiger Weltname/);
    }
  });
});

describe('Weltliste', () => {
  it('fasst Dimensionsordner zur Welt zusammen und markiert die aktive', async () => {
    const result = await worlds.listWorlds(server());
    expect(result.active).toBe('world');
    expect(result.seed).toBe('123');
    expect(result.worlds.map((w) => w.name)).toEqual(['Kreativ', 'world']);
    expect(result.worlds.find((w) => w.name === 'world')).toMatchObject({ active: true, dimensions: ['world_nether'], sizeBytes: 2000 });
  });

  it('zeigt eine eingetragene, noch nicht erzeugte Welt an', async () => {
    await fs.writeFile(path.join(dir(), 'server.properties'), 'level-name=Neu\n');
    const result = await worlds.listWorlds(server());
    expect(result.worlds[0]).toMatchObject({ name: 'Neu', active: true, exists: false });
  });
});

describe('Welt wechseln und anlegen', () => {
  it('aktiviert eine vorhandene Welt über server.properties', async () => {
    const result = await worlds.activateWorld(server(), 'Kreativ');
    expect(result).toEqual({ active: 'Kreativ', restartRequired: false });
    expect(await props()).toMatch(/^level-name=Kreativ$/m);
    expect(m.serverUpdate).not.toHaveBeenCalled();
  });

  it('zieht ein gesetztes LEVEL in den Umgebungsvariablen mit', async () => {
    await worlds.activateWorld(server({ LEVEL: 'world' }), 'Kreativ');
    expect(m.serverUpdate).toHaveBeenCalledWith({ where: { id: 'srv' }, data: { extraEnv: { LEVEL: 'Kreativ' } } });
  });

  it('lehnt unbekannte Welten ab und verlangt einen freien Namen beim Anlegen', async () => {
    await expect(worlds.activateWorld(server(), 'Fehlt')).rejects.toMatchObject({ statusCode: 404 });
    await expect(worlds.createWorld(server(), 'Kreativ', '')).rejects.toMatchObject({ statusCode: 409 });
    await expect(worlds.createWorld(server(), 'Neu', 'zeile\numbruch')).rejects.toMatchObject({ statusCode: 400 });
    const result = await worlds.createWorld(server(), 'Neu', '42');
    expect(result.active).toBe('Neu');
    expect(await props()).toMatch(/^level-seed=42$/m);
  });
});

describe('Welt zurücksetzen und löschen', () => {
  it('verweigert den Reset bei laufendem Server, ohne etwas anzufassen', async () => {
    m.state = 'running';
    await expect(worlds.resetWorld(server(), '', task, null)).rejects.toMatchObject({ statusCode: 409 });
    expect(m.createBackup).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(dir(), 'world', 'level.dat'))).resolves.toBeTruthy();
  });

  it('sichert vor dem Reset und entfernt dann Welt samt Dimensionen', async () => {
    m.createBackup.mockImplementationOnce(async () => {
      // Zum Zeitpunkt des Backups muss die Welt noch vollständig da sein.
      await fs.stat(path.join(dir(), 'world_nether', 'level.dat'));
      m.calls.push('backup');
      return {};
    });
    await worlds.resetWorld(server(), '987', task, 'admin');
    expect(m.createBackup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ origin: 'SAFETY', createdById: 'admin' }));
    await expect(fs.stat(path.join(dir(), 'world'))).rejects.toThrow();
    await expect(fs.stat(path.join(dir(), 'world_nether'))).rejects.toThrow();
    await expect(fs.stat(path.join(dir(), 'Kreativ', 'level.dat'))).resolves.toBeTruthy();
    expect(await props()).toMatch(/^level-seed=987$/m);
  });

  it('löscht die aktive Welt nicht', async () => {
    await expect(worlds.deleteWorld(server(), 'world')).rejects.toMatchObject({ statusCode: 400 });
    await worlds.deleteWorld(server(), 'Kreativ');
    await expect(fs.stat(path.join(dir(), 'Kreativ'))).rejects.toThrow();
  });
});

describe('Welt herunterladen', () => {
  async function entries(file: string) {
    const names: string[] = [];
    await tar.list({ file, onentry: (entry) => void names.push(entry.path) });
    return names;
  }

  it('packt die Welt mit Dimensionen, aber ohne session.lock', async () => {
    await fs.writeFile(path.join(dir(), 'world', 'session.lock'), 'x');
    const exported = await worlds.exportWorld(server(), 'world');
    const names = await entries(exported.file);
    expect(names).toEqual(expect.arrayContaining(['world/level.dat', 'world_nether/level.dat', 'world/region/r.0.0.mca']));
    expect(names.some((n) => n.endsWith('session.lock'))).toBe(false);
    expect(names.some((n) => n.startsWith('Kreativ'))).toBe(false);
    expect(exported.filename).toBe('world.tar.gz');
    expect(m.rcon).not.toHaveBeenCalled();
    await exported.cleanup();
    await expect(fs.stat(exported.file)).rejects.toThrow();
  });

  it('pausiert bei laufendem Server das Speichern der aktiven Welt', async () => {
    m.state = 'running';
    const exported = await worlds.exportWorld(server(), 'world');
    expect(m.calls).toEqual(['rcon:save-off', 'rcon:save-all flush', 'rcon:save-on']);
    await exported.cleanup();
  });
});
