import type { ServerAccess } from './context.js';
import { PERMISSIONS, type Permission } from './permissions.js';
import { forbidden } from '../lib/errors.js';

/** Automationen dürfen keine fehlenden Einzelrechte ersetzen. */
export function assertAutomationAccess(access: ServerAccess, action: string, config: unknown): void {
  const actions: Record<string, Permission> = {
    COMMAND: PERMISSIONS.CONSOLE_COMMAND,
    BACKUP: PERMISSIONS.BACKUP_CREATE,
    START: PERMISSIONS.POWER,
    STOP: PERMISSIONS.POWER,
    RESTART: PERMISSIONS.POWER,
    MODPACK_UPDATE: PERMISSIONS.MODPACK_MANAGE,
  };
  const required = [PERMISSIONS.AUTOMATION_MANAGE, actions[action]];
  if (action === 'BACKUP' && (config as { keepBackups?: number } | null)?.keepBackups) {
    required.push(PERMISSIONS.BACKUP_DELETE);
  }
  if (!actions[action] || required.some((p) => !access.can(p))) {
    throw forbidden('Dir fehlen die Rechte für diese Automatisierungsaktion');
  }
}
