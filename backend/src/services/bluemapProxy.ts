/**
 * BlueMap über das Panel ausliefern.
 *
 * BlueMap bringt einen eigenen Webserver mit (Standard Port 8100). Das Panel
 * reicht ihn unter `/api/map-view/<token>/…` durch, sodass die Karte hinter
 * der Panel-Anmeldung bleibt und kein Port nach außen nötig ist.
 *
 * Sicherheit: Was BlueMap ausliefert, liegt im Serverordner – jeder mit
 * Dateirechten auf dem Server könnte dort HTML und Skripte ablegen. Liefe das
 * mit der Herkunft des Panels, käme es an das Anmeldetoken eines Admins, der
 * die Karte öffnet. Deshalb bekommt jede Antwort eine Sandbox-CSP ohne
 * `allow-same-origin`: der Inhalt läuft in einer undurchsichtigen Herkunft,
 * ohne Zugriff auf Speicher und Cookies des Panels.
 */
import http from 'node:http';
import zlib from 'node:zlib';
import type { Server } from '@prisma/client';
import { prisma } from '../db.js';
import { serverDir } from '../config.js';
import { serverNodeLocation } from '../lib/serverLocation.js';
import { detectModPorts } from './modPorts.js';

/** Wohin das Panel für die Karte dieses Servers verbindet. */
export function bluemapTarget(server: Server): Promise<{ host: string; port: number } | null> {
  // Eine Karte lädt Hunderte Kacheln – das Ziel nicht für jede neu ermitteln.
  const hit = targetCache.get(server.id);
  if (hit && Date.now() - hit.at < 15_000) return hit.value;
  const value = resolveTarget(server);
  targetCache.set(server.id, { at: Date.now(), value });
  value.catch(() => targetCache.delete(server.id));
  if (targetCache.size > 500) targetCache.delete(targetCache.keys().next().value!);
  return value;
}

const targetCache = new Map<string, { at: number; value: Promise<{ host: string; port: number } | null> }>();

async function resolveTarget(server: Server): Promise<{ host: string; port: number } | null> {
  const node = serverNodeLocation(server.id);
  if (node) {
    // Auf Nodes ist der Port (ohne Router-Freigabe) auf dem Rechner veröffentlicht.
    const row = await prisma.serverPort.findFirst({ where: { serverId: server.id, source: 'bluemap' } });
    return row ? { host: node.tunnelIp, port: row.hostPort } : null;
  }
  const found = (await detectModPorts(serverDir(server.id))).find((entry) => entry.spec.key === 'bluemap');
  return found ? { host: server.containerName, port: found.containerPort } : null;
}

const PASS_REQUEST = ['accept', 'accept-encoding', 'accept-language', 'if-none-match', 'if-modified-since', 'range', 'cache-control', 'last-event-id'];
const PASS_RESPONSE = ['content-type', 'content-length', 'content-encoding', 'cache-control', 'etag', 'last-modified', 'content-range', 'accept-ranges', 'expires'];

export const SANDBOX_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "sandbox allow-scripts allow-popups allow-downloads; frame-ancestors 'self'",
  // Die Sandbox macht Anfragen der Karte „cross-origin“ (Herkunft null). Das
  // Token steckt ohnehin im Pfad, eine Freigabe für alle schadet hier nicht.
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Accel-Buffering': 'no',
};

/**
 * BlueMap liest und schreibt `localStorage` ohne Fehlerbehandlung (Kamera,
 * sichtbare Markierungen, Einstellungen). In der Sandbox ohne
 * `allow-same-origin` wirft schon der Zugriff einen SecurityError, und die
 * Weboberfläche bricht mit „Failed to load BlueMap webapp! … WebGL2“ ab.
 * Dieses Skript wird vor BlueMaps Code in jede HTML-Seite gelegt und ersetzt
 * nur einen Speicher, der tatsächlich wirft, durch einen im Arbeitsspeicher –
 * Einstellungen gelten dann bis zum Neuladen. Geht bewusst nicht an die
 * Herkunft des Panels und braucht keine Lockerung der Sandbox.
 */
