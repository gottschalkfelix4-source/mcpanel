import { describe, expect, it, vi } from 'vitest';
vi.mock('../db.js', () => ({ prisma: {} }));
vi.mock('./nodeClients.js', () => ({ assertNodeReady: vi.fn(), rawNodeDocker: vi.fn() }));
import { agentSpec, performAgentUpdate } from './nodeUpdate.js';

const oldImageConfig = { Env: ['PATH=/usr/bin', 'MCPANEL_VERSION=1.4.0'], Labels: { 'org.opencontainers.image.version': '1.4.0' } };
const newImageConfig = { Env: ['PATH=/usr/bin', 'MCPANEL_VERSION=1.5.0'], Labels: { 'org.opencontainers.image.version': '1.5.0' } };

function agentInfo(overrides: { HostConfig?: Record<string, unknown> } = {}): any {
  return {
    Image: 'sha256:alt',
    Config: {
      Env: ['PATH=/usr/bin', 'MCPANEL_VERSION=1.4.0', 'MCPANEL_ROLE=node', 'NODE_CONFIG=/opt/mcpanel-node/node.json'],
      Labels: { 'org.opencontainers.image.version': '1.4.0' },
      Healthcheck: { Test: ['CMD-SHELL', 'test -f /run/mcpanel-node/ready'], Interval: 30e9 },
    },
    HostConfig: {
      NetworkMode: 'host',
      Binds: ['/var/run/docker.sock:/var/run/docker.sock', '/opt/mcpanel-node:/opt/mcpanel-node'],
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      CapAdd: ['NET_ADMIN'],
      Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
      PortBindings: {},
      ...overrides.HostConfig,
    },
  };
}

describe('Einstellungen des neuen Agenten', () => {
  it('übernimmt die Installation, aber nichts, was vom alten Abbild stammt', () => {
    const spec = agentSpec(agentInfo(), 'ghcr.io/x/mcpanel:1.5.0', [newImageConfig, oldImageConfig], { platform: 'linux', connection: 'wireguard' }) as any;
    expect(spec.Image).toBe('ghcr.io/x/mcpanel:1.5.0');
    expect(spec.Env).toEqual(['MCPANEL_ROLE=node', 'NODE_CONFIG=/opt/mcpanel-node/node.json']);
    expect(spec.Labels).toEqual({});
    expect(spec.Healthcheck.Test).toEqual(['CMD-SHELL', 'test -f /run/mcpanel-node/ready']);
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: 'host',
      CapAdd: ['NET_ADMIN'],
      RestartPolicy: { Name: 'unless-stopped' },
      Binds: ['/var/run/docker.sock:/var/run/docker.sock', '/opt/mcpanel-node:/opt/mcpanel-node'],
    });
    expect(spec.HostConfig.Devices).toHaveLength(1);
    expect(spec.HostConfig.PortBindings).toBeUndefined();
  });

  it('ergänzt bei Windows ohne VPN fehlende Agent-Ports wie die RCON-Weiterleitung', () => {
    const info = agentInfo({ HostConfig: {
      NetworkMode: 'mcpanel_mcpanel', CapAdd: null, Devices: [],
      PortBindings: { '2375/tcp': [{ HostIp: '', HostPort: '24375' }], '7480/tcp': [{ HostIp: '', HostPort: '24480' }], '445/tcp': [{ HostIp: '', HostPort: '24445' }] },
    } });
    const spec = agentSpec(info, 'neu', [newImageConfig], { platform: 'windows', connection: 'direct' }) as any;
    expect(spec.HostConfig.PortBindings['7481/tcp']).toEqual([{ HostIp: '', HostPort: '24481' }]);
    expect(spec.HostConfig.PortBindings['2375/tcp']).toEqual([{ HostIp: '', HostPort: '24375' }]);
    expect(Object.keys(spec.ExposedPorts).sort()).toEqual(['2375/tcp', '445/tcp', '7480/tcp', '7481/tcp']);
    expect(spec.HostConfig.CapAdd).toBeUndefined();
  });
});

