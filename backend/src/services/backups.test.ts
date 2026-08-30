import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import * as tar from 'tar';
import type { Server } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Der gefaehrliche Fall beim Wiederherstellen: ein beschaedigtes Archiv darf
 * den vorhandenen Serverstand nicht mitreissen. Die Pruefung steckt in
 * `restoreBackup` selbst, deshalb werden hier Datenbank und Docker ersetzt und
 * nur das Dateisystem ist echt – ein temporaeres Datenverzeichnis je Test.
 */
const mocks = vi.hoisted(() => ({
  root: '',
  findFirst: vi.fn(),
  stop: vi.fn(),
  recreateContainer: vi.fn(),
  fetchBackup: vi.fn(),
}));

const serverDirOf = (id: string) => path.join(mocks.root, 'servers', id);
const backupDirOf = (id: string) => path.join(mocks.root, 'backups', id);

vi.mock('../config.js', () => ({
  serverDir: (id: string) => serverDirOf(id),
  serverBackupDir: (id: string) => backupDirOf(id),
}));

vi.mock('../db.js', () => ({
  prisma: { backup: { findFirst: mocks.findFirst } },
}));

vi.mock('./docker.js', () => ({
  stop: mocks.stop,
  recreateContainer: mocks.recreateContainer,
  getState: vi.fn(async () => ({ state: 'exited' })),
}));

vi.mock('./rcon.js', () => ({ rconCommand: vi.fn() }));
vi.mock('./diskUsage.js', () => ({ invalidateDiskUsage: vi.fn() }));
vi.mock('./notify.js', () => ({ notify: vi.fn() }));
vi.mock('./quota.js', () => ({
  assertDiskAvailable: vi.fn(),
  pruneToBackupLimit: vi.fn(async () => 0),
}));
vi.mock('./backupTarget.js', () => ({
  fetchBackup: mocks.fetchBackup,
  getTarget: vi.fn(async () => null),
  isEnabled: () => false,
  putBackup: vi.fn(),
  removeBackup: vi.fn(),
}));

const { restoreBackup } = await import('./backups.js');

const SERVER_ID = 'srv-test';
const FILENAME = 'backup-test.tar.gz';
const server = { id: SERVER_ID, name: 'Testserver' } as unknown as Server;

const dir = () => serverDirOf(SERVER_ID);
const archivePath = () => path.join(backupDirOf(SERVER_ID), FILENAME);

const exists = (target: string) => fs.stat(target).then(() => true, () => false);

/** Legt einen kleinen Serverstand an, den ein Fehlschlag nicht kosten darf. */
async function legeServerstandAn() {
  await fs.mkdir(path.join(dir(), 'world'), { recursive: true });
  await fs.writeFile(path.join(dir(), 'server.properties'), 'motd=Alter Stand\n');
  // Zufallsdaten, damit das Archiv sich nicht auf wenige Bytes zusammenpacken
  // laesst – sonst laeuft ein abgeschnittenes Archiv gar nicht ins Leere.
  await fs.writeFile(path.join(dir(), 'world', 'level.dat'), crypto.randomBytes(256 * 1024));
}

/** Packt den aktuellen Serverstand in die Hauptablage. */
async function packeArchiv() {
  await fs.mkdir(backupDirOf(SERVER_ID), { recursive: true });
  const entries = await fs.readdir(dir());
  await tar.create({ gzip: true, file: archivePath(), cwd: dir(), portable: true }, entries);
}

beforeEach(async () => {
  mocks.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-backups-'));
  mocks.findFirst.mockResolvedValue({ id: 'bk-1', serverId: SERVER_ID, filename: FILENAME });
  mocks.fetchBackup.mockResolvedValue(null);
});

