// Ende-zu-Ende-Prüfung gegen ein frisch gestartetes Panel mit leerer Datenbank.
//
// Läuft in der CI gegen das gerade gebaute Abbild, bevor es veröffentlicht
// wird, und lokal gegen einen Wegwerf-Container – NIE gegen ein produktives
// Panel: das Skript richtet das Panel ein, legt Konten und einen Server an.
//
//   E2E_BASE=http://localhost:18089 E2E_SETUP_CODE=XXXX-XXXX-XXXX node scripts/e2e.mjs
//
// Den Einrichtungscode schreibt das Panel beim ersten Start ins Protokoll und
// nach <data>/.setup-code.
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const BASE = process.env.E2E_BASE ?? 'http://localhost:18089';
const SETUP_CODE = process.env.E2E_SETUP_CODE;
if (!SETUP_CODE) {
  console.error('E2E_SETUP_CODE fehlt (Einrichtungscode aus dem Containerprotokoll).');
  process.exit(2);
}
const rnd = () => crypto.randomBytes(9).toString('base64url');
const ADMIN = { username: 'e2e-admin', email: 'e2e-admin@example.test', password: 'Pw-' + rnd() };
const FRIEND = { username: 'e2e-freund', email: 'e2e-freund@example.test', password: 'Pw-' + rnd() };

let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'OK  ' : 'FEHL'} ${label}${extra ? ' – ' + extra : ''}`);
  if (!cond) failures++;
};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function api(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined && !raw) headers['content-type'] = 'application/json';
  const send = () => fetch(BASE + '/api' + path, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  let res = await send();
  // Anmeldungen sind auf 8 je Minute gebremst; das Skript braucht ein paar mehr.
  if (res.status === 429) {
    console.log('     (Anmeldebremse – eine Minute warten)');
    await sleep(61_000);
    res = await send();
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* binär */ }
  return { status: res.status, json, text, headers: res.headers };
}

// --- TOTP wie eine Authenticator-App ---
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(s) {
  let bits = 0, value = 0; const out = [];
  for (const c of s.replace(/=+$/, '')) { value = (value << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function totp(secret, offsetSteps = 0) {
  const counter = Math.floor(Date.now() / 30000) + offsetSteps;
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const d = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
  const o = d[d.length - 1] & 15;
  return String((d.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

/** Minimales ZIP ohne Kompression – reicht für den Welt-Upload. */
function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

async function upload(path, token, filename, data) {
  const body = new FormData();
  body.append('file', new Blob([data]), filename);
  const res = await fetch(`${BASE}/api${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* kein JSON */ }
  return { status: res.status, json };
}

async function listBackups(token, serverId) {
  const res = (await api('GET', `/servers/${serverId}/backups`, { token })).json;
  return Array.isArray(res) ? res : res?.backups ?? [];
}

async function waitTask(token, serverId, taskId) {
  for (let i = 0; i < 120; i++) {
    const r = await api('GET', `/servers/${serverId}/tasks?limit=20`, { token });
    const list = Array.isArray(r.json) ? r.json : r.json?.tasks ?? [];
    const t = list.find((x) => x.id === taskId);
    if (t && t.status !== 'RUNNING') return t;
    await new Promise((res) => setTimeout(res, 500));
  }
  return null;
}

// 1) Einrichtung mit Code
const status = await api('GET', '/setup/status');
ok(status.json?.needsSetup === true && status.json?.setupCodeRequired === true, 'Assistent verlangt Einrichtungscode');
ok((await api('POST', '/setup', { body: { ...ADMIN } })).status === 403, 'Einrichtung ohne Code abgelehnt');
ok((await api('POST', '/setup', { body: { ...ADMIN, setupCode: 'AAAA-BBBB-CCCC' } })).status === 403, 'Einrichtung mit falschem Code abgelehnt');
const setup = await api('POST', '/setup', { body: { ...ADMIN, setupCode: SETUP_CODE.toLowerCase().replace(/-/g, '') } });
ok(setup.status === 201, 'Einrichtung mit Code (klein, ohne Bindestriche)', String(setup.status));
let admin = setup.json.token;
ok((await api('POST', '/setup', { body: { ...ADMIN, username: 'zweiter', setupCode: SETUP_CODE } })).status === 403, 'zweite Einrichtung gesperrt');

