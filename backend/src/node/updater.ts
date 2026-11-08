/**
 * Austausch des Node-Agenten, ausgelöst vom Panel.
 *
 * Der Agent kann sich nicht selbst ersetzen: das Panel spricht über seine
 * Docker-Weiterleitung, und die reißt ab, sobald er stoppt. Deshalb startet
 * das Panel aus dem neuen Abbild einen kurzlebigen Container mit
 * MCPANEL_ROLE=node-update, der direkt am Docker-Socket der Node arbeitet:
 *
 *   alten Agenten stoppen → umbenennen → neuen anlegen und starten →
 *   auf „Bereit“ warten → alten löschen
 *
 * Kommt der neue Agent nicht hoch, wird der alte unverändert wieder gestartet –
 * eine Node darf durch ein Update nie unerreichbar werden. Die laufenden
 * Minecraft-Container bleiben in jedem Fall unberührt.
 *
 * Start: `node dist/node/updater.js`, Auftrag Base64-kodiert in UPDATE_PLAN.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export interface UpdatePlan {
  /** Name des Agent-Containers (`mcpanel-node`) */
  name: string;
  /** Rumpf für `POST /containers/create` */
  spec: Record<string, unknown>;
  /** So lange darf der neue Agent bis „Bereit“ brauchen */
  timeoutMs: number;
}

export interface DockerOps {
  stop(name: string): Promise<void>;
  start(name: string): Promise<void>;
  rename(name: string, to: string): Promise<void>;
  remove(name: string): Promise<void>;
  create(name: string, spec: Record<string, unknown>): Promise<void>;
  /** `null` = Container existiert nicht */
  state(name: string): Promise<{ running: boolean; exitCode: number } | null>;
  logs(name: string): Promise<string>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Name, unter dem der bisherige Agent während des Austauschs bereitsteht. */
export const previousName = (name: string) => `${name}-alt`;

async function waitForReady(ops: DockerOps, name: string, timeoutMs: number, wait: (ms: number) => Promise<void>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await ops.state(name);
    if (!state) throw new Error('Der neue Agent-Container ist verschwunden');
    const logs = await ops.logs(name).catch(() => '');
    if (/ABBRUCH/.test(logs)) {
      const reason = logs.split('\n').find((line) => line.includes('ABBRUCH'))?.replace(/^.*ABBRUCH:\s*/, '').trim();
      throw new Error(`Der neue Agent bricht ab${reason ? `: ${reason}` : ''}`);
    }
    if (!state.running) throw new Error(`Der neue Agent hat sich beendet (Code ${state.exitCode})`);
    if (/Bereit/.test(logs)) return;
    await wait(2000);
  }
  throw new Error(`Der neue Agent meldet sich nicht innerhalb von ${Math.round(timeoutMs / 1000)} s`);
}

/** Tauscht den Agenten aus; wirft nach einem Rückfall auf den alten Agenten. */
export async function replaceAgent(
  ops: DockerOps,
  plan: UpdatePlan,
  log: (msg: string) => void,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  const { name } = plan;
  const old = previousName(name);
  // Reste eines abgebrochenen Laufs. Läuft der Agent unter dem alten Namen
  // nicht mehr, ist der beiseitegelegte Container der einzige – dann zurückholen.
  if (await ops.state(old)) {
    if (await ops.state(name)) {
      await ops.remove(old);
    } else {
      log(`Vorheriger Agent ${old} wird zurückbenannt`);
      await ops.rename(old, name);
    }
  }
  if (!(await ops.state(name))) throw new Error(`Container ${name} nicht gefunden`);

  log('Bisheriger Agent wird gestoppt');
  await ops.stop(name);
  await ops.rename(name, old);

  try {
    log('Neuer Agent wird angelegt');
    await ops.create(name, plan.spec);
    await ops.start(name);
    await waitForReady(ops, name, plan.timeoutMs, wait);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`Fehlgeschlagen: ${reason} – bisheriger Agent wird wieder gestartet`);
    if (await ops.state(name).catch(() => null)) await ops.remove(name).catch(() => {});
    await ops.rename(old, name);
    await ops.start(name);
    throw new Error(`${reason}. Der bisherige Agent läuft wieder.`);
  }

  log('Neuer Agent ist bereit, der bisherige wird entfernt');
  await ops.remove(old).catch((err) => log(`Alter Agent ließ sich nicht entfernen: ${err instanceof Error ? err.message : err}`));
}

// ---------------------------------------------------------------------------
// Docker-API über den Socket der Node
// ---------------------------------------------------------------------------

const DOCKER_SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      socketPath: DOCKER_SOCKET,
      method,
      path,
      timeout: 60_000,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Docker antwortet nicht')));
    req.end(payload);
  });
}

async function expect(method: string, path: string, ok: number[], body?: unknown): Promise<string> {
  const response = await call(method, path, body);
  if (!ok.includes(response.status)) {
    let message = response.body.trim();
    try { message = String(JSON.parse(response.body).message ?? message); } catch { /* Klartext */ }
    throw new Error(`Docker ${method} ${path.split('?')[0]}: ${response.status} ${message}`);
  }
  return response.body;
}

const ref = (name: string) => `/containers/${encodeURIComponent(name)}`;

export const socketOps: DockerOps = {
  stop: async (name) => { await expect('POST', `${ref(name)}/stop?t=15`, [204, 304]); },
  start: async (name) => { await expect('POST', `${ref(name)}/start`, [204, 304]); },
  rename: async (name, to) => { await expect('POST', `${ref(name)}/rename?name=${encodeURIComponent(to)}`, [204]); },
  remove: async (name) => { await expect('DELETE', `${ref(name)}?force=true`, [204, 404]); },
  create: async (name, spec) => { await expect('POST', `/containers/create?name=${encodeURIComponent(name)}`, [201], spec); },
  state: async (name) => {
    const response = await call('GET', `${ref(name)}/json`);
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`Docker GET ${name}: ${response.status}`);
    const info = JSON.parse(response.body) as { State?: { Running?: boolean; ExitCode?: number } };
    return { running: Boolean(info.State?.Running), exitCode: info.State?.ExitCode ?? 0 };
  },
  // Ohne TTY kommt der Datenstrom gemultiplext; für die Suche nach
  // „Bereit“/„ABBRUCH“ stören die Rahmenköpfe nicht.
  logs: async (name) => expect('GET', `${ref(name)}/logs?stdout=1&stderr=1&tail=200`, [200]),
};

async function main(): Promise<void> {
  const log = (msg: string) => console.log(`[mcpanel-node-update] ${new Date().toISOString()} ${msg}`);
  const raw = process.env.UPDATE_PLAN;
  if (!raw) throw new Error('UPDATE_PLAN fehlt');
  const plan = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as UpdatePlan;
  // Dem Panel Zeit lassen, die Antwort auf das Starten dieses Containers noch
  // über den alten Agenten zu empfangen.
  await sleep(2000);
  await replaceAgent(socketOps, plan, log);
  log('FERTIG');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.log(`[mcpanel-node-update] FEHLER: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
