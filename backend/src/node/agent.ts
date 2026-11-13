/**
 * Node-Agent: läuft auf einem zusätzlichen Docker-Host (z. B. einem VPS oder
 * einem zweiten Rechner im Heimnetz) im selben Abbild wie das Panel,
 * gestartet mit MCPANEL_ROLE=node.
 *
 * Er ist bewusst dumm – alle Entscheidungen trifft das Panel. Er stellt nur
 * drei Dinge bereit, ausschließlich auf der Adresse, unter der das Panel ihn
 * erreicht:
 *
 *   - die Docker-API (Container anlegen, starten, Logs, Statistiken)
 *   - eine Samba-Freigabe des Datenverzeichnisses (Dateimanager, Backups …)
 *   - eine kleine Zustandsabfrage (CPU, Speicher, Platte) für die Lastverteilung
 *
 * Zwei Betriebsarten:
 *
 *   wireguard – über einen Tunnel. WireGuard authentifiziert jede
 *               Absenderadresse kryptografisch; zugelassen ist nur die
 *               Tunneladresse des Panels.
 *   direct    – im selben LAN, ohne VPN. Zugelassen sind private Adressen;
 *               die eigentliche Absicherung ist dann das Agent-Token (und
 *               das Samba-Kennwort). Der Verkehr ist unverschlüsselt.
 *
 * In beiden Fällen muss jede Verbindung zur Docker-API in ihrer ersten
 * Anfrage das Token tragen: ein Minecraft-Container auf dem Hauptserver
 * erscheint hinter NAT mit dessen Adresse und käme sonst durch.
 *
 * Start: `node dist/node/agent.js`, Profil unter NODE_CONFIG.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { promisify } from 'node:util';
import {
  AGENT_INTERNAL_PORTS,
  AGENT_TOKEN_HEADER,
  NODE_MARKER,
  SMB_SHARE,
  SMB_USER,
  nodeProfileSchema,
  parseRconPreamble,
  tokenMatches,
  type AgentStatus,
  type NodeProfile,
} from './protocol.js';

const run = promisify(execFile);
const IFACE = 'wg-mcpanel';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';
const RUN_DIR = '/run/mcpanel-node';
const VERSION = process.env.MCPANEL_VERSION || 'dev';
const PRIVATE_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8'];

const log = (msg: string) => console.log(`[mcpanel-node] ${new Date().toISOString()} ${msg}`);

function loadProfile(): NodeProfile {
  const file = process.env.NODE_CONFIG ?? '/opt/mcpanel-node/node.json';
  let raw: unknown;
  try {
    // Eine BOM (Windows-Editoren, PowerShell 5.1) ist kein Grund zum Abbruch.
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`Profil ${file} nicht lesbar: ${err instanceof Error ? err.message : err}`);
  }
  const parsed = nodeProfileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Profil ${file} ist ungültig – bitte den Installationsbefehl aus dem Panel erneut ausführen.`);
  return parsed.data;
}

const normalize = (address: string | undefined) => (address ?? '').replace(/^::ffff:/, '');

/** Linux: Host-Netz. Windows (Docker Desktop): eigenes Netz mit veröffentlichten Ports. */
const bridged = (profile: NodeProfile) => profile.platform === 'windows';

/**
 * Wo lauschen die Dienste? Im Tunnel auf der Tunneladresse. Ohne VPN unter
 * Linux auf der LAN-IP des Rechners; unter Docker Desktop gehört die LAN-IP
 * Windows, nicht dem Container – dort auf allen Adressen des Containers.
 */
const bindAddress = (profile: NodeProfile) =>
  profile.mode === 'direct' && bridged(profile) ? '0.0.0.0' : profile.nodeIp;

/** Wer darf überhaupt anklopfen? Im Tunnel nur das Panel, im LAN nur private Adressen. */
function sourceAllowed(profile: NodeProfile): (address: string | undefined) => boolean {
  if (profile.mode === 'wireguard') return (address) => normalize(address) === profile.panelIp;
  // Docker Desktop reicht veröffentlichte Ports mit eigener Absenderadresse
  // weiter – die echte Adresse im LAN ist hier nicht zu sehen. Es bleibt das Token.
  if (bridged(profile)) return () => true;
  const list = new net.BlockList();
  for (const range of PRIVATE_RANGES) {
    const [address, prefix] = range.split('/');
    list.addSubnet(address, Number(prefix), 'ipv4');
  }
  return (address) => {
    const value = normalize(address);
    return net.isIPv4(value) && list.check(value, 'ipv4');
  };
}