// 2) Konten
const friendRes = await api('POST', '/users', { token: admin, body: FRIEND });
ok(friendRes.status === 201 || friendRes.status === 200, 'Freundeskonto angelegt', String(friendRes.status));
const friendId = friendRes.json?.id ?? friendRes.json?.user?.id;
let friend = (await api('POST', '/auth/login', { body: { login: FRIEND.username, password: FRIEND.password } })).json.token;
ok(Boolean(friend), 'Freund kann sich anmelden');
ok((await api('POST', '/servers', { token: friend, body: { name: 'Fremd' } })).status === 403, 'Nicht-Admin darf keinen Server anlegen');

// 3) Server anlegen (ohne Start)
const created = await api('POST', '/servers', { token: admin, body: { name: 'E2E Welt', type: 'VANILLA', mcVersion: '1.21.1', memoryMb: 1024 } });
ok(created.status === 201 || created.status === 200, 'Server angelegt', String(created.status) + ' ' + (created.json?.error ?? ''));
const serverId = created.json?.id ?? created.json?.server?.id;

// 4) Datei-Upload und Kontingent
const form = new FormData();
form.append('file', new Blob([Buffer.alloc(64 * 1024, 7)]), 'probe.bin');
const up = await fetch(`${BASE}/api/servers/${serverId}/files/upload?path=/`, { method: 'POST', headers: { authorization: `Bearer ${admin}` }, body: form });
ok(up.status === 200, 'Upload gespeichert', String(up.status));
const listing = await api('GET', `/servers/${serverId}/files?path=/`, { token: admin });
const entries = Array.isArray(listing.json) ? listing.json : listing.json?.entries ?? [];
ok(entries.some((e) => e.name === 'probe.bin'), 'Hochgeladene Datei sichtbar');
ok(!entries.some((e) => /^\.(sftp-)?upload-/.test(e.name)), 'keine Upload-Temp-Ordner übrig');
await api('PUT', `/servers/${serverId}/files/content`, { token: admin, body: { path: '/welt.txt', content: 'Stand A' } });

// 5) Backups: anlegen, anheften, einspielen mit Sicherheitskopie
const b1 = await api('POST', `/servers/${serverId}/backups`, { token: admin, body: { name: 'Stand A' } });
ok(b1.status === 200, 'Backup gestartet', b1.json?.error ?? '');
const t1 = await waitTask(admin, serverId, b1.json?.taskId);
ok(t1?.status === 'DONE', 'Backup fertig', t1?.error ?? t1?.status ?? 'keine Aufgabe gefunden');
let backups = (await api('GET', `/servers/${serverId}/backups`, { token: admin })).json;
backups = Array.isArray(backups) ? backups : backups?.backups ?? [];
const stateA = backups.find((b) => b.name === 'Stand A');
ok(stateA?.origin === 'MANUAL', 'Herkunft MANUAL', stateA?.origin);
const pin = await api('PATCH', `/servers/${serverId}/backups/${stateA?.id}`, { token: admin, body: { pinned: true } });
ok(pin.json?.pinned === true, 'Backup angeheftet');

