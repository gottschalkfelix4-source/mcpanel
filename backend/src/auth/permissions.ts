/** Alle Rechte, die einem Server-Mitglied einzeln zugewiesen werden können. */
export const PERMISSIONS = {
  CONSOLE_READ: 'console.read',
  CONSOLE_COMMAND: 'console.command',
  POWER: 'power',
  FILES_READ: 'files.read',
  FILES_WRITE: 'files.write',
  CONFIG_EDIT: 'config.edit',
  BACKUP_CREATE: 'backup.create',
  BACKUP_RESTORE: 'backup.restore',
  BACKUP_DELETE: 'backup.delete',
  MODPACK_MANAGE: 'modpack.manage',
  MEMBERS_MANAGE: 'members.manage',
  SETTINGS_EDIT: 'settings.edit',
  AUTOMATION_MANAGE: 'automation.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/** Sinnvolle Voreinstellung für neu eingeladene Freunde. */
export const DEFAULT_MEMBER_PERMISSIONS: Permission[] = [
  PERMISSIONS.CONSOLE_READ,
  PERMISSIONS.POWER,
  PERMISSIONS.FILES_READ,
];

export const PERMISSION_LABELS: Record<Permission, string> = {
  'console.read': 'Konsole lesen',
  'console.command': 'Befehle senden',
  power: 'Starten / Stoppen',
  'files.read': 'Dateien ansehen',
  'files.write': 'Dateien bearbeiten',
  'config.edit': 'Konfiguration ändern',
  'backup.create': 'Backups erstellen',
  'backup.restore': 'Backups einspielen',
  'backup.delete': 'Backups löschen',
  'modpack.manage': 'Modpacks verwalten',
  'members.manage': 'Mitglieder verwalten',
  'settings.edit': 'Servereinstellungen',
  'automation.manage': 'Automatisierungen verwalten',
};
