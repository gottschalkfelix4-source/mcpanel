import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ user: { id: 'mitglied', active: true } as any, rights: [] as string[], access: true, command: vi.fn(), state: vi.fn() }));
vi.mock('../db.js', () => ({ prisma: {
  server: { findUnique: vi.fn(async () => ({ id: 'a' })) },
  user: { findUnique: vi.fn(async () => m.user) },
  automation: { update: vi.fn(async () => ({})) },
} }));
vi.mock('../auth/context.js', () => ({ audit: vi.fn(), getServerAccess: vi.fn(async () => {
  if (!m.access) throw new Error('Server nicht gefunden');
  return { can: (p: string) => m.rights.includes(p) };
}) }));
vi.mock('./docker.js', () => ({ getState: m.state }));
vi.mock('./rcon.js', () => ({ rconCommand: m.command }));
vi.mock('./backups.js', () => ({ createBackup: vi.fn() }));
vi.mock('./modpack.js', () => ({ checkForUpdate: vi.fn(), installModpack: vi.fn() }));
vi.mock('./tasks.js', () => ({ runTask: vi.fn() }));
vi.mock('../ws/io.js', () => ({ emitToServer: vi.fn() }));
vi.mock('./notify.js', () => ({ notify: vi.fn() }));
import { runAutomation } from './automation.js';
import { assertAutomationAccess } from '../auth/automationAccess.js';
const rule = { id: 'regel', serverId: 'a', createdById: 'mitglied', action: 'COMMAND', config: { command: 'list' }, onlyWhenRunning: false, name: 'Test' } as any;
beforeEach(() => {
  vi.clearAllMocks(); m.user = { id: 'mitglied', active: true }; m.access = true;
  m.rights = ['automation.manage', 'console.command'];
  m.state.mockResolvedValue({ state: 'running' }); m.command.mockResolvedValue('Erledigt');
});
it.each(['COMMAND', 'BACKUP', 'START', 'STOP', 'RESTART', 'MODPACK_UPDATE'])('verlangt für %s neben Automationsverwaltung das Einzelrecht', action => {
  expect(() => assertAutomationAccess({ can: (p: string) => p === 'automation.manage' } as any, action, {})).toThrow('Rechte');
});
it('verlangt für das automatische Aufräumen zusätzlich das Löschrecht', () => {
  const access = { can: (p: string) => ['automation.manage', 'backup.create'].includes(p) } as any;
  expect(() => assertAutomationAccess(access, 'BACKUP', {})).not.toThrow();
  expect(() => assertAutomationAccess(access, 'BACKUP', { keepBackups: 3 })).toThrow('Rechte');
});
it('führt einen berechtigten Zeitplan aus und sperrt ihn nach Rechteentzug', async () => {
  expect((await runAutomation(rule, 'zeitplan')).status).toBe('OK');
  m.rights = ['automation.manage'];
  expect((await runAutomation(rule, 'zeitplan')).status).toBe('FEHLER');
  expect(m.command).toHaveBeenCalledTimes(1);
});
it.each(['deaktiviert', 'gelöscht', 'fremder Server', 'ohne Ersteller'])('sperrt automatische Ausführung: %s', async reason => {
  if (reason === 'deaktiviert') m.user.active = false;
  if (reason === 'gelöscht') m.user = null;
  if (reason === 'fremder Server') m.access = false;
  const r = reason === 'ohne Ersteller' ? { ...rule, createdById: null } : rule;
  expect((await runAutomation(r, 'ereignis')).status).toBe('FEHLER');
  expect(m.command).not.toHaveBeenCalled();
});
it('prüft Rechte erneut unmittelbar vor der Aktion', async () => {
  m.state.mockImplementation(async () => { m.rights = []; return { state: 'running' }; });
  expect((await runAutomation(rule, 'zeitplan')).status).toBe('FEHLER');
  expect(m.command).not.toHaveBeenCalled();
});
it('verlangt bei manuellen Läufen einen ausdrücklichen Aufrufer', async () => {
  expect((await runAutomation(rule, 'manuell')).status).toBe('FEHLER');
  expect((await runAutomation(rule, 'manuell', 'mitglied')).status).toBe('OK');
  expect(m.command).toHaveBeenCalledTimes(1);
});