// ---------------------------------------------------------------------------
// WireGuard (nur im Tunnelbetrieb)
// ---------------------------------------------------------------------------

async function linkExists(): Promise<boolean> {
  return run('ip', ['link', 'show', 'dev', IFACE]).then(() => true, () => false);
}

async function setupWireGuard(profile: NodeProfile): Promise<void> {
  const keyFile = `${RUN_DIR}/wg.key`;
  await fsp.writeFile(keyFile, profile.privateKey + '\n', { mode: 0o600 });

  // Eine vorhandene Schnittstelle aus einem früheren Lauf weiterverwenden:
  // laufende Minecraft-Container haben ihren RCON-Port an diese Adresse
  // gebunden, ein Abriss würde sie kurz vom Panel trennen.
  if (await linkExists()) {
    const usable = await run('wg', ['show', IFACE]).then(() => true, () => false);
    if (!usable) await run('ip', ['link', 'del', 'dev', IFACE]).catch(() => {});
  }
  if (!(await linkExists())) {
    try {
      await run('ip', ['link', 'add', 'dev', IFACE, 'type', 'wireguard']);
      log('WireGuard aus dem Kernel');
    } catch {
      log('Kein WireGuard-Modul im Kernel – starte wireguard-go');
      await run('wireguard-go', [IFACE]);
    }
  }
  // Alte Gegenstellen (z. B. nach Neuinstallation mit neuem Panel-Schlüssel) entfernen.
  const { stdout } = await run('wg', ['show', IFACE, 'peers']).catch(() => ({ stdout: '' }));
  for (const peer of stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    if (peer !== profile.panelPublicKey) await run('wg', ['set', IFACE, 'peer', peer, 'remove']).catch(() => {});
  }
  await run('wg', [
    'set', IFACE,
    'private-key', keyFile,
    'listen-port', String(profile.listenPort),
    'peer', profile.panelPublicKey!,
    'allowed-ips', `${profile.panelIp}/32`,
  ]);
  await run('ip', ['address', 'replace', `${profile.nodeIp}/${profile.prefix}`, 'dev', IFACE]);
  await run('ip', ['link', 'set', 'mtu', '1420', 'up', 'dev', IFACE]);
  log(`Tunnel ${IFACE} bereit: ${profile.nodeIp}, lauscht auf UDP ${profile.listenPort}`);
}

/**
 * Minecraft-Container dürfen nicht in den Tunnel: sonst könnte eine Mod über
 * die Node das Panel-Netz erreichen. Antworten auf Verbindungen des Panels
 * (RCON) bleiben erlaubt.
 */
async function isolateContainers(): Promise<void> {
  const rule = ['DOCKER-USER', '-o', IFACE, '-m', 'conntrack', '!', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'DROP'];
  try {
    await run('iptables', ['-C', ...rule]).catch(async () => {
      await run('iptables', ['-N', 'DOCKER-USER']).catch(() => {});
      await run('iptables', ['-I', ...rule]);
    });
  } catch (err) {
    log(`WARNUNG: Firewallregel nicht gesetzt (${err instanceof Error ? err.message : err}) – Container könnten den Tunnel erreichen.`);
  }
}

/** Ohne VPN: lauschen geht nur auf einer Adresse, die dieser Rechner auch hat. */
function assertLocalAddress(profile: NodeProfile): void {
  const own = Object.values(os.networkInterfaces()).flat().map((entry) => entry?.address);
  if (!own.includes(profile.nodeIp)) {
    throw new Error(`Die Adresse ${profile.nodeIp} gehört nicht zu diesem Rechner (vorhanden: ${own.filter(Boolean).join(', ')}). Im Panel die LAN-IP der Node korrigieren und den Befehl neu ausführen.`);
  }
}

// ---------------------------------------------------------------------------
// Samba
// ---------------------------------------------------------------------------

let smbd: ChildProcess | null = null;
let smbRunning = false;
let stopping = false;

