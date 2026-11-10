/**
 * Kurzzeit-Token für die eingebettete BlueMap-Karte.
 *
 * Ein `<iframe>` kann keinen Authorization-Header mitschicken, und Sitzungs-
 * JWTs gehören nie in eine URL. Deshalb ein eigenes, auf genau einen Server
 * und einen Benutzer begrenztes Token mit eigener Signatur (abgeleitet vom
 * Panel-Geheimnis, aber mit anderem Zweck, sodass es nie als Sitzung taugt).
 * Es steht als Pfadsegment in der URL, damit BlueMaps relative Pfade darunter
 * aufgelöst werden.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';

export const MAP_TOKEN_TTL_MS = 12 * 3600_000;

interface Payload {
  /** Server */
  s: string;
  /** Benutzer */
  u: string;
  /** Ablauf (ms seit Epoche) */
  e: number;
  /** sessionVersion des Benutzers – „überall abmelden“ und Passwortwechsel machen das Token ungültig */
  v: number;
}

const key = () => crypto.createHmac('sha256', config.jwtSecret).update('mcpanel:map-view:v1').digest();

function sign(body: string): string {
  return crypto.createHmac('sha256', key()).update(body).digest('base64url');
}

export function createMapToken(serverId: string, userId: string, sessionVersion: number, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ s: serverId, u: userId, e: now + MAP_TOKEN_TTL_MS, v: sessionVersion } satisfies Payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Prüft Signatur und Ablauf. `null` bei jedem Fehler – ohne Details. */
export function verifyMapToken(token: string, now = Date.now()): { serverId: string; userId: string; sessionVersion: number } | null {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined || token.length > 512) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
    if (typeof payload.s !== 'string' || typeof payload.u !== 'string' || typeof payload.e !== 'number' || typeof payload.v !== 'number') return null;
    if (payload.e < now) return null;
    return { serverId: payload.s, userId: payload.u, sessionVersion: payload.v };
  } catch {
    return null;
  }
}
