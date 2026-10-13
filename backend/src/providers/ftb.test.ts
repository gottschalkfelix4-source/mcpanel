import { beforeEach, expect, it, vi } from 'vitest';
import { fetchJson } from '../lib/download.js';
import { findServerPack } from './ftb.js';
import type { ProjectSummary, ProjectVersion } from './types.js';

vi.mock('../lib/download.js', () => ({ fetchJson: vi.fn() }));
const project = { id: '1198207', name: 'FTB OceanBlock 2', slug: 'ftb-oceanblock-2' } as ProjectSummary;
const version = { name: 'FTB OceanBlock 2 1.21.1', filename: 'ftb-oceanblock-2-1.21.1.zip',
  gameVersions: ['1.21.1'], loaders: ['neoforge'] } as ProjectVersion;
const targets = [{ name: 'minecraft', version: '1.21.1', type: 'game' }, { name: 'neoforge', version: '21.1.248', type: 'modloader' }];
const file = (name: string, clientonly = false) => ({ name, path: './mods', url: 'https://fixture.test/' + name,
  sha1: 'a'.repeat(40), size: 7, clientonly, serveronly: false });
let pack: any;
let manifest: any;
beforeEach(() => {
  vi.resetAllMocks();
  pack = { status: 'success', id: 128, name: project.name, meta: { curseforgeProjectId: 1198207 },
    versions: [{ id: 100482, name: '1.21.1', private: false, targets }] };
  manifest = { status: 'success', parent: 128, id: 100482, name: '1.21.1', private: false, targets,
    files: [file('server.jar'), file('euphoria.jar', true), file('collapsible.jar', true), { ...file('nur-server.jar'), serveronly: true }] };
  vi.mocked(fetchJson).mockImplementation(async url => String(url).includes('/search/')
    ? { status: 'success', packs: [128] } : String(url).endsWith('/128') ? pack : manifest);
});

it('ordnet OceanBlock über die CurseForge-ID und genaue Packversion zu und lädt nur Serverdateien', async () => {
  const result = await findServerPack(project, version);
  expect(result).toMatchObject({ projectId: 128, versionId: 100482, loader: 'NEOFORGE', loaderVersion: '21.1.248', excludedClientFiles: 2 });
  expect(result?.downloads.map(f => f.path)).toEqual(['mods/server.jar', 'mods/nur-server.jar']);
  expect(result?.downloads[0].sha1).toBe('a'.repeat(40));
});

it('verwechselt gleichnamige Projekte nicht mit der ausgewählten CurseForge-ID', async () => {
  pack.meta.curseforgeProjectId = 123;
  expect(await findServerPack(project, version)).toBeNull();
  expect(fetchJson).toHaveBeenCalledTimes(2);
});

it.each(['1.21.10', '1.21', '1.20.0'])('weicht bei fehlender exakter Version nicht auf %s aus', async name => {
  pack.versions[0].name = name;
  await expect(findServerPack(project, version)).rejects.toThrow('keine andere Version');
});

it('lehnt mehrdeutige Versionszuordnungen ab', async () => {
  pack.versions.push({ ...pack.versions[0], id: 100483 });
  await expect(findServerPack(project, version)).rejects.toThrow('eindeutig');
});

it.each(['parent', 'id'])('prüft die zurückgelieferte Manifestidentität: %s', async key => {
  manifest[key]++;
  await expect(findServerPack(project, version)).rejects.toThrow('Projektversion');
});

it.each(['minecraft', 'neoforge'])('prüft Minecraft und Loader: %s', async name => {
  manifest.targets = targets.map(t => t.name === name ? { ...t, name: name === 'neoforge' ? 'forge' : 'anderes-spiel' } : t);
  await expect(findServerPack(project, version)).rejects.toThrow(/Loader|Minecraft/);
});

it.each(['../../welt', '/welt', 'C:/welt', 'mods/../welt', 'mods\\welt'])('weist unsichere Dateipfade zurück: %s', async path => {
  manifest.files[0].path = path;
  await expect(findServerPack(project, version)).rejects.toThrow('Dateipfade');
});

it('weist doppelte Dateipfade zurück', async () => {
  manifest.files.push({ ...manifest.files[0] });
  await expect(findServerPack(project, version)).rejects.toThrow('doppelte');
});

it('erfordert explizite Seitenangaben und Prüfsummen', async () => {
  delete manifest.files[0].clientonly;
  await expect(findServerPack(project, version)).rejects.toThrow('Metadaten');
});

it('gibt einen FTB-Ausfall als Fehler weiter statt ein Client-Paket freizugeben', async () => {
  vi.mocked(fetchJson).mockRejectedValue(new Error('HTTP 503'));
  await expect(findServerPack(project, version)).rejects.toMatchObject({ statusCode: 400 });
});