afterEach(async () => {
  await fs.rm(mocks.root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('restoreBackup', () => {
  it('spielt ein heiles Archiv ein und entfernt den Ausweichordner', async () => {
    await legeServerstandAn();
    await packeArchiv();

    await fs.writeFile(path.join(dir(), 'server.properties'), 'motd=Neuer Stand\n');
    await fs.writeFile(path.join(dir(), 'ueberzaehlig.txt'), 'nach dem Backup entstanden');

    await restoreBackup(server, 'bk-1');

    expect(await fs.readFile(path.join(dir(), 'server.properties'), 'utf8')).toBe('motd=Alter Stand\n');
    expect(await exists(path.join(dir(), 'world', 'level.dat'))).toBe(true);
    expect(await exists(path.join(dir(), 'ueberzaehlig.txt'))).toBe(false);
    expect(await exists(path.join(dir(), '.restore-old'))).toBe(false);
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.recreateContainer).toHaveBeenCalledOnce();
  });

  it('lässt bei einem abgeschnittenen Archiv die Serverdaten unangetastet', async () => {
    await legeServerstandAn();
    await packeArchiv();

    // Uebertragung abgebrochen: nur die erste Haelfte des Archivs liegt da.
    const heil = await fs.readFile(archivePath());
    await fs.writeFile(archivePath(), heil.subarray(0, Math.floor(heil.length / 2)));

    await expect(restoreBackup(server, 'bk-1')).rejects.toThrow(/beschädigt oder unvollständig/);

    expect(await fs.readFile(path.join(dir(), 'server.properties'), 'utf8')).toBe('motd=Alter Stand\n');
    expect(await exists(path.join(dir(), 'world', 'level.dat'))).toBe(true);
    expect(await exists(path.join(dir(), '.restore-old'))).toBe(false);
  });

  it('unterbricht den laufenden Server erst gar nicht, wenn das Archiv kaputt ist', async () => {
    await legeServerstandAn();
    await fs.mkdir(backupDirOf(SERVER_ID), { recursive: true });
    await fs.writeFile(archivePath(), 'das ist kein gzip-Archiv');

    await expect(restoreBackup(server, 'bk-1')).rejects.toThrow(/beschädigt oder unvollständig/);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.recreateContainer).not.toHaveBeenCalled();
  });

  it('lehnt ein Archiv ohne einen einzigen Eintrag ab', async () => {
    await legeServerstandAn();
    await fs.mkdir(backupDirOf(SERVER_ID), { recursive: true });
    // Gepackt, aber nur die Endmarkierung eines tar – kein Eintrag darin.
    await fs.writeFile(archivePath(), zlib.gzipSync(Buffer.alloc(1024)));

    await expect(restoreBackup(server, 'bk-1')).rejects.toThrow(/es wurde nichts verändert/);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(dir(), 'server.properties'), 'utf8')).toBe('motd=Alter Stand\n');
  });

  it('meldet eine unbekannte Sicherung', async () => {
    mocks.findFirst.mockResolvedValue(null);
    await expect(restoreBackup(server, 'bk-weg')).rejects.toThrow('Backup nicht gefunden');
  });

  it('meldet eine fehlende Archivdatei in beiden Ablagen', async () => {
    await legeServerstandAn();
    await expect(restoreBackup(server, 'bk-1')).rejects.toThrow(/Backup-Datei fehlt/);
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  // Wird das Panel mitten in der Wiederherstellung beendet - etwa durch ein
  // Container-Update -, liegt der komplette Serverstand in .restore-old und das
  // Serververzeichnis enthaelt nur Bruchstuecke. Der naechste Lauf darf diesen
  // Ordner nicht einfach loeschen: er ist dann die einzige vollstaendige Kopie.
  it('holt den Stand eines abgebrochenen Laufs zurück, statt ihn zu verwerfen', async () => {
    await legeServerstandAn();
    await packeArchiv();

    const stash = path.join(dir(), '.restore-old');
    await fs.mkdir(stash, { recursive: true });
    for (const entry of await fs.readdir(dir())) {
      if (entry === '.restore-old') continue;
      await fs.rename(path.join(dir(), entry), path.join(stash, entry));
    }
    // Bruchstueck aus dem abgebrochenen Entpacken.
    await fs.writeFile(path.join(dir(), 'halb-entpackt.tmp'), 'unvollständig');

    await restoreBackup(server, 'bk-1');

    expect(await fs.readFile(path.join(dir(), 'server.properties'), 'utf8')).toBe('motd=Alter Stand\n');
    expect(await exists(path.join(dir(), 'world', 'level.dat'))).toBe(true);
    expect(await exists(path.join(dir(), 'halb-entpackt.tmp'))).toBe(false);
    expect(await exists(stash)).toBe(false);
  });
});
