import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  servers: [] as any[],
  proxy: { enabled: false, port: 25565 },
}));
vi.mock('./settings.js', () => ({
  getSetting: async (key: string, fallback = '') => m.settings.get(key) ?? fallback,
  setSetting: async (key: string, value: string) => { m.settings.set(key, value); },
}));
vi.mock('./proxy.js', () => ({ getProxyConfig: async () => m.proxy }));
vi.mock('../db.js', () => ({ prisma: { server: { findMany: async () => m.servers } } }));

const unifi = await import('./unifi.js');
const { setNodeLocation } = await import('../lib/serverLocation.js');
const { planRules, rulePorts, ruleName, EMPTY_CONFIG } = unifi;
type UnifiConfig = import('./unifi.js').UnifiConfig;
type Rule = import('./unifi.js').PortForwardRule;

const own = (port: number, extra: Partial<Rule> = {}): Rule => ({
  _id: `r${port}`, name: `MCPanel Welt ${port}`, enabled: true, pfwd_interface: 'wan',
  dst_port: String(port), fwd: '192.168.1.10', fwd_port: String(port), proto: 'udp', ...extra,
});

describe('planRules', () => {
  const want = (port: number, protocol: 'tcp' | 'udp' | 'tcp_udp' = 'udp') =>
    ({ name: `MCPanel Welt ${port}`, port, protocol, ip: '192.168.1.10' });

  it('legt fehlende an, passt abweichende an und entfernt verwaiste eigene Regeln', () => {
    const plan = planRules(
      [own(24454), own(19132, { fwd: '192.168.1.99' }), own(8100), { _id: 'x', name: 'NAS', enabled: true, dst_port: '443', fwd: '192.168.1.2', fwd_port: '443', proto: 'tcp' }],
      [want(24454), want(19132), want(24455)],
      'wan',
    );
    expect(plan.create.map((r) => r.port)).toEqual([24455]);
    expect(plan.update.map((u) => u.existing._id)).toEqual(['r19132']);
    expect(plan.remove.map((r) => r._id)).toEqual(['r8100']);
    expect(plan.conflicts).toEqual([]);
  });

  it('fasst fremde Regeln nie an und meldet belegte Ports – auch in Bereichen', () => {
    const foreign: Rule = { _id: 'f', name: 'Spielekonsole', enabled: true, dst_port: '24000-25000', fwd: '192.168.1.50', fwd_port: '24000-25000', proto: 'tcp_udp' };
    const plan = planRules([foreign], [want(24454), want(8100, 'tcp')], 'wan');
    expect(plan.conflicts.map((c) => c.desired.port)).toEqual([24454]);
    expect(plan.create.map((r) => r.port)).toEqual([8100]);
    expect(plan.remove).toEqual([]);
  });

  it('ignoriert deaktivierte fremde Regeln und anderes Protokoll', () => {
    const plan = planRules([
      { _id: 'a', name: 'Alt', enabled: false, dst_port: '24454', fwd: '1.1.1.1', fwd_port: '1', proto: 'udp' },
      { _id: 'b', name: 'Web', enabled: true, dst_port: '8100', fwd: '1.1.1.1', fwd_port: '1', proto: 'udp' },
    ], [want(24454), want(8100, 'tcp')], 'wan');
    expect(plan.create.map((r) => r.port)).toEqual([24454, 8100]);
  });

  it('erkennt einen Wechsel der WAN-Schnittstelle als Änderung', () => {
    expect(planRules([own(24454)], [want(24454)], 'both').update).toHaveLength(1);
    expect(planRules([own(24454)], [want(24454)], 'wan').update).toHaveLength(0);
  });

  it('rulePorts versteht Einzelports, Bereiche und Listen', () => {
    const has = rulePorts('80, 443,8000-8100');
    expect([80, 443, 8050, 8100, 8101, 81].map(has)).toEqual([true, true, true, true, false, false]);
  });

  it('ruleName setzt das Präfix und entfernt Sonderzeichen', () => {
    expect(ruleName('Freunde <Survival>', 'Simple Voice Chat')).toBe('MCPanel Freunde Survival Simple Voice Chat');
    expect(ruleName('x'.repeat(80), 'y').length).toBeLessThanOrEqual(64);
  });
});

