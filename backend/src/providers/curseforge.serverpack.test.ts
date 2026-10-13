import { beforeEach, expect, it, vi } from 'vitest';
import { fetchJson } from '../lib/download.js';
import { findServerPack } from './curseforge.js';
import type { ProjectVersion } from './types.js';

vi.mock('../lib/download.js', () => ({ fetchJson: vi.fn() }));
vi.mock('../services/settings.js', () => ({ getCurseforgeKey: async () => 'testschluessel' }));
const version = { id: '100', name: 'Pack 2 1.0', filename: 'Pack-2-1.0.zip' } as ProjectVersion;
const file = (id: number, data = {}) => ({ id, modId: 10, displayName: 'Pack 2 1.0 Server', fileName: 'Pack-2-1.0-server.zip',
  fileDate: '', fileLength: 7, downloadUrl: 'https://fixture.test/pack', gameVersions: ['1.21.1', 'NeoForge'], ...data });
beforeEach(() => vi.resetAllMocks());

it('wählt ein ausdrücklich verknüpftes Serverpaket', async () => {
  vi.mocked(fetchJson).mockResolvedValue({ data: file(101, { isServerPack: true }) });
  expect(await findServerPack('10', { ...version, serverPackFileId: 101 })).toMatchObject({ route: 'linked', pack: { id: '101' } });
});

it.each([{ isServerPack: false }, { isServerPack: true, modId: 11 }])('weist falsche verknüpfte Dateien zurück: %j', async data => {
  vi.mocked(fetchJson).mockResolvedValue({ data: file(101, data) });
  await expect(findServerPack('10', { ...version, serverPackFileId: 101 })).rejects.toThrow('bestätigtes Serverpaket');
});

it('ordnet ein ähnliches Serverpaket ohne Anbieter-Verknüpfung nicht nach Namen zu', async () => {
  vi.mocked(fetchJson).mockResolvedValue({ data: [file(101, { isServerPack: true })], pagination: { totalCount: 1 } });
  expect(await findServerPack('10', version)).toBeNull();
});

it('findet die genaue Elternzuordnung auch auf späteren Dateiseiten', async () => {
  vi.mocked(fetchJson).mockResolvedValueOnce({ data: Array.from({ length: 50 }, (_, i) => file(i + 200)), pagination: { totalCount: 51 } })
    .mockResolvedValueOnce({ data: [file(101, { isServerPack: true, parentProjectFileId: 100 })], pagination: { totalCount: 51 } });
  expect(await findServerPack('10', version)).toMatchObject({ pack: { id: '101' } });
  expect(String(vi.mocked(fetchJson).mock.calls[1][0])).toContain('index=50');
});

it('lehnt mehrere Serverpakete mit gleicher Elternzuordnung ab', async () => {
  vi.mocked(fetchJson).mockResolvedValue({ data: [101, 102].map(id => file(id, { isServerPack: true, parentProjectFileId: 100 })), pagination: { totalCount: 2 } });
  await expect(findServerPack('10', version)).rejects.toThrow('mehrere Serverpakete');
});