async function setupSamba(profile: NodeProfile): Promise<void> {
  await fsp.mkdir(`${profile.dataRoot}/servers`, { recursive: true });
  await fsp.writeFile(`${profile.dataRoot}/${NODE_MARKER}`, JSON.stringify({ nodeId: profile.nodeId }) + '\n');
  // Samba versteht Netzmasken zuverlässiger als die Präfixschreibweise.
  const allowed = profile.mode === 'wireguard'
    ? profile.panelIp!
    : '10.0.0.0/255.0.0.0 172.16.0.0/255.240.0.0 192.168.0.0/255.255.0.0 127.0.0.1';
  const bindAll = profile.mode === 'direct' && bridged(profile);
  const conf = [
    '[global]',
    '  server role = standalone server',
    '  workgroup = MCPANEL',
    // Samba übergeht Punkt-zu-Punkt-Schnittstellen wie WireGuard, wenn sie nur
    // als Adresse oder Name genannt sind – mit Netzmaske nimmt es sie an.
    ...(bindAll
      ? ['  bind interfaces only = no']
      : [`  interfaces = ${profile.mode === 'wireguard' ? `${profile.nodeIp}/${profile.prefix}` : profile.nodeIp}`, '  bind interfaces only = yes']),
    `  hosts allow = ${allowed}`,
    '  hosts deny = 0.0.0.0/0 ::/0',
    '  smb ports = 445',
    '  disable netbios = yes',
    '  server min protocol = SMB3',
    // Ohne Tunnel verschlüsselt wenigstens SMB3 selbst die Dateien auf dem Weg.
    ...(profile.mode === 'direct' ? ['  server smb encrypt = required'] : []),
    '  map to guest = never',
    '  load printers = no',
    '  printing = bsd',
    '  printcap name = /dev/null',
    '  disable spoolss = yes',
    '  log level = 1',
    '  logging = file',
    '  log file = /dev/null',
    '',
    // Das Panel schreibt als root, genau wie bei lokalen Servern; die
    // Minecraft-Container finden dieselben Rechte vor wie zu Hause.
    `[${SMB_SHARE}]`,
    `  path = ${profile.dataRoot}`,
    `  valid users = ${SMB_USER}`,
    '  force user = root',
    '  force group = root',
    '  read only = no',
    '  browseable = no',
    '  create mask = 0644',
    '  directory mask = 0755',
    '  follow symlinks = no',
    '  wide links = no',
    '  veto files = /node.json/',
    '',
  ].join('\n');
  await fsp.mkdir('/etc/samba', { recursive: true });
  await fsp.writeFile('/etc/samba/smb.conf', conf);
  await run('adduser', ['-D', '-H', '-s', '/sbin/nologin', SMB_USER]).catch(() => {});
  await new Promise<void>((resolve, reject) => {
    const child = spawn('smbpasswd', ['-a', '-s', SMB_USER], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`smbpasswd: ${stderr.trim()}`))));
    child.stdin.end(`${profile.smbPassword}\n${profile.smbPassword}\n`);
  });
  startSmbd();
}

function startSmbd(): void {
  if (stopping) return;
  const child = spawn('smbd', ['--foreground', '--no-process-group', '-s', '/etc/samba/smb.conf'], { stdio: ['ignore', 'inherit', 'inherit'] });
  smbd = child;
  smbRunning = true;
  child.on('exit', (code) => {
    smbRunning = false;
    if (stopping) return;
    log(`smbd beendet (${code}) – Neustart in 5 s`);
    setTimeout(startSmbd, 5000).unref();
  });
  child.on('error', (err) => log(`smbd nicht startbar: ${err.message}`));
}

// ---------------------------------------------------------------------------
// Docker-API und Zustandsabfrage
// ---------------------------------------------------------------------------

/** Kopfzeilen der ersten Anfrage einer Verbindung lesen (höchstens 16 KiB). */
function headerValue(head: string, name: string): string | null {
  for (const line of head.split('\r\n').slice(1)) {
    const index = line.indexOf(':');
    if (index > 0 && line.slice(0, index).trim().toLowerCase() === name) return line.slice(index + 1).trim();
  }
  return null;
}

