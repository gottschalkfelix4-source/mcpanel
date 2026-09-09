import type Docker from 'dockerode';
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ exists: vi.fn(), read: vi.fn(), inspect: vi.fn(), connect: vi.fn(), get: vi.fn() }));
vi.mock('node:fs', () => ({ default: { existsSync: m.exists, readFileSync: m.read } }));
vi.mock('node:os', () => ({ default: { hostname: () => 'panel-hostname' } }));
const { connectPanelToNetwork } = await import('./dockerNetwork.js');
const docker = { getContainer: m.get, getNetwork: () => ({ connect: m.connect }) } as unknown as Docker;
beforeEach(() => {
  vi.resetAllMocks();
  m.exists.mockReturnValue(true);
  m.read.mockReturnValue('');
  m.get.mockReturnValue({ inspect: m.inspect });
  m.inspect.mockResolvedValue({ Id: 'panel-id', NetworkSettings: { Networks: { bridge: {} } } });
});
it('attaches an Unraid panel to the servers network without replacing bridge', async () => {
  await connectPanelToNetwork(docker, 'mc-network');
  expect(m.connect).toHaveBeenCalledWith({ Container: 'panel-id' });
});
it('keeps existing compose network membership', async () => {
  m.inspect.mockResolvedValue({ Id: 'panel-id', NetworkSettings: { Networks: { 'mc-network': {} } } });
  await connectPanelToNetwork(docker, 'mc-network');
  expect(m.connect).not.toHaveBeenCalled();
});
it('finds the real container ID even with a custom hostname', async () => {
  const id = 'a'.repeat(64);
  m.read.mockReturnValue(`/docker/containers/${id}/hostname`);
  await connectPanelToNetwork(docker, 'mc-network');
  expect(m.get).toHaveBeenCalledWith(id);
});
it('skips network attachment for local development outside Docker', async () => {
  m.exists.mockReturnValue(false);
  await connectPanelToNetwork(docker, 'mc-network');
  expect(m.get).not.toHaveBeenCalled();
});
it('accepts a concurrent successful attachment but propagates actual failures', async () => {
  m.connect.mockRejectedValue(new Error('already connected'));
  m.inspect.mockResolvedValueOnce({ Id: 'panel-id', NetworkSettings: { Networks: {} } })
    .mockResolvedValueOnce({ Id: 'panel-id', NetworkSettings: { Networks: { 'mc-network': {} } } });
  await connectPanelToNetwork(docker, 'mc-network');
  await expect(connectPanelToNetwork(docker, 'mc-network')).rejects.toThrow('already connected');
});
it('reports a missing identity or Docker outage rather than attaching another container', async () => {
  m.inspect.mockRejectedValue({ statusCode: 404 });
  await expect(connectPanelToNetwork(docker, 'mc-network')).rejects.toThrow('nicht gefunden');
  m.inspect.mockRejectedValue({ statusCode: 503 });
  await expect(connectPanelToNetwork(docker, 'mc-network')).rejects.toMatchObject({ statusCode: 503 });
  expect(m.connect).not.toHaveBeenCalled();
});
