import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ root: '', values: new Map<string, string>(), dump: vi.fn() }));
vi.mock('../config.js', () => ({ config: { get dataRoot() { return m.root; }, jwtSecret: 'test-jwt-geheimnis',
  build: {}, portRange: { min: 25565, max: 25700 }, sftp: { enabled: true, port: 2222, publicPort: 2222, host: 'panel.example.de' } } }));
vi.mock('./settings.js', () => ({ getSetting: async (key: string) => m.values.get(key) ?? '', setSetting: async (key: string, value: string) => { m.values.set(key, value); } }));
vi.mock('./tasks.js', () => ({ runTask: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: (...args: any[]) => m.dump(...args) }));
import { createPanelBackup, getPanelBackupSchedule, listPanelBackups, panelBackupFile, panelBackupScheduleSchema } from './panelBackups.js';
beforeEach(async () => {
  m.values.clear(); m.dump.mockReset(); m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-panel-sicherung-'));
  await fs.writeFile(path.join(m.root, '.sftp-host-key'), 'test-hostschluessel');
  m.dump.mockImplementation((_program: string, args: string[], _options: any, callback: any) => {
    void fs.writeFile(args[2], 'PGDMP-testdatenbank').then(() => callback(null, '', ''), callback);
  });
});
afterEach(async () => fs.rm(m.root, { recursive: true, force: true }));
it('sichert Datenbank und Schlüssel, lässt Welten außen vor und räumt temporäre Dateien auf', async () => {
  await fs.mkdir(path.join(m.root, 'servers/a'), { recursive: true });
  await fs.writeFile(path.join(m.root, 'servers/a/level.dat'), 'originalwelt');
  const filename = await createPanelBackup();
  const file = await panelBackupFile(filename); const entries: string[] = [];
  await tar.list({ file: file.path, onReadEntry: entry => { entries.push(entry.path); } });
  expect(entries).toEqual(expect.arrayContaining(['database.dump', '.jwt-secret', '.sftp-host-key', 'manifest.json', 'runtime.json', 'WIEDERHERSTELLUNG.txt']));
  expect(entries.some(entry => entry.includes('level.dat'))).toBe(false);
  expect((await fs.readdir(path.dirname(file.path))).filter(name => name.startsWith('.vorbereitung') || name.endsWith('.part'))).toEqual([]);
  expect((await listPanelBackups())[0].filename).toBe(filename);
});
it('behält bei einem Dump-Fehler bestehende Sicherungen und veröffentlicht kein halbes Archiv', async () => {
  const filename = await createPanelBackup();
  m.dump.mockImplementation((_program: any, _args: any, _options: any, callback: any) => callback(new Error('Testfehler')));
  await expect(createPanelBackup()).rejects.toThrow('Datenbank konnte nicht gesichert');
  expect((await listPanelBackups()).map(item => item.filename)).toEqual([filename]);
  expect(m.values.get('panel.backup.lastStatus')).toBe('FEHLER');
});
it('prüft den Zeitplan, lehnt Traversal ab und ist standardmäßig deaktiviert', async () => {
  expect((await getPanelBackupSchedule()).enabled).toBe(false);
  expect(panelBackupScheduleSchema.safeParse({ enabled: true, cron: 'ungültig', keep: 7 }).success).toBe(false);
  await expect(panelBackupFile('../.jwt-secret')).rejects.toMatchObject({ statusCode: 400 });
});