function startDockerProxy(profile: NodeProfile, allowed: (address: string | undefined) => boolean): net.Server {
  const server = net.createServer((client) => {
    if (!allowed(client.remoteAddress)) {
      client.destroy();
      return;
    }
    // Die erste Anfrage muss das Token tragen; danach ist die Verbindung
    // geprüft und wird roh durchgereicht (Logs, Attach, Keep-Alive).
    let buffered = Buffer.alloc(0);
    const timeout = setTimeout(() => client.destroy(), 10_000);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffered.length > 16 * 1024) client.destroy();
        return;
      }
      const head = buffered.subarray(0, end).toString('latin1');
      // Kleinen Rumpf der ersten Anfrage abwarten und mit den Kopfzeilen in
      // einem Stück weiterreichen. Sonst schaltet Docker bei Attach (Hijack)
      // schon auf stdin um und liest den JSON-Rumpf als Eingabe in die
      // Serverkonsole – über den lokalen Socket kommt beides zusammen an.
      const length = Number(headerValue(head, 'content-length') ?? 0);
      if (length > 0 && length <= 64 * 1024 && buffered.length < end + 4 + length) return;
      client.removeListener('data', onData);
      clearTimeout(timeout);
      if (!tokenMatches(profile.token, headerValue(head, AGENT_TOKEN_HEADER))) {
        client.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
      const upstream = net.createConnection(DOCKER_SOCKET);
      const close = () => { client.destroy(); upstream.destroy(); };
      upstream.on('error', close);
      client.on('error', close);
      upstream.on('close', close);
      client.on('close', close);
      upstream.write(buffered);
      client.pipe(upstream).pipe(client);
    };
    client.on('data', onData);
    client.on('error', () => client.destroy());
  });
  server.listen(AGENT_INTERNAL_PORTS.docker, bindAddress(profile), () => log(`Docker-API auf ${bindAddress(profile)}:${AGENT_INTERNAL_PORTS.docker}`));
  return server;
}

function dockerVersion(): Promise<string> {
  return new Promise((resolve) => {
    const req = http.get({ socketPath: DOCKER_SOCKET, path: '/version', timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(String(JSON.parse(body).Version ?? '')); } catch { resolve(''); }
      });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

async function memInfo(): Promise<{ total: number; available: number }> {
  try {
    const raw = await fsp.readFile('/proc/meminfo', 'utf8');
    const value = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(raw)?.[1] ?? 0) / 1024;
    return { total: Math.round(value('MemTotal')), available: Math.round(value('MemAvailable')) };
  } catch {
    return { total: Math.round(os.totalmem() / 1048576), available: Math.round(os.freemem() / 1048576) };
  }
}

async function collectStatus(profile: NodeProfile): Promise<AgentStatus> {
  const [mem, disk, docker] = await Promise.all([
    memInfo(),
    fsp.statfs(profile.dataRoot).catch(() => null),
    dockerVersion(),
  ]);
  const load = os.loadavg();
  return {
    nodeId: profile.nodeId,
    version: VERSION,
    hostname: os.hostname(),
    kernel: os.release(),
    uptimeSec: Math.round(os.uptime()),
    cpus: os.cpus().length,
    load: [load[0], load[1], load[2]].map((v) => Math.round(v * 100) / 100) as [number, number, number],
    memTotalMb: mem.total,
    memAvailableMb: mem.available,
    diskTotalMb: disk ? Math.round((disk.blocks * disk.bsize) / 1048576) : 0,
    diskFreeMb: disk ? Math.round((disk.bavail * disk.bsize) / 1048576) : 0,
    dockerVersion: docker,
    smb: smbRunning,
  };
}

function startStatusServer(profile: NodeProfile, allowed: (address: string | undefined) => boolean): http.Server {
  const server = http.createServer((req, res) => {
    if (!allowed(req.socket.remoteAddress)) {
      req.socket.destroy();
      return;
    }
    if (!tokenMatches(profile.token, req.headers[AGENT_TOKEN_HEADER] as string | undefined)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'GET' || req.url !== '/status') {
      res.writeHead(404).end();
      return;
    }
    collectStatus(profile).then(
      (status) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(status)),
      (err) => res.writeHead(500).end(String(err)),
    );
  });
  server.listen(AGENT_INTERNAL_PORTS.status, bindAddress(profile), () => log(`Zustandsabfrage auf ${bindAddress(profile)}:${AGENT_INTERNAL_PORTS.status}`));
  return server;
}

// ---------------------------------------------------------------------------
// RCON-Weiterleitung
// ---------------------------------------------------------------------------

/** Adresse eines Panel-Containers im Minecraft-Netz der Node. */
function containerAddress(profile: NodeProfile, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: DOCKER_SOCKET, path: `/containers/${encodeURIComponent(name)}/json`, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error(`Container ${name} nicht gefunden`);
          const info = JSON.parse(body) as {
            Config?: { Labels?: Record<string, string> };
            NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
          };
          // Nur Container, die das Panel angelegt hat – kein Sprungbrett zu beliebigen Diensten.
          if (!info.Config?.Labels?.['mcpanel.server']) throw new Error(`${name} ist kein Panel-Container`);
          const ip = info.NetworkSettings?.Networks?.[profile.dockerNetwork]?.IPAddress;
          if (!ip) throw new Error(`${name} hängt nicht im Netz ${profile.dockerNetwork}`);
          resolve(ip);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Docker antwortet nicht')); });
  });
}

