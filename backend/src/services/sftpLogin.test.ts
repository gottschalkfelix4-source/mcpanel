import bcrypt from 'bcryptjs';
import { beforeAll, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ user: null as any }));
vi.mock('../config.js', () => ({ config: { sftp: {}, dataRoot: '/nicht-benutzt' } }));
vi.mock('../db.js', () => ({ prisma: { user: { findFirst: async () => m.user } } }));
vi.mock('../auth/context.js', () => ({ audit: vi.fn() }));
vi.mock('./sftpFiles.js', () => ({ SftpFiles: class {}, sftpLocation: vi.fn() }));

const { verifySftpLogin } = await import('./sftp.js');
const { generateSecret, totp } = await import('../lib/totp.js');

const secret = generateSecret();
beforeAll(() => {
  m.user = { id: 'u', username: 'anna', active: true, passwordHash: bcrypt.hashSync('geheim-123', 4), totpEnabled: false, totpSecret: null };
});

it('meldet ohne zweiten Faktor nur mit dem Passwort an', async () => {
  expect(await verifySftpLogin('anna', 'geheim-123')).toBe(m.user);
  expect(await verifySftpLogin('anna', 'falsch')).toBeNull();
});

it('verlangt mit zweitem Faktor Passwort und direkt angehängten Code', async () => {
  m.user = { ...m.user, totpEnabled: true, totpSecret: secret };
  expect(await verifySftpLogin('anna', 'geheim-123')).toBeNull();
  expect(await verifySftpLogin('anna', 'geheim-123000000')).toBeNull();
  expect(await verifySftpLogin('anna', 'falsch' + totp(secret))).toBeNull();
  expect(await verifySftpLogin('anna', 'geheim-123' + totp(secret))).toBe(m.user);
});

it('lässt gesperrte Konten auch mit richtigem Code nicht hinein', async () => {
  m.user = { ...m.user, active: false };
  expect(await verifySftpLogin('anna', 'geheim-123' + totp(secret))).toBeNull();
});
