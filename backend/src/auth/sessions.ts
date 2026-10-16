import type { User } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { signToken } from './jwt.js';

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

/**
 * Legt eine Gerätesitzung an und gibt das passende Token zurück. Das Token
 * trägt die Sitzungs-ID; wird die Zeile gelöscht, ist genau dieses Gerät
 * abgemeldet.
 */
export async function createSession(user: User, client: ClientInfo = {}): Promise<string> {
  // Abgelaufene Sitzungen dieses Kontos bei der Gelegenheit wegräumen.
  await prisma.session.deleteMany({ where: { userId: user.id, expiresAt: { lt: new Date() } } }).catch(() => {});
  const row = await prisma.session.create({
    data: {
      userId: user.id,
      version: user.sessionVersion,
      ip: (client.ip ?? '').slice(0, 64),
      userAgent: (client.userAgent ?? '').slice(0, 300),
      // Vorläufig; wird gleich auf den Ablauf des Tokens gesetzt.
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
    },
  });
  const token = signToken({
    sub: user.id, username: user.username, role: user.role, sessionVersion: user.sessionVersion, sid: row.id,
  });
  const exp = (jwt.decode(token) as { exp?: number } | null)?.exp;
  if (exp) await prisma.session.update({ where: { id: row.id }, data: { expiresAt: new Date(exp * 1000) } }).catch(() => {});
  return token;
}

/** Zeitpunkt der letzten Aktualisierung je Sitzung – höchstens einmal pro Minute schreiben. */
const lastTouched = new Map<string, number>();
const TOUCH_INTERVAL_MS = 60_000;

export function touchSession(id: string): void {
  const now = Date.now();
  if (now - (lastTouched.get(id) ?? 0) < TOUCH_INTERVAL_MS) return;
  lastTouched.set(id, now);
  if (lastTouched.size > 5000) {
    for (const [key, at] of lastTouched) if (now - at > TOUCH_INTERVAL_MS) lastTouched.delete(key);
  }
  void prisma.session.update({ where: { id }, data: { lastSeenAt: new Date(now) } }).catch(() => {});
}

/** Entfernt abgelaufene Sitzungen aller Konten. */
export async function pruneExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return count;
}

/** Kurzbeschreibung des Geräts aus dem User-Agent, z. B. „Firefox unter Windows“. */
export function describeUserAgent(ua: string): string {
  if (!ua) return 'Unbekanntes Gerät';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : /curl|node|undici|axios|python/i.test(ua) ? 'Skript'
    : 'Browser';
  const system =
    /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  return system ? `${browser} unter ${system}` : browser;
}
