/**
 * Schlanker WebDAV-Client für die Backup-Zweitablage (Nextcloud, ownCloud,
 * Synology, QNAP, Hetzner Storage Box, Apache/nginx mit DAV-Modul …).
 *
 * Bewusst ohne Zusatzpaket: gebraucht werden nur MKCOL, PUT, MOVE, GET,
 * DELETE und PROPFIND. Weiterleitungen werden nicht verfolgt – sonst ginge die
 * Basic-Anmeldung an ein Ziel, das niemand eingetragen hat.
 *
 * Hochgeladen wird erst unter einem Zwischennamen und danach per MOVE
 * umbenannt: ein abgebrochener Upload hinterlässt nie eine halbe Sicherung
 * unter dem echten Namen.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { badRequest } from '../lib/errors.js';

export interface WebdavConfig {
  /** Ordner-Adresse, z. B. https://cloud.example.de/remote.php/dav/files/anna/Backups */
  url: string;
  username: string;
  password: string;
}

export class WebdavError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

/** Leerlauf-Grenze je Anfrage; große Uploads laufen, solange Daten fließen. */
const IDLE_TIMEOUT_MS = 120_000;
const MAX_TEXT_BYTES = 1024 * 1024;

/** Prüft die Adresse und liefert sie mit abschließendem Schrägstrich. */
export function webdavBase(config: Pick<WebdavConfig, 'url'>): URL {
  let url: URL;
  try {
    url = new URL(config.url.trim());
  } catch {
    throw badRequest('Die WebDAV-Adresse ist keine gültige URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('Die WebDAV-Adresse muss mit http:// oder https:// beginnen');
  }
  if (url.username || url.password) {
    throw badRequest('Benutzer und Kennwort bitte in die eigenen Felder eintragen, nicht in die Adresse');
  }
  if (url.search || url.hash) throw badRequest('Die WebDAV-Adresse darf keine Parameter (? oder #) enthalten');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

/** Adresse unterhalb des Basisordners; jedes Segment wird einzeln kodiert. */
function resolve(config: WebdavConfig, segments: string[], collection = false): URL {
  const url = webdavBase(config);
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || /[/\\\0\r\n]/.test(segment)) {
      throw badRequest('Ungültiger Pfad in der WebDAV-Ablage');
    }
  }
  const tail = segments.map(encodeURIComponent).join('/');
  url.pathname += tail + (collection && tail ? '/' : '');
  return url;
}

function authHeader(config: WebdavConfig): Record<string, string> {
  if (!config.username && !config.password) return {};
  return { Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}` };
}

/** Netzwerkfehler in Klartext. Zugangsdaten stehen in keiner dieser Meldungen. */
export function describeNetworkError(err: unknown): string {
  if (err instanceof WebdavError) return err.message;
  const e = err as NodeJS.ErrnoException;
  const code = e?.code ?? '';
  const message = e?.message ?? String(err);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Servername nicht auffindbar – Adresse prüfen';
  if (code === 'ECONNREFUSED') return 'Verbindung abgelehnt – läuft der Dienst, stimmt der Port?';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Server nicht erreichbar – Adresse und Netz prüfen';
  if (code === 'ECONNRESET') return 'Der Server hat die Verbindung abgebrochen';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code) || /certificate/i.test(message)) {
    return 'Das Zertifikat des Servers ist ungültig oder selbstsigniert – im Heimnetz notfalls http:// verwenden';
  }
  if (code === 'EPROTO' || /wrong version number/i.test(message)) {
    return 'TLS-Fehler – spricht der Server unter dieser Adresse wirklich https?';
  }
  return message.slice(0, 300);
}

/** HTTP-Status in Klartext. */
export function describeStatus(status: number, action: string): string {
  if (status === 401) return 'Zugangsdaten abgelehnt (401) – Benutzer und Kennwort prüfen (bei Nextcloud mit Zwei-Faktor ein App-Passwort)';
  if (status === 403) return `Zugriff verweigert (403) beim ${action} – fehlen Schreibrechte?`;
  if (status === 404 || status === 409) return `Ordner nicht gefunden (${status}) beim ${action} – Adresse prüfen`;
  if (status === 405 || status === 501) return `Der Server kann das nicht (${status}) beim ${action} – ist das wirklich eine WebDAV-Adresse?`;
  if (status === 413) return 'Der Server lehnt die Dateigröße ab (413) – Upload-Grenze des Servers oder Reverse-Proxys prüfen';
  if (status === 423) return `Datei ist gesperrt (423) beim ${action}`;
  if (status === 507) return 'Kein Platz mehr auf dem WebDAV-Speicher (507)';
  if (status >= 300 && status < 400) {
    return `Der Server leitet weiter (${status}) – bitte die endgültige Adresse eintragen (https://, abschließender Pfad)`;
  }
  return `WebDAV-Server antwortet beim ${action} mit HTTP ${status}`;
}