await api('PUT', `/servers/${serverId}/files/content`, { token: admin, body: { path: '/welt.txt', content: 'Stand B' } });
const r1 = await api('POST', `/servers/${serverId}/backups/${stateA?.id}/restore`, { token: admin, body: {} });
const rt = await waitTask(admin, serverId, r1.json?.taskId);
ok(rt?.status === 'DONE', 'Wiederherstellung fertig', rt?.error ?? rt?.status ?? '');
const content = await api('GET', `/servers/${serverId}/files/content?path=/welt.txt`, { token: admin });
ok((content.json?.content ?? content.text).includes('Stand A'), 'Datei auf Stand A zurück');
backups = (await api('GET', `/servers/${serverId}/backups`, { token: admin })).json;
backups = Array.isArray(backups) ? backups : backups?.backups ?? [];
ok(backups.some((b) => b.origin === 'SAFETY'), 'Sicherheitskopie vor dem Einspielen angelegt');
ok(!entries.some((e) => /^\.(sftp-)?upload-/.test(e.name)), 'Backups ohne Upload-Temp');

// 6) Downloads nur mit Kurzzeit-Token
const dlPath = `/api/servers/${serverId}/backups/${stateA?.id}/download`;
const sessionInQuery = await fetch(`${BASE}${dlPath}?token=${admin}`);
ok(sessionInQuery.status === 401, 'Sitzungs-Token in der URL abgelehnt', String(sessionInQuery.status));
const dlt = (await api('POST', '/auth/download-token', { token: admin, body: { path: dlPath } })).json?.token;
const dl = await fetch(`${BASE}${dlPath}?token=${dlt}`);
const dlBody = Buffer.from(await dl.arrayBuffer());
ok(dl.status === 200 && dlBody[0] === 0x1f && dlBody[1] === 0x8b, 'Backup-Download mit Kurzzeit-Token (gzip)', String(dl.status));
const otherPath = `/api/servers/${serverId}/files/download?path=%2Fwelt.txt`;
ok((await fetch(`${BASE}${otherPath}&token=${dlt}`)).status === 401, 'Download-Token gilt nicht für andere Pfade');
const ft = (await api('POST', '/auth/download-token', { token: admin, body: { path: '/api/servers/' + serverId + '/files/download?path=/welt.txt' } })).json?.token;
const fdl = await fetch(`${BASE}${otherPath}&token=${ft}`);
ok(fdl.status === 200 && (await fdl.text()) === 'Stand A', 'Datei-Download mit gebundenem Token (andere Kodierung)', String(fdl.status));
ok(/filename\*=UTF-8''/.test(fdl.headers.get('content-disposition') ?? ''), 'Content-Disposition mit filename*');

// 7) Besitzer übertragen
ok((await api('POST', `/servers/${serverId}/owner`, { token: friend, body: { userId: friendId } })).status === 404, 'Fremder Server bleibt für Nicht-Mitglied unsichtbar');
const tr = await api('POST', `/servers/${serverId}/owner`, { token: admin, body: { userId: friendId, keepPreviousOwner: true } });
ok(tr.status === 200 && tr.json?.owner?.username === FRIEND.username, 'Besitzer übertragen', tr.json?.error ?? '');
const members = await api('GET', `/servers/${serverId}/members`, { token: admin });
ok(members.json?.owner?.id === friendId, 'neuer Besitzer in der Mitgliederliste');
ok((members.json?.members ?? []).some((mm) => mm.user?.username === ADMIN.username), 'Altbesitzer bleibt Mitglied');
const friendServers = await api('GET', '/servers', { token: friend });
const fsList = Array.isArray(friendServers.json) ? friendServers.json : friendServers.json?.servers ?? [];
ok(fsList.some((s) => s.id === serverId), 'Freund sieht den übernommenen Server');
const own = await api('POST', `/servers/${serverId}/owner`, { token: friend, body: { userId: friendId } });
ok(own.status === 403, 'Besitzer ohne Adminrolle darf nicht weiter übertragen', String(own.status));
ok((await api('DELETE', `/users/${friendId}`, { token: admin })).status >= 400, 'Konto mit Server kann nicht gelöscht werden');