/**
 * RCON der Minecraft-Server wird nirgends veröffentlicht. Das Panel verbindet
 * sich hierher, nennt in der ersten Zeile Token und Container, und der Agent
 * reicht die Verbindung an Port 25575 des Containers durch.
 */
function startRconProxy(profile: NodeProfile, allowed: (address: string | undefined) => boolean): net.Server {
  const server = net.createServer((client) => {
    if (!allowed(client.remoteAddress)) {
      client.destroy();
      return;
    }
    let buffered = Buffer.alloc(0);
    const timeout = setTimeout(() => client.destroy(), 10_000);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\n');
      if (end < 0) {
        if (buffered.length > 512) client.destroy();
        return;
      }
      client.removeListener('data', onData);
      client.pause();
      const request = parseRconPreamble(buffered.subarray(0, end).toString('utf8'));
      const rest = buffered.subarray(end + 1);
      if (!request || !tokenMatches(profile.token, request.token)) {
        clearTimeout(timeout);
        log(`RCON-Verbindung von ${normalize(client.remoteAddress)} abgelehnt: ${request ? 'falsches Token' : 'ungültige erste Zeile'}`);
        client.destroy();
        return;
      }
      containerAddress(profile, request.container).then((ip) => {
        clearTimeout(timeout);
        // Hat das Panel inzwischen aufgelegt, keine Verbindung zum Server
        // öffnen – niemand würde sie je wieder schließen.
        if (client.destroyed) return;
        const upstream = net.createConnection({ host: ip, port: 25575 });
        const close = () => { client.destroy(); upstream.destroy(); };
        upstream.on('error', (err) => {
          log(`RCON zu ${request.container.slice(0, 32)} (${ip}:25575) gescheitert: ${err.message}`);
          close();
        });
        client.on('error', close);
        upstream.on('close', close);
        client.on('close', close);
        upstream.once('connect', () => {
          if (rest.length) upstream.write(rest);
          client.pipe(upstream).pipe(client);
          client.resume();
        });
      }, (err) => {
        clearTimeout(timeout);
        log(`RCON-Weiterleitung abgelehnt: ${err instanceof Error ? err.message : err}`);
        client.destroy();
      });
    };
    client.on('data', onData);
    client.on('error', () => client.destroy());
  });
  server.listen(AGENT_INTERNAL_PORTS.rcon, bindAddress(profile), () => log(`RCON-Weiterleitung auf ${bindAddress(profile)}:${AGENT_INTERNAL_PORTS.rcon}`));
  return server;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const profile = loadProfile();
  log(`MCPanel-Node „${profile.name}“ (${VERSION}, ${profile.platform === 'windows' ? 'Docker Desktop' : 'Linux'}) startet – ${profile.mode === 'wireguard' ? 'über WireGuard' : 'im selben Netz ohne VPN'}`);
  await fsp.mkdir(RUN_DIR, { recursive: true, mode: 0o700 });
  await fsp.rm(`${RUN_DIR}/ready`, { force: true });
  if (profile.mode === 'wireguard') {
    await setupWireGuard(profile);
    // Im Host-Netz könnten Container über die Node in den Tunnel; unter Docker
    // Desktop lebt der Tunnel im Agent-Container, dort kommt keiner hin.
    if (!bridged(profile)) await isolateContainers();
  } else if (!bridged(profile)) {
    assertLocalAddress(profile);
  }
  await setupSamba(profile);
  const allowed = sourceAllowed(profile);
  const servers: net.Server[] = [startDockerProxy(profile, allowed), startStatusServer(profile, allowed), startRconProxy(profile, allowed)];
  await fsp.writeFile(`${RUN_DIR}/ready`, new Date().toISOString());
  log('Bereit – wartet auf das Panel');

  const shutdown = () => {
    stopping = true;
    log('Fahre herunter');
    for (const server of servers) server.close();
    smbd?.kill('SIGTERM');
    // Die Schnittstelle bleibt stehen: laufende Minecraft-Server sind an
    // ihre Adresse gebunden, und ein Neustart des Agenten übernimmt sie.
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log(`ABBRUCH: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
