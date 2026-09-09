import { expect, it, vi } from 'vitest';
const read = vi.hoisted(() => vi.fn());
vi.mock('./properties.js', () => ({ readJsonList: read }));
const { readKnownPlayers } = await import('./knownPlayers.js');
const uuid = '12345678-1234-1234-1234-123456789012';
it('retains known profiles regardless of cache expiry and deduplicates names', async () => {
  read.mockResolvedValue([{ uuid, name: 'Felix', expiresOn: '2020-01-01' }, { uuid, name: 'felix' }, { uuid, name: 'Alex' }]);
  expect(await readKnownPlayers('server-a')).toEqual([{ uuid, name: 'Alex' }, { uuid, name: 'felix' }]);
  expect(read).toHaveBeenCalledWith('server-a', 'usercache.json');
});
it('ignores invalid cache records and handles a new server', async () => {
  read.mockResolvedValue([null, 4, {}, { uuid, name: 'op someone' }, { uuid: 'invalid', name: 'Felix' }]);
  expect(await readKnownPlayers('server-a')).toEqual([]);
  read.mockResolvedValue([]);
  expect(await readKnownPlayers('server-a')).toEqual([]);
});
