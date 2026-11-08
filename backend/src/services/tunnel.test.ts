import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  config: { dataRoot: '', nodes: { tunnelSubnet: '10.66.0.0/24', interfaceName: 'wg-mcpanel' } },
}));
vi.mock('../config.js', () => ({ config: m.config }));
m.config.dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-tunnel-test-'));

const { nextTunnelIp, panelKeyPair, panelTunnelIp, parseWgDump, wgKeyPair, wgPublicKey } = await import('./tunnel.js');
afterAll(() => fs.rm(m.config.dataRoot, { recursive: true, force: true }));

describe('WireGuard-Schlüssel', () => {
  it('leitet den öffentlichen Schlüssel wie X25519 aus RFC 7748 ab', () => {
    const alice = Buffer.from('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a', 'hex').toString('base64');
    expect(Buffer.from(wgPublicKey(alice), 'base64').toString('hex'))
      .toBe('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
  });

  it('erzeugt geklemmte Schlüssel im Format von wg genkey', () => {
    const { privateKey, publicKey } = wgKeyPair();
    const raw = Buffer.from(privateKey, 'base64');
    expect(raw).toHaveLength(32);
    expect(raw[0] & 7).toBe(0);
    expect(raw[31] & 128).toBe(0);
    expect(raw[31] & 64).toBe(64);
    expect(wgPublicKey(privateKey)).toBe(publicKey);
  });

  it('lehnt Schlüssel falscher Länge ab', () => {
    expect(() => wgPublicKey(Buffer.alloc(16).toString('base64'))).toThrow('Ungültiger WireGuard-Schlüssel');
  });

  it('legt den Panel-Schlüssel einmal an und liest ihn danach wieder', async () => {
    const first = await panelKeyPair();
    const stored = (await fs.readFile(path.join(m.config.dataRoot, '.wireguard-key'), 'utf8')).trim();
    expect(stored).toBe(first.privateKey);
    expect((await panelKeyPair()).publicKey).toBe(first.publicKey);
  });
});

describe('Tunnelnetz', () => {
  it('gibt dem Panel die .1 und den Nodes die nächste freie Adresse', () => {
    expect(panelTunnelIp()).toBe('10.66.0.1');
    expect(nextTunnelIp(['10.66.0.1'])).toBe('10.66.0.2');
    expect(nextTunnelIp(['10.66.0.1', '10.66.0.2', '10.66.0.4'])).toBe('10.66.0.3');
  });

  it('meldet ein volles Netz', () => {
    const all = Array.from({ length: 254 }, (_, i) => `10.66.0.${i + 1}`);
    expect(() => nextTunnelIp(all)).toThrow('keine Adresse mehr frei');
  });

  it('verlangt ein /24-Netz', () => {
    m.config.nodes.tunnelSubnet = '10.66.0.0/16';
    try {
      expect(() => panelTunnelIp()).toThrow('/24');
    } finally {
      m.config.nodes.tunnelSubnet = '10.66.0.0/24';
    }
  });
});

describe('wg show dump', () => {
  it('liest Handschlag, Endpunkt und Zähler je Gegenstelle', () => {
    const dump = [
      'PRIVATE\tPUBLIC\t0\toff',
      'peerA=\t(none)\t203.0.113.5:51820\t10.66.0.2/32\t1762632000\t1024\t2048\t25',
      'peerB=\t(none)\t(none)\t10.66.0.3/32\t0\t0\t0\t25',
    ].join('\n');
    const peers = parseWgDump(dump);
    expect(peers.get('peerA=')).toEqual({
      endpoint: '203.0.113.5:51820', handshakeAt: new Date(1762632000 * 1000), rxBytes: 1024, txBytes: 2048,
    });
    expect(peers.get('peerB=')).toEqual({ endpoint: null, handshakeAt: null, rxBytes: 0, txBytes: 0 });
  });
});