interface RequestOptions {
  headers?: Record<string, string | number>;
  body?: string | NodeJS.ReadableStream;
}

/** Eine Anfrage; die Antwort muss der Aufrufer lesen oder verwerfen. */
function send(config: WebdavConfig, method: string, url: URL, options: RequestOptions = {}): Promise<http.IncomingMessage> {
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolvePromise, reject) => {
    const req = lib.request(url, {
      method,
      agent: false,
      headers: { 'User-Agent': 'MCPanel', ...authHeader(config), ...(options.headers ?? {}) },
    }, (res) => {
      res.setTimeout(IDLE_TIMEOUT_MS, () => res.destroy(new WebdavError('Zeitüberschreitung – der Server antwortet nicht mehr')));
      resolvePromise(res);
    });
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new WebdavError('Zeitüberschreitung – der Server antwortet nicht')));
    req.on('error', (err) => reject(new WebdavError(describeNetworkError(err))));
    if (options.body === undefined) {
      req.end();
    } else if (typeof options.body === 'string') {
      req.end(options.body);
    } else {
      pipeline(options.body, req).catch((err) => {
        req.destroy();
        reject(err instanceof WebdavError ? err : new WebdavError(describeNetworkError(err)));
      });
    }
  });
}

async function readText(res: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    size += (chunk as Buffer).length;
    if (size > MAX_TEXT_BYTES) {
      res.destroy();
      break;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Anfrage ohne interessanten Rumpf: nur der Status zählt. */
async function call(config: WebdavConfig, method: string, url: URL, options: RequestOptions = {}): Promise<number> {
  const res = await send(config, method, url, options);
  res.resume();
  await new Promise<void>((done) => { res.once('end', done); res.once('close', done); res.once('error', () => done()); });
  return res.statusCode ?? 0;
}

/** Legt die Ordner unterhalb der Basis an; bestehende sind kein Fehler. */
export async function ensureDir(config: WebdavConfig, segments: string[]): Promise<void> {
  for (let depth = 1; depth <= segments.length; depth++) {
    const status = await call(config, 'MKCOL', resolve(config, segments.slice(0, depth), true));
    // 201 angelegt, 405 existiert bereits (RFC 4918); manche Server melden 301 für einen bestehenden Ordner.
    if (status === 201 || status === 405 || status === 301) continue;
    throw new WebdavError(describeStatus(status, 'Anlegen des Ordners'), status);
  }
}

/** Lädt eine Datei hoch: erst unter einem Zwischennamen, dann per MOVE. */
export async function putFile(
  config: WebdavConfig,
  dir: string[],
  filename: string,
  localPath: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  await ensureDir(config, dir);
  const { size } = await fs.promises.stat(localPath);
  const temp = resolve(config, [...dir, `mcpanel-upload-${crypto.randomUUID()}.tmp`]);
  const target = resolve(config, [...dir, filename]);

  // Als Generator statt `.pipe()`: ein Lesefehler der Quelle bricht so den Upload ab.
  async function* counted() {
    let sent = 0;
    let lastPercent = -1;
    for await (const chunk of fs.createReadStream(localPath)) {
      sent += (chunk as Buffer).length;
      const percent = size ? Math.min(99, Math.floor((sent / size) * 100)) : 99;
      if (onProgress && percent !== lastPercent) {
        lastPercent = percent;
        onProgress(percent);
      }
      yield chunk as Buffer;
    }
  }

  try {
    const status = await call(config, 'PUT', temp, {
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': size },
      body: Readable.from(counted()),
    });
    if (status !== 200 && status !== 201 && status !== 204) throw new WebdavError(describeStatus(status, 'Hochladen'), status);
    const moved = await call(config, 'MOVE', temp, { headers: { Destination: target.href, Overwrite: 'T' } });
    if (moved !== 201 && moved !== 204) throw new WebdavError(describeStatus(moved, 'Umbenennen'), moved);
  } catch (err) {
    await call(config, 'DELETE', temp).catch(() => 0);
    throw err;
  }
  onProgress?.(100);
}

/**
 * Lädt einen Datenstrom hoch, dessen Länge noch nicht feststeht (ein Archiv,
 * das gerade erst entsteht) – ohne `Content-Length`, also stückweise
 * (chunked). Nicht jeder WebDAV-Server nimmt das an; der Aufrufer weicht dann
 * auf `putFile` mit einer fertigen Datei aus.
 */
export async function putStream(config: WebdavConfig, dir: string[], filename: string, body: NodeJS.ReadableStream): Promise<void> {
  await ensureDir(config, dir);
  const temp = resolve(config, [...dir, `mcpanel-upload-${crypto.randomUUID()}.tmp`]);
  const target = resolve(config, [...dir, filename]);
  try {
    const status = await call(config, 'PUT', temp, { headers: { 'Content-Type': 'application/octet-stream' }, body });
    if (status !== 200 && status !== 201 && status !== 204) throw new WebdavError(describeStatus(status, 'Hochladen'), status);
    const moved = await call(config, 'MOVE', temp, { headers: { Destination: target.href, Overwrite: 'T' } });
    if (moved !== 201 && moved !== 204) throw new WebdavError(describeStatus(moved, 'Umbenennen'), moved);
  } catch (err) {
    await call(config, 'DELETE', temp).catch(() => 0);
    throw err;
  }
}

/** Lädt eine Datei herunter. `false`, wenn es sie nicht gibt. */
export async function getFile(config: WebdavConfig, segments: string[], destination: string): Promise<boolean> {
  const res = await send(config, 'GET', resolve(config, segments));
  if (res.statusCode === 404) {
    res.resume();
    return false;
  }
  if (res.statusCode !== 200) {
    res.resume();
    throw new WebdavError(describeStatus(res.statusCode ?? 0, 'Herunterladen'), res.statusCode ?? 0);
  }
  try {
    await pipeline(res, fs.createWriteStream(destination));
  } catch (err) {
    throw err instanceof WebdavError ? err : new WebdavError(describeNetworkError(err));
  }
  return true;
}

/** Entfernt eine Datei; eine fehlende ist kein Fehler. */
export async function deleteFile(config: WebdavConfig, segments: string[]): Promise<void> {
  const status = await call(config, 'DELETE', resolve(config, segments));
  if (status !== 200 && status !== 204 && status !== 404) throw new WebdavError(describeStatus(status, 'Löschen'), status);
}

const QUOTA_BODY = '<?xml version="1.0" encoding="utf-8"?>'
  + '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:quota-available-bytes/></d:prop></d:propfind>';

/** Freier Platz laut RFC 4331, sofern der Server ihn nennt. */
export function parseQuota(xml: string): number | null {
  const match = /<(?:[\w-]+:)?quota-available-bytes[^>]*>\s*(-?\d+)\s*</i.exec(xml);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Verbindungstest: Ordner abfragen (bei Bedarf anlegen), eine kleine Datei
 * schreiben und wieder löschen. Liefert den freien Platz, wenn bekannt.
 */
export async function probe(config: WebdavConfig): Promise<{ freeBytes: number | null }> {
  const base = webdavBase(config);
  const propfind = () => send(config, 'PROPFIND', base, {
    headers: { Depth: 0, 'Content-Type': 'application/xml; charset=utf-8' },
    body: QUOTA_BODY,
  });
  let res = await propfind();
  if (res.statusCode === 404) {
    res.resume();
    const created = await call(config, 'MKCOL', base);
    if (created !== 201) throw new WebdavError(describeStatus(created === 409 ? 404 : created, 'Anlegen des Ordners'), created);
    res = await propfind();
  }
  const status = res.statusCode ?? 0;
  const xml = await readText(res);
  if (status !== 207) throw new WebdavError(describeStatus(status, 'Abfragen des Ordners'), status);

  const marker = resolve(config, ['.mcpanel-schreibtest']);
  const written = await call(config, 'PUT', marker, { headers: { 'Content-Type': 'text/plain', 'Content-Length': 2 }, body: 'ok' });
  if (written !== 200 && written !== 201 && written !== 204) throw new WebdavError(describeStatus(written, 'Schreibtest'), written);
  await call(config, 'DELETE', marker).catch(() => 0);
  return { freeBytes: parseQuota(xml) };
}