// 8) Zwei-Faktor
const ts = await api('POST', '/auth/totp/setup', { token: friend });
ok(Boolean(ts.json?.secret) && ts.json?.url?.startsWith('otpauth://'), 'TOTP-Einrichtung liefert Geheimnis');
ok((await api('POST', '/auth/totp/enable', { token: friend, body: { code: '000000' } })).status >= 400, 'falscher Code aktiviert nicht');
const en = await api('POST', '/auth/totp/enable', { token: friend, body: { code: totp(ts.json.secret) } });
ok(en.status === 200 && Boolean(en.json?.token), 'TOTP aktiviert, neues Token', en.json?.error ?? '');
ok((await api('GET', '/auth/me', { token: friend })).status === 401, 'altes Token nach Aktivierung ungültig');
friend = en.json.token;
const recoveryCodes = en.json?.recoveryCodes ?? [];
ok(recoveryCodes.length === 10 && recoveryCodes.every((c) => /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(c)), 'zehn Wiederherstellungscodes beim Aktivieren');
const me = (await api('GET', '/auth/me', { token: friend })).json;
ok(me?.totpEnabled === true && me?.recoveryCodesLeft === 10, 'me meldet totpEnabled und 10 Codes');
const l1 = await api('POST', '/auth/login', { body: { login: FRIEND.username, password: FRIEND.password } });
ok(l1.json?.mfaRequired === true && !l1.json?.token, 'Anmeldung verlangt zweiten Faktor');
ok((await api('GET', '/auth/me', { token: l1.json.mfaToken })).status === 401, 'MFA-Zwischentoken ist keine Sitzung');
ok((await api('POST', '/auth/login/totp', { body: { mfaToken: l1.json.mfaToken, code: '123456' } })).status === 401, 'falscher Code abgelehnt');
const l2 = await api('POST', '/auth/login/totp', { body: { mfaToken: l1.json.mfaToken, code: totp(ts.json.secret, 1) } });
ok(l2.status === 200 && Boolean(l2.json?.token), 'Anmeldung mit Code');
const l3 = await api('POST', '/auth/login/totp', { body: { mfaToken: l1.json.mfaToken, code: totp(ts.json.secret, 1) } });
ok(l3.status === 401, 'derselbe Code ein zweites Mal abgelehnt');
const r1Login = await api('POST', '/auth/login', { body: { login: FRIEND.username, password: FRIEND.password } });
const rc = await api('POST', '/auth/login/totp', { body: { mfaToken: r1Login.json?.mfaToken, code: recoveryCodes[0].toLowerCase() } });
ok(rc.status === 200 && rc.json?.usedRecoveryCode === true && rc.json?.recoveryCodesLeft === 9, 'Anmeldung mit Wiederherstellungscode', String(rc.status) + ' ' + (rc.json?.error ?? ''));
const rcAgain = await api('POST', '/auth/login/totp', { body: { mfaToken: r1Login.json?.mfaToken, code: recoveryCodes[0] } });
ok(rcAgain.status === 401, 'verbrauchter Wiederherstellungscode abgelehnt');
ok((await api('POST', '/auth/totp/recovery-codes', { token: friend, body: { password: 'falsch', code: '000000' } })).status === 400, 'neue Codes nur mit Passwort');
const usersList = (await api('GET', '/users', { token: admin })).json;
const flist = Array.isArray(usersList) ? usersList : usersList?.users ?? [];
ok(flist.find((u) => u.id === friendId)?.totpEnabled === true, 'Admin-Liste zeigt 2FA');
ok((await api('PATCH', `/users/${friendId}`, { token: admin, body: { resetTotp: true } })).status === 200, 'Admin setzt 2FA zurück');
const l4 = await api('POST', '/auth/login', { body: { login: FRIEND.username, password: FRIEND.password } });
ok(Boolean(l4.json?.token) && !l4.json?.mfaRequired, 'Anmeldung danach ohne Code');
friend = l4.json.token;

// 9) Überall abmelden
const second = (await api('POST', '/auth/login', { body: { login: ADMIN.username, password: ADMIN.password } })).json.token;
const lo = await api('POST', '/auth/logout-all', { token: admin });
ok(lo.status === 200 && Boolean(lo.json?.token), 'logout-all liefert neues Token');
ok((await api('GET', '/auth/me', { token: second })).status === 401, 'andere Sitzung abgemeldet');
admin = lo.json.token;
ok((await api('GET', '/auth/me', { token: admin })).status === 200, 'eigene Sitzung bleibt');

