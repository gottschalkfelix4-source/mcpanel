import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Gerätesitzungen und vorgeschriebener zweiter Faktor: ein Token mit
 * Sitzungs-ID gilt nur, solange die Sitzungszeile existiert; ohne
 * eingerichteten zweiten Faktor bleibt bei Pflicht nur die Einrichtung offen.
 */
const m = vi.hoisted(() => ({
  user: { id: 'nutzer', role: 'USER', active: true, sessionVersion: 0, totpEnabled: false } as any,
  session: null as any,
  payload: { sub: 'nutzer', sessionVersion: 0, sid: 'sitzung-1' } as any,
  policy: 'off',
  sessionUpdate: vi.fn(async () => ({})),
}));

vi.mock('../db.js', () => ({ prisma: {
  user: { findUnique: vi.fn(async () => m.user) },
  session: { findUnique: vi.fn(async () => m.session), update: m.sessionUpdate },
} }));
vi.mock('./jwt.js', () => ({ verifyToken: () => m.payload }));
vi.mock('../services/settings.js', () => ({ getSetting: vi.fn(async () => m.policy) }));

const { authenticateSession, enforceTotpPolicy } = await import('./context.js');
const { describeUserAgent } = await import('./sessions.js');
const { allowedWithoutTotp } = await import('./totpPolicy.js');

beforeEach(() => {
  m.user = { id: 'nutzer', role: 'USER', active: true, sessionVersion: 0, totpEnabled: false };
  m.session = { id: 'sitzung-1', userId: 'nutzer', expiresAt: new Date(Date.now() + 3600_000), user: m.user };
  m.payload = { sub: 'nutzer', sessionVersion: 0, sid: 'sitzung-1' };
  m.policy = 'off';
});

describe('Gerätesitzungen', () => {
  it('liefert Konto und Sitzungs-ID einer gültigen Sitzung', async () => {
    const result = await authenticateSession('token');
    expect(result.user.id).toBe('nutzer');
    expect(result.sessionId).toBe('sitzung-1');
  });

  it('meldet genau das Gerät ab, dessen Sitzungszeile gelöscht wurde', async () => {
    m.session = null;
    await expect(authenticateSession('token')).rejects.toMatchObject({ statusCode: 401, message: 'Sitzung widerrufen' });
  });

  it('lehnt abgelaufene und fremde Sitzungen ab', async () => {
    m.session.expiresAt = new Date(Date.now() - 1000);
    await expect(authenticateSession('token')).rejects.toMatchObject({ statusCode: 401 });
    m.session.expiresAt = new Date(Date.now() + 1000);
    m.session.userId = 'anderer';
    await expect(authenticateSession('token')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('prüft Aktivstatus und Sitzungsversion auch bei Sitzungstokens', async () => {
    m.session.user = { ...m.user, active: false };
    await expect(authenticateSession('token')).rejects.toMatchObject({ statusCode: 401 });
    m.session.user = { ...m.user, sessionVersion: 1 };
    await expect(authenticateSession('token')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('akzeptiert ältere Tokens ohne Sitzungs-ID weiterhin', async () => {
    m.payload = { sub: 'nutzer', sessionVersion: 0 };
    const result = await authenticateSession('token');
    expect(result.sessionId).toBeUndefined();
  });

  it('beschreibt Geräte verständlich', () => {
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0')).toBe('Firefox unter Windows');
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari unter iOS');
    expect(describeUserAgent('curl/8.5.0')).toBe('Skript');
    expect(describeUserAgent('')).toBe('Unbekanntes Gerät');
  });
});

describe('Vorgeschriebener zweiter Faktor', () => {
  it('lässt ohne Pflicht alles durch', async () => {
    await expect(enforceTotpPolicy(m.user, '/api/servers')).resolves.toBeUndefined();
  });

  it('sperrt bei Pflicht für alle bis auf Profil, Einrichtung und Abmelden', async () => {
    m.policy = 'all';
    await expect(enforceTotpPolicy(m.user, '/api/servers')).rejects.toMatchObject({ statusCode: 403 });
    await expect(enforceTotpPolicy(m.user, null)).rejects.toMatchObject({ statusCode: 403 });
    for (const url of ['/api/auth/me', '/api/auth/totp/setup', '/api/auth/logout', '/api/auth/logout-all', '/api/auth/sessions/abc', '/api/settings/public']) {
      await expect(enforceTotpPolicy(m.user, url)).resolves.toBeUndefined();
    }
  });

  it('betrifft bei „admins“ nur Administratoren', async () => {
    m.policy = 'admins';
    await expect(enforceTotpPolicy(m.user, '/api/servers')).resolves.toBeUndefined();
    await expect(enforceTotpPolicy({ ...m.user, role: 'ADMIN' }, '/api/servers')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('lässt Konten mit eingerichtetem zweiten Faktor durch', async () => {
    m.policy = 'all';
    await expect(enforceTotpPolicy({ ...m.user, totpEnabled: true }, '/api/servers')).resolves.toBeUndefined();
  });

  it('öffnet keine ähnlich klingenden Adressen', () => {
    expect(allowedWithoutTotp('/api/auth/meine-daten')).toBe(false);
    expect(allowedWithoutTotp('/api/auth/password')).toBe(false);
    expect(allowedWithoutTotp('/api/auth/sessionsx')).toBe(false);
    expect(allowedWithoutTotp('/api/settings')).toBe(false);
  });
});
