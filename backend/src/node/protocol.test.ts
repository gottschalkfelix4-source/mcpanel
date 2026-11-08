import { describe, expect, it } from 'vitest';
import { nodeProfileSchema, rconHostPort, tokenMatches } from './protocol.js';

const base = {
  v: 1, nodeId: 'n1', name: 'Test', nodeIp: '192.168.1.50',
  token: 'x'.repeat(43), smbPassword: 'y'.repeat(32), dataRoot: '/opt/mcpanel-node',
};

describe('Node-Profil', () => {
  it('kommt ohne VPN ohne WireGuard-Angaben aus', () => {
    expect(nodeProfileSchema.parse({ ...base, mode: 'direct' }).mode).toBe('direct');
  });

  it('verlangt im Tunnelbetrieb alle WireGuard-Angaben', () => {
    expect(nodeProfileSchema.safeParse({ ...base, mode: 'wireguard' }).success).toBe(false);
    expect(nodeProfileSchema.safeParse({
      ...base, mode: 'wireguard', nodeIp: '10.66.0.2', privateKey: 'k'.repeat(44), listenPort: 51820,
      prefix: 24, panelIp: '10.66.0.1', panelPublicKey: 'p'.repeat(44),
    }).success).toBe(true);
  });

  it('wertet ein Profil ohne Modus als Tunnelbetrieb und verlangt dann WireGuard', () => {
    expect(nodeProfileSchema.safeParse(base).success).toBe(false);
  });
});

describe('Agent-Token', () => {
  it('vergleicht exakt', () => {
    expect(tokenMatches('geheim-token', 'geheim-token')).toBe(true);
    expect(tokenMatches('geheim-token', 'geheim-tokeN')).toBe(false);
    expect(tokenMatches('geheim-token', '')).toBe(false);
    expect(tokenMatches('geheim-token', undefined)).toBe(false);
  });
});

describe('RCON-Port auf der Node', () => {
  it('liegt 10000 über dem Spielport und bleibt im gültigen Bereich', () => {
    expect(rconHostPort(25565)).toBe(35565);
    expect(rconHostPort(60000)).toBe(50000);
  });
});