describe('desiredRules', () => {
  const config = { ...EMPTY_CONFIG, enabled: true, forwardIp: '192.168.1.10' };
  const port = (hostPort: number, extra = {}) => ({ hostPort, label: 'Sprachchat', protocol: 'udp', forward: true, ...extra });

  it('leitet Zusatzports auf den Hauptserver und LAN-Nodes weiter, VPS-Nodes nicht', async () => {
    setNodeLocation({ id: 'lan', name: 'Keller-PC', tunnelIp: '192.168.1.20', agentToken: 't', publicHost: '192.168.1.20', dataRoot: '/d', ports: {} as any, dataVolume: null });
    setNodeLocation({ id: 'vps', name: 'VPS', tunnelIp: '10.66.0.2', agentToken: 't', publicHost: '203.0.113.5', dataRoot: '/d', ports: {} as any, dataVolume: null });
    m.servers = [
      { id: 'a', name: 'Haupt', port: 25565, directConnect: true, nodeId: null, extraPorts: [port(24454), port(8100, { forward: false })] },
      { id: 'b', name: 'Keller', port: 25566, directConnect: true, nodeId: 'lan', extraPorts: [port(24455)] },
      { id: 'c', name: 'Miete', port: 25567, directConnect: true, nodeId: 'vps', extraPorts: [port(24456)] },
    ];
    const result = await unifi.desiredRules(config);
    expect(result.rules.map((r) => [r.port, r.ip])).toEqual([[24454, '192.168.1.10'], [24455, '192.168.1.20']]);
    expect(result.skipped).toEqual([{ name: 'MCPanel Miete Sprachchat', reason: 'Node VPS steht nicht im Heimnetz (203.0.113.5)' }]);
  });

  it('nimmt auf Wunsch Spielports und den Proxy dazu', async () => {
    m.servers = [
      { id: 'a', name: 'Direkt', port: 25565, directConnect: true, nodeId: null, extraPorts: [] },
      { id: 'b', name: 'NurProxy', port: 25566, directConnect: false, nodeId: null, extraPorts: [] },
    ];
    m.proxy = { enabled: true, port: 25565 };
    const result = await unifi.desiredRules({ ...config, forwardGamePorts: true });
    // Spielport und Proxy liegen hier auf demselben Port – nur eine Regel.
    expect(result.rules).toEqual([{ name: 'MCPanel Direkt Spiel', port: 25565, protocol: 'tcp_udp', ip: '192.168.1.10' }]);
    m.proxy = { enabled: false, port: 25565 };
  });

  it('meldet fehlende Ziel-IP statt still nichts zu tun', async () => {
    m.servers = [{ id: 'a', name: 'Haupt', port: 25565, directConnect: true, nodeId: null, extraPorts: [port(24454)] }];
    const result = await unifi.desiredRules({ ...config, forwardIp: '' });
    expect(result.rules).toEqual([]);
    expect(result.skipped[0].reason).toContain('Ziel-IP');
  });
});

// ---------------------------------------------------------------------------
// Gegen eine nachgebaute Konsole über echtes HTTPS mit selbstsigniertem Zertifikat
// ---------------------------------------------------------------------------

let hasOpenssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { hasOpenssl = false; }

