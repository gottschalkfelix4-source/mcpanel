import { describe, expect, it } from 'vitest';
import { agentPorts, nodeProfileSchema, parseRconPreamble, rconPreamble, tokenMatches } from './protocol.js';

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

describe('RCON-Weiterleitung', () => {
  it('nennt Token und Container in der ersten Zeile und liest sie wieder', () => {
    const line = rconPreamble('t'.repeat(43), 'mc-abc123');
    expect(line).toBe(`MCPANEL-RCON ${'t'.repeat(43)} mc-abc123\n`);
    expect(parseRconPreamble(line)).toEqual({ token: 't'.repeat(43), container: 'mc-abc123' });
  });

  it('lässt keine Containernamen durch, mit denen sich die Docker-API umbiegen ließe', () => {
    expect(() => rconPreamble('t', '../containers')).toThrow();
    expect(parseRconPreamble('MCPANEL-RCON t ../../info')).toBeNull();
    expect(parseRconPreamble('MCPANEL-RCON t mc-a extra')).toBeNull();
    expect(parseRconPreamble('GET / HTTP/1.1')).toBeNull();
  });
});

describe('Agent-Ports', () => {
  it('veröffentlicht unter Windows ohne VPN einen eigenen Bereich, sonst die Standardports', () => {
    expect(agentPorts('linux', 'direct')).toEqual({ docker: 2375, status: 7480, rcon: 7481, smb: 445 });
    expect(agentPorts('windows', 'wireguard')).toEqual({ docker: 2375, status: 7480, rcon: 7481, smb: 445 });
    expect(agentPorts('windows', 'direct')).toEqual({ docker: 24375, status: 24480, rcon: 24481, smb: 24445 });
  });
});
