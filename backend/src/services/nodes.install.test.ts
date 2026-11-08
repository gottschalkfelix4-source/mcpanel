import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Node } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  config: {
    dataRoot: '',
    hostDataRoot: '/host/data',
    portRange: { min: 25565, max: 25700 },
    build: { version: '1.8.0', revision: '', date: '' },
    nodes: { tunnelSubnet: '10.66.0.0/24', interfaceName: 'wg-mcpanel', image: '', imageRepo: 'ghcr.io/beispiel/mcpanel' },
  },
}));
vi.mock('../config.js', () => ({ config: m.config, nodeMountDir: (id: string) => `${m.config.dataRoot}/nodes/${id}` }));
vi.mock('../db.js', () => ({ prisma: {} }));
vi.mock('./docker.js', () => ({}));
vi.mock('./settings.js', () => ({ getPublicHost: async () => 'panel.example.test' }));
m.config.dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-nodes-test-'));

const { installCommand, installScript, nodeImage, nodeProfile, uninstallCommand, validateDirectAddress } = await import('./nodes.js');
afterAll(() => fs.rm(m.config.dataRoot, { recursive: true, force: true }));

const node = (overrides: Partial<Node> = {}): Node => ({
  id: 'node1', name: 'VPS Test', publicHost: 'vps.example.test', connection: 'wireguard', listenPort: 51820,
  tunnelIp: '10.66.0.2', publicKey: 'pub', privateKey: 'k'.repeat(44), smbPassword: 's'.repeat(32),
  agentToken: 't'.repeat(43), dataRoot: '/opt/mcpanel-node', agentVersion: '', lastSeenAt: null, createdAt: new Date(),
  ...overrides,
});

/** Syntaxprüfung mit der echten Shell, sofern es eine gibt (Linux-CI). */
function assertShellSyntax(script: string) {
  try {
    execFileSync('sh', ['-n'], { input: script });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

describe('Installationsskript', () => {
  it('richtet im Tunnelbetrieb WireGuard ein und bettet das Profil ein', async () => {
    const script = await installScript(node());
    expect(script).toContain('modprobe wireguard');
    expect(script).toContain("EXTRA='--cap-add=NET_ADMIN'");
    expect(script).toContain('ufw allow "$WG_PORT/udp"');
    expect(script).toContain('"mode":"wireguard"');
    expect(script).toContain('"panelIp":"10.66.0.1"');
    expect(script).toContain(`"privateKey":"${'k'.repeat(44)}"`);
    expect(script).toContain(`"token":"${'t'.repeat(43)}"`);
    expect(script).toContain("IMAGE='ghcr.io/beispiel/mcpanel:1.8.0'");
    // Über `| sh` gelesen, darf kein Befehl den Rest des Skripts verschlucken.
    expect(script.trimEnd().endsWith('main "$@" </dev/null')).toBe(true);
    assertShellSyntax(script);
  });

  it('lässt WireGuard ohne VPN weg und öffnet die Agent-Ports nur fürs LAN', async () => {
    const script = await installScript(node({ connection: 'direct', publicHost: '192.168.1.50', tunnelIp: '192.168.1.50' }));
    expect(script).not.toContain('modprobe wireguard');
    expect(script).not.toContain('NET_ADMIN');
    expect(script).not.toContain('privateKey');
    expect(script).toContain("NODE_IP='192.168.1.50'");
    expect(script).toContain('"mode":"direct"');
    expect(script).toContain('for port in 2375 7480 445');
    assertShellSyntax(script);
  });

  it('verpackt das Skript in einen einzigen Befehl, der es unverändert wiederherstellt', async () => {
    const command = await installCommand(node());
    expect(command).toMatch(/^echo '[A-Za-z0-9+/=]+' \| base64 -d \| \$\(command -v sudo\) sh$/);
    const encoded = /^echo '([^']+)'/.exec(command)![1];
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(await installScript(node()));
  });

  it('nimmt die Fassung des Panels als Abbild, sonst latest', () => {
    expect(nodeImage()).toBe('ghcr.io/beispiel/mcpanel:1.8.0');
    m.config.build.version = '';
    try {
      expect(nodeImage()).toBe('ghcr.io/beispiel/mcpanel:latest');
    } finally {
      m.config.build.version = '1.8.0';
    }
  });

  it('räumt ohne VPN keine WireGuard-Schnittstelle ab', () => {
    expect(uninstallCommand(node())).toContain('ip link del wg-mcpanel');
    expect(uninstallCommand(node({ connection: 'direct' }))).not.toContain('wg-mcpanel');
  });

  it('gibt ohne VPN keine WireGuard-Schlüssel ins Profil', async () => {
    const profile = await nodeProfile(node({ connection: 'direct', tunnelIp: '192.168.1.50' }));
    expect(profile).toEqual(expect.objectContaining({ mode: 'direct', nodeIp: '192.168.1.50' }));
    expect(profile.privateKey).toBeUndefined();
  });
});

describe('LAN-Adresse ohne VPN', () => {
  it('nimmt private IPv4-Adressen', () => {
    for (const ip of ['192.168.1.50', '10.0.0.7', '172.16.5.4', '172.31.255.1']) expect(() => validateDirectAddress(ip)).not.toThrow();
  });

  it('lehnt öffentliche Adressen, Namen und das Tunnelnetz ab', () => {
    for (const host of ['8.8.8.8', 'nas.fritz.box', '172.32.0.1', '192.168.1.300', '10.66.0.5']) {
      expect(() => validateDirectAddress(host)).toThrow();
    }
  });
});
