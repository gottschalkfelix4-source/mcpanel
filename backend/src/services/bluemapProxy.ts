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
import type { Server } from '@prisma/client';
import { prisma } from '../db.js';
import { serverDir } from '../config.js';
import { serverNodeLocation } from '../lib/serverLocation.js';
import { detectModPorts } from './modPorts.js';

/** Wohin das Panel für die Karte dieses Servers verbindet. */
export async function bluemapTarget(server: Server): Promise<{ host: string; port: number } | null> {
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
): Promise<UpstreamResponse> {
  const forwarded: Record<string, string> = {};
  for (const name of PASS_REQUEST) {
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