function fakeDocker(options: { sameImage?: boolean; helperExit?: number; helperLogs?: string } = {}) {
  let helperChecks = 0;
  const created: any[] = [];
  const removed: string[] = [];
  const docker: any = {
    pull: vi.fn(async () => 'stream'),
    modem: { followProgress: (_s: unknown, done: (err: Error | null) => void) => done(null) },
    getImage: (name: string) => ({
      inspect: async () => name === 'sha256:alt'
        ? { Id: 'sha256:alt', Config: oldImageConfig }
        : { Id: options.sameImage ? 'sha256:alt' : 'sha256:neu', Config: newImageConfig },
    }),
    getContainer: (name: string) => ({
      inspect: async () => {
        if (name === 'mcpanel-node') return agentInfo();
        // Erst ist die Node weg, dann läuft der Helfer noch, dann ist er fertig.
        helperChecks++;
        if (helperChecks === 1) throw new Error('ECONNREFUSED');
        if (helperChecks === 2) return { State: { Running: true, ExitCode: 0 } };
        return { State: { Running: false, ExitCode: options.helperExit ?? 0 } };
      },
      logs: async () => Buffer.from(options.helperLogs ?? ''),
      remove: async () => { removed.push(name); },
    }),
    createContainer: vi.fn(async (spec: any) => { created.push(spec); return { start: async () => {} }; }),
  };
  return { docker, created, removed };
}

const node = { id: 'n1', name: 'PC', platform: 'linux', connection: 'wireguard', agentVersion: '1.4.0' } as any;

describe('Update-Ablauf im Panel', () => {
  it('startet den Helfer mit dem Austauschplan und wartet, bis die Node zurück ist', async () => {
    const { docker, created, removed } = fakeDocker();
    const recheck = vi.fn(async () => {});
    const result = await performAgentUpdate(node, { docker, image: 'ghcr.io/x/mcpanel:1.5.0', recheck, wait: async () => {} }, () => {});
    expect(result).toEqual({ changed: true, version: '1.5.0' });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: 'mcpanel-node-update', Image: 'ghcr.io/x/mcpanel:1.5.0', HostConfig: { NetworkMode: 'none' } });
    const planEntry = created[0].Env.find((entry: string) => entry.startsWith('UPDATE_PLAN='));
    const plan = JSON.parse(Buffer.from(planEntry.slice('UPDATE_PLAN='.length), 'base64').toString('utf8'));
    expect(plan).toMatchObject({ name: 'mcpanel-node', spec: { Image: 'ghcr.io/x/mcpanel:1.5.0' } });
    expect(removed).toContain('mcpanel-node-update');
    expect(recheck).toHaveBeenCalled();
  });

  it('meldet den Grund aus dem Helferprotokoll, wenn der Austausch zurückgerollt wurde', async () => {
    const logs = '\u0001\u0000\u0000\u0000\u0000\u0000\u0000@[mcpanel-node-update] FEHLER: Der neue Agent bricht ab: Profil ungültig. Der bisherige Agent läuft wieder.\n';
    const { docker } = fakeDocker({ helperExit: 1, helperLogs: logs });
    await expect(performAgentUpdate(node, { docker, image: 'neu', recheck: async () => {}, wait: async () => {} }, () => {}))
      .rejects.toThrow('Update fehlgeschlagen: Der neue Agent bricht ab: Profil ungültig. Der bisherige Agent läuft wieder.');
  });

  it('tauscht nichts aus, wenn Abbild und Ports schon stimmen', async () => {
    const { docker, created } = fakeDocker({ sameImage: true });
    const result = await performAgentUpdate(node, { docker, image: 'neu', recheck: async () => {}, wait: async () => {} }, () => {});
    expect(result.changed).toBe(false);
    expect(created).toHaveLength(0);
  });
});