// 10) Webhooks ins LAN nur für Admins
const hook = await api('POST', `/servers/${serverId}/notifications`, { token: friend, body: { name: 'LAN', type: 'WEBHOOK', target: 'http://192.168.1.10:8123/hook', events: ['server.crashed'] } });
ok(hook.status === 400 && /lokal|privat|Netz/i.test(hook.json?.error ?? ''), 'Webhook ins LAN für Nicht-Admin abgelehnt', String(hook.status) + ' ' + (hook.json?.error ?? ''));

const pub = await api('POST', `/servers/${serverId}/notifications`, { token: friend, body: { name: 'Discord', type: 'WEBHOOK', target: 'https://discord.com/api/webhooks/1/x', events: ['server.crashed'] } });
ok(pub.status === 201 || pub.status === 200, 'öffentlicher Webhook erlaubt', String(pub.status) + ' ' + (pub.json?.error ?? ''));
const adminHook = await api('POST', `/servers/${serverId}/notifications`, { token: admin, body: { name: 'LAN', type: 'WEBHOOK', target: 'http://192.168.1.10:8123/hook', events: ['server.crashed'] } });
ok(adminHook.status === 201 || adminHook.status === 200, 'Admin darf LAN-Webhook', String(adminHook.status) + ' ' + (adminHook.json?.error ?? ''));

// 11) Automation mit Vorwarnung
const auto = await api('POST', `/servers/${serverId}/automations`, { token: friend, body: { name: 'Neustart', trigger: 'SCHEDULE', cron: '0 4 * * *', action: 'RESTART', config: { warnSeconds: 60 } } });
ok(auto.status === 200 || auto.status === 201, 'Automation mit Vorwarnung angelegt', auto.json?.error ?? '');
const autos = (await api('GET', `/servers/${serverId}/automations`, { token: friend })).json;
const a0 = (autos?.automations ?? autos ?? [])[0];
ok(a0?.config?.warnSeconds === 60 && a0?.runsAs === FRIEND.username, 'warnSeconds und runsAs geliefert', JSON.stringify({ w: a0?.config?.warnSeconds, r: a0?.runsAs }));

// 12) Angemeldete Geräte
const deviceB = (await api('POST', '/auth/login', { body: { login: ADMIN.username, password: ADMIN.password } })).json.token;
const sessions = await api('GET', '/auth/sessions', { token: admin });
const sessionList = Array.isArray(sessions.json) ? sessions.json : [];
ok(sessions.status === 200 && sessionList.length >= 2 && sessionList.filter((s) => s.current).length === 1, 'Sitzungsliste mit genau einer aktuellen', String(sessionList.length));
ok(sessionList.every((s) => typeof s.device === 'string' && s.lastSeenAt), 'Sitzungen mit Gerät und letzter Aktivität');
const other = sessionList.find((s) => !s.current);
ok((await api('DELETE', `/auth/sessions/${other?.id}`, { token: admin })).json?.current === false, 'anderes Gerät abgemeldet');
ok((await api('GET', '/auth/me', { token: deviceB })).status === 401, 'Token des abgemeldeten Geräts ungültig');
ok((await api('GET', '/auth/me', { token: admin })).status === 200, 'eigenes Gerät bleibt angemeldet');
ok((await api('DELETE', '/auth/sessions/gibt-es-nicht', { token: admin })).status === 404, 'unbekannte Sitzung: 404');
const deviceC = (await api('POST', '/auth/login', { body: { login: ADMIN.username, password: ADMIN.password } })).json.token;
ok((await api('POST', '/auth/logout', { token: deviceC })).status === 200, 'Abmelden beendet die Sitzung');
ok((await api('GET', '/auth/me', { token: deviceC })).status === 401, 'abgemeldetes Token ungültig');