describe.skipIf(!hasOpenssl)('UniFi-Konsole über HTTPS', () => {
  let server: https.Server;
  let url: string;
  let fingerprint: string;
  const requests: { method: string; url: string; headers: Record<string, unknown>; body: string }[] = [];
  let rules: Rule[] = [];
  let loginStatus = 200;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-unifi-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=unifi.local',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    const cert = fs.readFileSync(path.join(dir, 'cert.pem'));
    const key = fs.readFileSync(path.join(dir, 'key.pem'));
    fs.rmSync(dir, { recursive: true, force: true });
    fingerprint = new crypto.X509Certificate(cert).fingerprint256;

    server = https.createServer({ cert, key }, (req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        const json = (status: number, data: unknown, headers: Record<string, string | string[]> = {}) => {
          res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
          res.end(JSON.stringify(data));
        };
        if (req.url === '/api/auth/login') {
          if (loginStatus === 499) return json(499, { meta: { rc: 'error', msg: 'api.err.Ubic2faTokenRequired' } });
          const creds = JSON.parse(body);
          if (creds.username !== 'panel' || creds.password !== 'geheim') return json(401, { meta: { rc: 'error' } });
          return json(200, {}, { 'Set-Cookie': ['TOKEN=sitzung; Path=/; HttpOnly'], 'X-CSRF-Token': 'csrf-1' });
        }
        const viaKey = req.headers['x-api-key'] === 'schluessel';
        const viaCookie = String(req.headers.cookie ?? '').includes('TOKEN=sitzung');
        if (!viaKey && !viaCookie) return json(401, { meta: { rc: 'error', msg: 'api.err.LoginRequired' } });
        if (req.method !== 'GET' && viaCookie && req.headers['x-csrf-token'] !== 'csrf-1') return json(403, { meta: { rc: 'error' } });
        const base = '/proxy/network/api/s/default/rest/portforward';
        if (req.url === base && req.method === 'GET') return json(200, { meta: { rc: 'ok' }, data: rules });
        if (req.url === base && req.method === 'POST') {
          const rule = { ...JSON.parse(body), _id: `neu${rules.length}` };
          rules.push(rule);
          return json(200, { meta: { rc: 'ok' }, data: [rule] });
        }
        const id = decodeURIComponent(String(req.url).slice(base.length + 1));
        if (req.method === 'PUT') {
          rules = rules.map((rule) => (rule._id === id ? { ...JSON.parse(body), _id: id } : rule));
          return json(200, { meta: { rc: 'ok' }, data: [] });
        }
        if (req.method === 'DELETE') {
          rules = rules.filter((rule) => rule._id !== id);
          return json(200, { meta: { rc: 'ok' }, data: [] });
        }
        json(404, {});
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(async () => {
    requests.length = 0;
    rules = [];
    loginStatus = 200;
    m.servers = [{ id: 'a', name: 'Welt', port: 25565, directConnect: true, nodeId: null,
      extraPorts: [{ hostPort: 24454, label: 'Simple Voice Chat', protocol: 'udp', forward: true }] }];
  });

  const config = (extra: Partial<UnifiConfig> = {}): UnifiConfig => ({
    ...EMPTY_CONFIG, enabled: true, url, auth: 'apikey', apiKey: 'schluessel', fingerprint, forwardIp: '192.168.1.10', ...extra,
  });

  it('liefert beim Test ohne bestätigten Fingerabdruck nur diesen – ohne den Schlüssel zu senden', async () => {
    const result = await unifi.testUnifi(config({ fingerprint: '' }));
    expect(result).toMatchObject({ ok: false, fingerprint });
    expect(requests).toEqual([]);
    expect(await unifi.testUnifi(config())).toMatchObject({ ok: true, rules: 0 });
    expect(requests[0].headers['x-api-key']).toBe('schluessel');
  });

  it('bricht bei geändertem Zertifikat ab, bevor eine Anfrage die Konsole erreicht', async () => {
    await unifi.saveUnifiConfig(config({ fingerprint: `AA${fingerprint.slice(2)}` }));
    const status = await unifi.syncUnifi();
    expect(status?.ok).toBe(false);
    expect(status?.error).toContain('Zertifikat');
    expect(requests).toEqual([]);
  });

  it('legt Weiterleitungen mit API-Schlüssel an, räumt eigene auf und lässt fremde stehen', async () => {
    rules = [
      { _id: 'alt', name: 'MCPanel Gelöscht Karte', enabled: true, pfwd_interface: 'wan', dst_port: '8100', fwd: '192.168.1.10', fwd_port: '8100', proto: 'tcp' },
      { _id: 'nas', name: 'NAS', enabled: true, pfwd_interface: 'wan', dst_port: '443', fwd: '192.168.1.2', fwd_port: '443', proto: 'tcp' },
    ];
    await unifi.saveUnifiConfig(config());
    const status = await unifi.syncUnifi();
    expect(status).toMatchObject({ ok: true, created: 1, updated: 0, removed: 1 });
    expect(rules.map((rule) => rule.name).sort()).toEqual(['MCPanel Welt Simple Voice Chat', 'NAS']);
    expect(rules.find((rule) => rule.name.startsWith('MCPanel'))).toMatchObject({
      enabled: true, dst_port: '24454', fwd: '192.168.1.10', fwd_port: '24454', proto: 'udp', pfwd_interface: 'wan', src: 'any',
    });
    // Zweiter Lauf: nichts mehr zu tun.
    requests.length = 0;
    expect(await unifi.syncUnifi()).toMatchObject({ ok: true, created: 0, updated: 0, removed: 0 });
    expect(requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('meldet einen abgelehnten API-Schlüssel verständlich', async () => {
    await unifi.saveUnifiConfig(config({ apiKey: 'falsch' }));
    const status = await unifi.syncUnifi();
    expect(status?.error).toContain('API-Schlüssel wurde abgelehnt');
  });

  it('meldet sich mit lokalem Benutzer an und schickt das CSRF-Token bei Änderungen mit', async () => {
    await unifi.saveUnifiConfig(config({ auth: 'login', apiKey: '', username: 'panel', password: 'geheim' }));
    expect(await unifi.syncUnifi()).toMatchObject({ ok: true, created: 1 });
    const post = requests.find((r) => r.method === 'POST' && r.url.includes('portforward'))!;
    expect(post.headers['x-csrf-token']).toBe('csrf-1');
    expect(post.headers['x-api-key']).toBeUndefined();
    expect(requests.filter((r) => r.url === '/api/auth/login')).toHaveLength(1);
  });

  it('erklärt, dass Konten mit zweitem Faktor nicht gehen', async () => {
    loginStatus = 499;
    await unifi.saveUnifiConfig(config({ auth: 'login', apiKey: '', username: 'panel', password: 'geheim' }));
    expect((await unifi.syncUnifi())?.error).toContain('zweiten Faktor');
  });

  it('entfernt beim Abschalten nur die eigenen Regeln', async () => {
    rules = [own(24454), { _id: 'nas', name: 'NAS', enabled: true, dst_port: '443', fwd: '192.168.1.2', fwd_port: '443', proto: 'tcp' }];
    expect(await unifi.removeAllRules(config())).toBe(1);
    expect(rules.map((rule) => rule._id)).toEqual(['nas']);
  });

  it('gibt Geheimnisse nie an die Oberfläche', () => {
    const shown = unifi.publicUnifiConfig(config({ password: 'pw' }));
    expect(JSON.stringify(shown)).not.toContain('schluessel');
    expect(JSON.stringify(shown)).not.toContain('"pw"');
    expect(shown).toMatchObject({ hasApiKey: true, hasPassword: true });
  });
});