export const STORAGE_SHIM = `(function(){function m(){var d=new Map();return{get length(){return d.size},key:function(i){var k=Array.from(d.keys())[i];return k===undefined?null:k},getItem:function(k){k=String(k);return d.has(k)?d.get(k):null},setItem:function(k,v){d.set(String(k),String(v))},removeItem:function(k){d.delete(String(k))},clear:function(){d.clear()}}}["localStorage","sessionStorage"].forEach(function(n){try{window[n]}catch(e){Object.defineProperty(window,n,{value:m(),configurable:true})}})})();`;

/** Höchstgröße einer HTML-Seite, in die das Skript eingesetzt wird. */
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** Seiten, die als Dokument im Rahmen laufen (BlueMaps `index.html`). */
export function isDocumentPath(path: string): boolean {
  const pathname = path.split('?')[0];
  return pathname.endsWith('/') || /\.html?$/i.test(pathname);
}

/** Setzt `STORAGE_SHIM` als erstes Skript in die Seite. */
export function injectStorageShim(html: string): string {
  const tag = `<script>${STORAGE_SHIM}</script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  return tag + html;
}

/** Liest eine HTML-Antwort ein (entpackt, falls der Upstream doch komprimiert). */
export async function readDocument(upstream: UpstreamResponse): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of upstream.stream) {
    size += (chunk as Buffer).length;
    if (size > MAX_DOCUMENT_BYTES) {
      upstream.stream.destroy();
      throw new Error('Die Kartenseite ist zu groß');
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks);
  const encoding = (upstream.headers['content-encoding'] ?? '').trim().toLowerCase();
  const body = encoding === 'gzip' ? zlib.gunzipSync(raw)
    : encoding === 'deflate' ? zlib.inflateSync(raw)
    : encoding === 'br' ? zlib.brotliDecompressSync(raw)
    : raw;
  return body.toString('utf8');
}

/** Pfad hinter dem Token, samt Abfrage. Keine Ausbrüche aus dem Webroot. */
export function upstreamPath(rawUrl: string, token: string): string | null {
  const marker = `/${token}`;
  const index = rawUrl.indexOf(marker);
  if (index < 0) return null;
  let rest = rawUrl.slice(index + marker.length) || '/';
  if (!rest.startsWith('/')) rest = `/${rest}`;
  const pathname = rest.split('?')[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.split(/[\\/]/).includes('..') || /[\0\r\n]/.test(decoded)) return null;
  return rest;
}

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  stream: http.IncomingMessage;
}

export function requestUpstream(
  target: { host: string; port: number },
  method: 'GET' | 'HEAD',
  path: string,
  headers: http.IncomingHttpHeaders,
  options: { document?: boolean } = {},
): Promise<UpstreamResponse> {
  const forwarded: Record<string, string> = {};
  // HTML-Seiten werden umgeschrieben: unkomprimiert und vollständig anfordern.
  const skip = options.document ? ['accept-encoding', 'if-none-match', 'if-modified-since', 'range'] : [];
  for (const name of PASS_REQUEST) {
    if (skip.includes(name)) continue;
    const value = headers[name];
    if (typeof value === 'string') forwarded[name] = value;
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: target.host, port: target.port, method, path, headers: forwarded }, (res) => {
      req.setTimeout(0);
      const out: Record<string, string> = {};
      for (const name of PASS_RESPONSE) {
        const value = res.headers[name];
        if (typeof value === 'string') out[name] = value;
      }
      // Live-Daten (Server-Sent Events) halten die Verbindung offen.
      if (!/text\/event-stream/i.test(out['content-type'] ?? '')) res.setTimeout(30_000, () => res.destroy());
      resolve({ status: res.statusCode ?? 502, headers: out, stream: res });
    });
    req.setTimeout(10_000, () => req.destroy(new Error('Die Karte antwortet nicht')));
    req.on('error', reject);
    req.end();
  });
}
