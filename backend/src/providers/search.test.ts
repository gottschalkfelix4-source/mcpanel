import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../lib/download.js', () => ({ fetchJson: vi.fn() }));
vi.mock('../services/settings.js', () => ({ getCurseforgeKey: vi.fn().mockResolvedValue('testschluessel') }));
import { fetchJson } from '../lib/download.js';
import * as curseforge from './curseforge.js';
import * as modrinth from './modrinth.js';

beforeEach(() => vi.clearAllMocks());

const project = (id: number, latestFiles: object[] = []) => ({
  id, name: id === 1198207 ? 'FTB OceanBlock 2' : `Modpack ${id}`, slug: `pack-${id}`,
  summary: '', downloadCount: 100, authors: [], categories: [],
  dateModified: '2026-10-13T00:00:00Z', latestFiles,
});

it('behält OceanBlock 2 ohne verknüpftes Serverpaket als ungeprüften Suchtreffer', async () => {
  vi.mocked(fetchJson).mockResolvedValue({ data: [project(1198207)], pagination: { totalCount: 1 } });
  const result = await curseforge.search({ query: 'OceanBlock', serverOnly: true });
  expect(result.total).toBe(1);
  expect(result.hits).toEqual([expect.objectContaining({ id: '1198207', serverSupport: 'unknown', hasServerPack: false })]);
});

it('überspringt beim Blättern keine Treffer und bewahrt die Reihenfolge des Anbieters', async () => {
  vi.mocked(fetchJson).mockImplementation(async (url) => {
    const params = new URL(String(url)).searchParams;
    const index = Number(params.get('index'));
    const count = Number(params.get('pageSize'));
    return { data: Array.from({ length: count }, (_, i) => project(index + i + 1, [{ serverPackFileId: 500 }])), pagination: { totalCount: 100 } };
  });
  const first = await curseforge.search({ serverOnly: true, pageSize: 24, page: 1 });
  const second = await curseforge.search({ serverOnly: true, pageSize: 24, page: 2 });
  expect([...first.hits, ...second.hits].map((p) => p.id)).toEqual(Array.from({ length: 48 }, (_, i) => String(i + 1)));
  expect(second.total).toBe(100);
});

it('erkennt verknüpfte und eigenständig markierte Serverpakete', async () => {
  vi.mocked(fetchJson).mockResolvedValue({ data: [project(1, [{ serverPackFileId: 2 }]), project(2, [{ isServerPack: true }]), project(3)], pagination: { totalCount: 3 } });
  const result = await curseforge.search({ serverOnly: true });
  expect(result.hits.map((p) => p.serverSupport)).toEqual(['supported', 'supported', 'unknown']);
  expect(result.hits.map((p) => p.hasServerPack)).toEqual([true, true, false]);
});

it('behält Suchtext, Sortierung, Minecraft-Version und Loader beim CurseForge-Abruf', async () => {
  vi.mocked(fetchJson).mockResolvedValue({ data: [], pagination: { totalCount: 0 } });
  await curseforge.search({ query: 'OceanBlock', serverOnly: true, sort: 'downloads', gameVersion: '1.21.1', loader: 'neoforge' });
  const params = new URL(String(vi.mocked(fetchJson).mock.calls[0][0])).searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ searchFilter: 'OceanBlock', sortField: '6', gameVersion: '1.21.1', modLoaderType: '6' });
});

it('blendet bei Modrinth nur ausdrücklich reine Client-Projekte aus', async () => {
  vi.mocked(fetchJson).mockResolvedValue({ hits: [], total_hits: 0 });
  await modrinth.search({ serverOnly: true });
  const params = new URL(String(vi.mocked(fetchJson).mock.calls[0][0])).searchParams;
  const facets = JSON.parse(params.get('facets')!);
  expect(facets[1]).toEqual(expect.arrayContaining(['environment:dedicated_server_only', 'environment:client_and_server', 'environment:unknown']));
  expect(facets[1]).not.toContain('environment:client_only');
  expect(facets[1]).not.toContain('environment:singleplayer_only');
});

it.each([{ serverOnly: false }, { serverOnly: true, type: 'plugin' as const }])('lässt alle Projekte beziehungsweise Plugins ohne Seitenfilter suchen: %j', async (query) => {
  vi.mocked(fetchJson).mockResolvedValue({ hits: [], total_hits: 0 });
  await modrinth.search(query);
  const params = new URL(String(vi.mocked(fetchJson).mock.calls[0][0])).searchParams;
  expect(params.get('facets')).not.toContain('server_side:');
  expect(params.get('facets')).not.toContain('environment:');
});

it.each([
  [['client_only', 'dedicated_server_only'], 'supported'],
  [['client_only', 'unknown'], 'unknown'],
  [['client_only', 'singleplayer_only'], 'unsupported'],
  [['neue_unbekannte_umgebung'], 'unknown'],
  [undefined, 'unsupported'],
])('wertet mehrere Modrinth-Einsatzumgebungen vor dem veralteten Seitenfeld aus: %j', async (environment, expected) => {
  vi.mocked(fetchJson).mockResolvedValue({ hits: [{ project_id: 'paket', server_side: 'unsupported', environment }], total_hits: 1 });
  expect((await modrinth.search({})).hits[0].serverSupport).toBe(expected);
  vi.mocked(fetchJson).mockResolvedValue({ id: 'paket', server_side: 'unsupported', environment });
  expect((await modrinth.getProject('paket')).serverSupport).toBe(expected);
});
