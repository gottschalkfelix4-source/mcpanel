import type { ContainerInspectInfo } from 'dockerode';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), find: vi.fn(), rows: vi.fn(), status: vi.fn() }));
vi.mock('../config.js', () => ({ config: { dockerNetwork: 'private-mc' } }));
vi.mock('../db.js', () => ({ prisma: { server: { findMany: mocks.rows } } }));
vi.mock('./docker.js', () => ({ docker: { getContainer: () => ({ inspect: mocks.inspect }) }, findContainer: mocks.find }));
vi.mock('./proxy.js', () => ({ ROUTER_NAME: 'mcpanel-router', proxyStatus: mocks.status }));
vi.mock('./settings.js', () => ({ getPublicHost: async () => 'mc.example.test' }));
import { proxyOverview, routerPortPlan, routingRuntime } from './proxyOverview.js';

const binding = { HostIp: '0.0.0.0', HostPort: '25565' };
function inspect(running = true, actual = {}, configured = {}) {
  return { State: { Running: running }, Config: { Labels: { 'mcpanel.router': 'true' }, ExposedPorts: { '25575/tcp': {} } }, NetworkSettings: { Ports: actual }, HostConfig: { PortBindings: configured } } as unknown as ContainerInspectInfo;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.status.mockResolvedValue({ enabled: true, port: 25565, running: true, reachable: true, error: null });
  mocks.inspect.mockResolvedValue(inspect(true, { '25565/tcp': [binding] }));
  mocks.rows.mockResolvedValue([{ id: 'atm', name: 'ATM10', type: 'MODPACK', hostnames: [{ hostname: 'atm.example.test' }], containerName: 'mc-atm', directConnect: false, port: 25566, rconPassword: 'secret' }]);
  mocks.find.mockResolvedValue({ inspect: async () => inspect() });
});
it('never treats exposed container ports as public ports', () => {
  expect(routingRuntime(inspect()).ports).toEqual([]);
});
it('distinguishes actual bindings from configured ports and retains protocols and loopback', () => {
  const runtime = routingRuntime(inspect(true, { '25565/tcp': [binding], '24454/udp': [{ HostIp: '127.0.0.1', HostPort: '24454' }] }, { '25565/tcp': [binding], '25566/tcp': [{ HostIp: '', HostPort: '25566' }] }));
  expect(runtime.ports).toHaveLength(3);
  expect(runtime.ports.map(port => [port.hostPort, port.protocol, port.active])).toEqual([[25565, 'tcp', true], [24454, 'udp', true], [25566, 'tcp', false]]);
  expect(runtime.ports[1].hostIp).toBe('127.0.0.1');
  expect(routingRuntime(inspect(false, { '25565/tcp': [binding] })).ports[0].active).toBe(false);
});
it('only requires intended TCP entrances while showing extra published UDP ports', () => {
  const plan = routerPortPlan([{ id: 'proxy', name: 'Proxy', requiredPort: 25565, runtime: routingRuntime(inspect()) }, { id: 'atm', name: 'ATM', requiredPort: null, runtime: routingRuntime(inspect(true, { '24454/udp': [{ ...binding, HostPort: '24454' }] })) }]);
  expect(plan.map(port => [port.port, port.required])).toEqual([[24454, false], [25565, true]]);
});
it('returns stable internal targets without exposing server credentials or claiming internet access', async () => {
  const result = await proxyOverview();
  expect(result.servers[0].internalAddress).toBe('mc-atm:25565');
  expect(result.ports.filter(port => port.required)).toHaveLength(1);
  expect(result.externalReachability).toBe('not_checked');
  expect(JSON.stringify(result)).not.toContain('secret');
});
it('distinguishes missing containers from Docker failures without losing the required port plan', async () => {
  mocks.inspect.mockRejectedValue({ statusCode: 404 });
  mocks.find.mockRejectedValue(new Error('Docker unavailable'));
  const result = await proxyOverview();
  expect(result.proxy.runtime.state).toBe('missing');
  expect(result.servers[0].runtime).toMatchObject({ state: 'unknown', error: 'Docker unavailable' });
  expect(result.ports[0]).toMatchObject({ port: 25565, required: true, bindings: [] });
});
it('does not display an unrelated container as the managed proxy', async () => {
  const info = inspect(); info.Config.Labels = {};
  mocks.inspect.mockResolvedValue(info);
  expect((await proxyOverview()).proxy.runtime.state).toBe('unknown');
});