// 13) Backup-Prüfung
const fresh = await api('POST', `/servers/${serverId}/backups`, { token: admin, body: { name: 'Prüfling' } });
ok((await waitTask(admin, serverId, fresh.json?.taskId))?.status === 'DONE', 'Backup für die Prüfung fertig');
let pruefling = (await listBackups(admin, serverId)).find((b) => b.name === 'Prüfling');
ok(pruefling?.verifyStatus === 'OK' && Boolean(pruefling?.verifiedAt), 'neues Backup gleich beim Anlegen geprüft', pruefling?.verifyMessage ?? '');
const vr = await api('POST', `/servers/${serverId}/backups/${pruefling?.id}/verify`, { token: admin });
const vt = await waitTask(admin, serverId, vr.json?.taskId);
ok(vt?.status === 'DONE', 'Prüfung als Aufgabe abgeschlossen', vt?.error ?? vt?.status ?? '');
const after = (await listBackups(admin, serverId)).find((b) => b.id === pruefling?.id);
ok(after?.verifyStatus === 'OK' && new Date(after.verifiedAt) >= new Date(pruefling.verifiedAt), 'zuletzt geprüft aktualisiert', after?.verifyMessage ?? '');

// 14) Spielerstatistik
const stats = await api('GET', `/servers/${serverId}/players/stats?days=7`, { token: friend });
ok(stats.status === 200 && Array.isArray(stats.json?.timeline) && Array.isArray(stats.json?.players) && stats.json?.days === 7, 'Spielerstatistik abrufbar', String(stats.status));
ok((await api('GET', `/servers/${serverId}/players/stats?days=365`, { token: friend })).status === 400, 'Zeitraum über 90 Tage abgelehnt');

// 15) Weltverwaltung
const worldPath = `/servers/${serverId}/worlds`;
let worlds = (await api('GET', worldPath, { token: admin })).json;
ok(worlds?.active === 'world' && worlds?.worlds?.[0]?.exists === false, 'Standardwelt eingetragen, noch nicht erzeugt');
const worldZip = zip([
  { name: 'MeineWelt/level.dat', data: crypto.randomBytes(512) },
  { name: 'MeineWelt/region/r.0.0.mca', data: crypto.randomBytes(4096) },
]);
const wu = await upload(`${worldPath}/upload?name=Hochgeladen&activate=true`, admin, 'welt.zip', worldZip);
ok(wu.status === 200, 'Welt-Upload angenommen', String(wu.status) + ' ' + (wu.json?.error ?? ''));
const wut = await waitTask(admin, serverId, wu.json?.taskId);
ok(wut?.status === 'DONE', 'Welt entpackt', wut?.error ?? wut?.status ?? '');
worlds = (await api('GET', worldPath, { token: admin })).json;
ok(worlds?.active === 'Hochgeladen' && worlds.worlds.some((w) => w.name === 'Hochgeladen' && w.exists && w.sizeBytes > 0), 'hochgeladene Welt aktiv');
ok((await upload(`${worldPath}/upload?name=..%2Fausbruch`, admin, 'welt.zip', worldZip)).status === 400, 'Weltname mit Pfad abgelehnt');
ok((await upload(`${worldPath}/upload?name=Ohne`, admin, 'welt.zip', zip([{ name: 'readme.txt', data: 'keine Welt' }]))).status === 400, 'ZIP ohne level.dat abgelehnt');
const worldDl = `/api${worldPath}/Hochgeladen/download`;
const wdt = (await api('POST', '/auth/download-token', { token: admin, body: { path: worldDl } })).json?.token;
const wdl = await fetch(`${BASE}${worldDl}?token=${wdt}`);
const wdlBody = Buffer.from(await wdl.arrayBuffer());
ok(wdl.status === 200 && wdlBody[0] === 0x1f && wdlBody[1] === 0x8b, 'Welt-Download (gzip)', String(wdl.status));
const nw = await api('POST', worldPath, { token: admin, body: { name: 'Neu', seed: '42' } });
ok(nw.json?.active === 'Neu', 'neue Welt angelegt und aktiv', nw.json?.error ?? '');
ok((await api('POST', worldPath, { token: admin, body: { name: 'Hochgeladen' } })).status === 409, 'vorhandener Weltname abgelehnt');
ok((await api('POST', `${worldPath}/Hochgeladen/activate`, { token: admin })).json?.active === 'Hochgeladen', 'zurück zur hochgeladenen Welt');
const second2 = await upload(`${worldPath}/upload?name=Zweite`, admin, 'welt.zip', worldZip);
await waitTask(admin, serverId, second2.json?.taskId);
ok((await api('DELETE', `${worldPath}/Hochgeladen`, { token: admin })).status === 400, 'aktive Welt nicht löschbar');
ok((await api('DELETE', `${worldPath}/Zweite`, { token: admin })).status === 200, 'inaktive Welt gelöscht');
const reset = await api('POST', `${worldPath}/reset`, { token: admin, body: { seed: '7' } });
const rst = await waitTask(admin, serverId, reset.json?.taskId);
ok(rst?.status === 'DONE', 'Welt zurückgesetzt', rst?.error ?? rst?.status ?? '');
worlds = (await api('GET', worldPath, { token: admin })).json;
ok(worlds?.seed === '7' && worlds.worlds.find((w) => w.name === 'Hochgeladen')?.exists === false, 'neuer Seed, alte Welt entfernt');
ok((await listBackups(admin, serverId)).some((b) => b.origin === 'SAFETY' && /Weltreset/.test(b.name)), 'Sicherheits-Backup vor dem Reset');

