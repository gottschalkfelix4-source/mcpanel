/**
 * Einmalige Datenanpassungen beim Start.
 *
 * Das Schema kommt per `prisma db push` – neue Spalten bekommen dabei nur ihren
 * Standardwert. Wo der für Altbestände falsch wäre (ein bisher funktionierendes
 * Webhook-Ziel im LAN, ein Mitglied, das bisher Backups laden durfte), wird hier
 * genau einmal nachgezogen. Ein Merker in den Einstellungen verhindert, dass
 * ein späterer Admin-Entscheid beim nächsten Start überschrieben wird.
 */
import dns from 'node:dns/promises';
import { prisma } from '../db.js';
import { getSetting, setSetting } from './settings.js';
import { isPublicAddress } from '../lib/network.js';
import { PERMISSIONS } from '../auth/permissions.js';

async function once(name: string, log: (msg: string) => void, fn: () => Promise<string | null>): Promise<void> {
  const key = `migration.${name}`;
  if (await getSetting(key)) return;
  try {
    const message = await fn();
    await setSetting(key, new Date().toISOString());
    if (message) log(message);
  } catch (err) {
    // Beim nächsten Start erneut versuchen; das Panel startet trotzdem.
    log(`Datenanpassung ${name} fehlgeschlagen: ${err instanceof Error ? err.message : err}`);
  }
}

/** Zeigt das Ziel ins eigene Netz? Namen werden aufgelöst. */
export async function targetsPrivateNetwork(target: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(target).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return true;
  const addresses = await dns.lookup(host, { all: true }).catch(() => [{ address: host }]);
  return addresses.some(({ address }) => !isPublicAddress(address));
}

export async function runDataMigrations(log: (msg: string) => void): Promise<void> {
  // Webhooks: bisher durfte jedes Ziel ins LAN. Globale Kanäle legt nur ein
  // Admin an; bestehende Serverkanäle ins LAN laufen weiter wie bisher.
  await once('notification-allow-private', log, async () => {
    const channels = await prisma.notificationChannel.findMany({ where: { allowPrivate: false } });
    let changed = 0;
    for (const channel of channels) {
      if (channel.serverId && !(await targetsPrivateNetwork(channel.target))) continue;
      await prisma.notificationChannel.update({ where: { id: channel.id }, data: { allowPrivate: true } });
      changed++;
    }
    return changed ? `Benachrichtigungen: ${changed} bestehende Ziele dürfen weiter ins lokale Netz` : null;
  });

  // Backups herunterladen war bisher an „Dateien lesen“ gebunden. Wer
  // einspielen darf, sieht die Welt ohnehin vollständig – nur diese behalten es.
  await once('backup-download-permission', log, async () => {
    const members = await prisma.serverMember.findMany({
      where: { permissions: { has: PERMISSIONS.BACKUP_RESTORE } },
    });
    let changed = 0;
    for (const member of members) {
      if (member.permissions.includes(PERMISSIONS.BACKUP_DOWNLOAD)) continue;
      await prisma.serverMember.update({
        where: { id: member.id },
        data: { permissions: [...member.permissions, PERMISSIONS.BACKUP_DOWNLOAD] },
      });
      changed++;
    }
    return changed ? `Rechte: ${changed} Mitglieder dürfen weiterhin Backups herunterladen` : null;
  });

  // Herkunft alter Backups aus den festen Texten der früheren Versionen.
  await once('backup-origin', log, async () => {
    const automatic = await prisma.backup.updateMany({
      where: {
        origin: 'MANUAL',
        createdById: null,
        OR: [{ note: 'Von einer Automatisierung erstellt' }, { name: { startsWith: 'Automatisch ' } }],
      },
      data: { origin: 'AUTOMATIC' },
    });
    const safety = await prisma.backup.updateMany({
      where: { origin: 'MANUAL', note: { startsWith: 'Automatisch vor' } },
      data: { origin: 'SAFETY' },
    });
    const total = automatic.count + safety.count;
    return total ? `Backups: ${automatic.count} automatische und ${safety.count} Sicherheits-Backups zugeordnet` : null;
  });
}
