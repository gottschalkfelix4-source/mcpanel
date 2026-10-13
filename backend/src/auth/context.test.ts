import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ user: { id: 'nutzer', role: 'USER', active: true, sessionVersion: 0 } as any, member: null as any }));
vi.mock('../db.js', () => ({ prisma: {
  user: { findUnique: vi.fn(async () => m.user) },
  server: { findUnique: vi.fn(async () => ({ id: 'fremd', ownerId: 'anderer' })) },
  serverMember: { findUnique: vi.fn(async () => m.member) },
} }));
vi.mock('./jwt.js', () => ({ verifyToken: () => ({ sub: 'nutzer', role: 'ADMIN', sessionVersion: 0 }) }));
import { authenticateToken, getServerAccess } from './context.js';
beforeEach(() => { m.user = { id: 'nutzer', role: 'USER', active: true, sessionVersion: 0 }; m.member = null; });
it('übernimmt keine Administratorrolle aus einem alten Token', async () => {
  const user = await authenticateToken('alter-admin-token');
  expect(user.role).toBe('USER');
  await expect(getServerAccess(user, 'fremd')).rejects.toMatchObject({ statusCode: 404 });
});
it('verweigert fremde Server trotz bekannter Server-ID', async () => {
  await expect(getServerAccess(m.user, 'fremd')).rejects.toMatchObject({ statusCode: 404 });
});
it('beachtet entzogene Mitgliedschaft und Einzelrechte bei der nächsten Abfrage', async () => {
  m.member = { permissions: ['power'] };
  expect((await getServerAccess(m.user, 'fremd')).can('power')).toBe(true);
  m.member = { permissions: [] };
  expect((await getServerAccess(m.user, 'fremd')).can('power')).toBe(false);
  m.member = null;
  await expect(getServerAccess(m.user, 'fremd')).rejects.toMatchObject({ statusCode: 404 });
});
it.each(['deaktiviert', 'Passwort geändert', 'gelöscht'])('widerruft bestehende Sitzungen: %s', async reason => {
  if (reason === 'deaktiviert') m.user.active = false;
  if (reason === 'Passwort geändert') m.user.sessionVersion++;
  if (reason === 'gelöscht') m.user = null;
  await expect(authenticateToken('bestehender-token')).rejects.toMatchObject({ statusCode: 401 });
});