// 16) Zwei-Faktor-Pflicht (zuletzt – danach braucht der Admin einen Code)
ok((await api('PUT', '/settings/security', { token: admin, body: { requireTotp: 'admins' } })).status === 400, 'Pflicht ohne eigenen zweiten Faktor abgelehnt');
const ats = await api('POST', '/auth/totp/setup', { token: admin });
const aen = await api('POST', '/auth/totp/enable', { token: admin, body: { code: totp(ats.json.secret) } });
ok(aen.status === 200, 'Admin richtet zweiten Faktor ein', aen.json?.error ?? '');
admin = aen.json.token;
ok((await api('PUT', '/settings/security', { token: admin, body: { requireTotp: 'all' } })).status === 200, 'Pflicht für alle gesetzt');
const blocked = await api('GET', '/servers', { token: friend });
ok(blocked.status === 403 && /Zwei-Faktor/.test(blocked.json?.error ?? ''), 'Konto ohne zweiten Faktor gesperrt', String(blocked.status));
const friendMe = await api('GET', '/auth/me', { token: friend });
ok(friendMe.status === 200 && friendMe.json?.totpRequired === true, 'Profil bleibt erreichbar und meldet die Pflicht');
ok((await api('POST', '/auth/totp/setup', { token: friend })).status === 200, 'Einrichtung bleibt erreichbar');
const panel = (await api('GET', '/settings', { token: admin })).json;
ok(panel?.security?.requireTotp === 'all' && panel?.security?.usersWithoutTotp >= 1, 'Einstellungen zeigen Pflicht und betroffene Konten');
ok(typeof panel?.disk?.totalBytes === 'number' || panel?.disk === null, 'Einstellungen melden den Speicherplatz');
ok((await api('PUT', '/settings/security', { token: admin, body: { requireTotp: 'off' } })).status === 200, 'Pflicht wieder aus');
ok((await api('GET', '/servers', { token: friend })).status === 200, 'Konto danach wieder frei');

// Aufräumen
const del = await api('DELETE', `/servers/${serverId}`, { token: admin });
ok(del.status === 200, 'Server gelöscht', del.json?.error ?? '');

console.log(failures ? `\n${failures} Prüfungen fehlgeschlagen` : '\nAlle Prüfungen bestanden');
process.exit(failures ? 1 : 0);
