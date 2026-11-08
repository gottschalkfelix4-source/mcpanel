import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Der Abgleich selbst braucht nur das Dateisystem; alles andere wird stillgelegt.
vi.mock('../db.js', () => ({ prisma: {} }));
vi.mock('./docker.js', () => ({}));
vi.mock('./proxy.js', () => ({ syncProxyRoutes: vi.fn() }));
vi.mock('./rcon.js', () => ({ closeRconConnection: vi.fn(), rconCommand: vi.fn() }));
vi.mock('./nodeClients.js', () => ({ assertNodeReady: vi.fn(), nodeDocker: vi.fn() }));
vi.mock('./diskUsage.js', () => ({ invalidateDiskUsage: vi.fn() }));

const { syncTree } = await import('./nodeMigration.js');

let root = '';
let source = '';
let target = '';

async function write(base: string, rel: string, content: string, mtime?: Date) {
  const file = path.join(base, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  if (mtime) await fs.utimes(file, mtime, mtime);
}

async function tree(base: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, rel: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), next);
      else out[next] = await fs.readFile(path.join(dir, entry.name), 'utf8');
    }
  };
  await walk(base, '');
  return out;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-sync-'));
  source = path.join(root, 'quelle');
  target = path.join(root, 'ziel');
  await write(source, 'server.properties', 'motd=Hallo');
  await write(source, 'world/region/r.0.0.mca', 'region-a');
  await write(source, 'world/region/r.0.1.mca', 'region-b');
  await write(source, 'logs/latest.log', 'log');
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('Abgleich für den Live-Umzug', () => {
  it('kopiert beim ersten Durchgang alles und übernimmt die Änderungszeit', async () => {
    const result = await syncTree(source, target);
    expect(result).toEqual(expect.objectContaining({ files: 4, removed: 0, unchanged: 0 }));
    expect(await tree(target)).toEqual(await tree(source));
    const [a, b] = await Promise.all([fs.stat(path.join(source, 'world/region/r.0.0.mca')), fs.stat(path.join(target, 'world/region/r.0.0.mca'))]);
    expect(Math.abs(a.mtimeMs - b.mtimeMs)).toBeLessThan(1);
  });

  it('kopiert danach nur Geändertes und entfernt, was an der Quelle fehlt', async () => {
    await syncTree(source, target);
    const later = new Date(Date.now() + 5000);
    await write(source, 'world/region/r.0.0.mca', 'region-a-neu', later);
    await write(source, 'world/playerdata/spieler.dat', 'neu');
    await fs.rm(path.join(source, 'logs'), { recursive: true });

    const result = await syncTree(source, target);
    expect(result.files).toBe(2);
    expect(result.removed).toBe(1);
    expect(result.unchanged).toBe(2);
    expect(await tree(target)).toEqual(await tree(source));
  });

  it('erkennt eine geänderte Datei auch bei gleicher Größe an der Änderungszeit', async () => {
    await syncTree(source, target);
    await write(source, 'world/region/r.0.1.mca', 'region-c', new Date(Date.now() + 5000));
    const result = await syncTree(source, target);
    expect(result.files).toBe(1);
    expect((await tree(target))['world/region/r.0.1.mca']).toBe('region-c');
  });

  it('lässt halbfertige Uploads aus und räumt sie am Ziel weg', async () => {
    await write(source, '.upload-1234/mod.jar', 'halb');
    await write(target, 'plugins/.sftp-upload-99', 'alt');
    await syncTree(source, target);
    const copied = await tree(target);
    expect(Object.keys(copied).some((name) => name.includes('upload'))).toBe(false);
  });

  it('ersetzt am Ziel eine Datei durch einen Ordner und umgekehrt', async () => {
    await syncTree(source, target);
    await fs.rm(path.join(source, 'logs'), { recursive: true });
    await write(source, 'logs', 'jetzt eine Datei');
    await fs.rm(path.join(source, 'server.properties'));
    await write(source, 'server.properties/inhalt', 'jetzt ein Ordner');
    await syncTree(source, target);
    expect(await tree(target)).toEqual(await tree(source));
  });
});
