import type { Server } from '@prisma/client';
import { prisma } from '../db.js';
import { recreateContainer, stop } from './docker.js';
import { withServerOperation } from './operations.js';
import { hasInterruptedRestore, recoverInterruptedRestore } from './restoreRecovery.js';

/**
 * Einen unterbrochenen Restore bzw. Modpack-Austausch zu Ende bringen, bevor
 * der Server (wieder) startet.
 *
 * Läuft unter der Serversperre: ein gerade laufender Restore hat ebenfalls ein
 * Journal und darf nicht für „unterbrochen“ gehalten und zurückgerollt werden –
 * dann scheitert der Aufruf mit dem üblichen Sperrkonflikt.
 *
 * Wirft, wenn das Aufräumen nicht gelingt. Der Aufrufer darf den Server dann
 * nicht starten: Minecraft liefe auf einem halben Stand, legte eine neue Welt
 * an, und die echte ließe sich danach nicht mehr eindeutig zurücklegen.
 */
export async function resumeInterruptedRestore(server: Server): Promise<boolean> {
  if (!(await hasInterruptedRestore(server.id))) return false;
  return withServerOperation(server.id, 'Die Wiederaufnahme einer Wiederherstellung', async () => {
    // Unter der Sperre erneut prüfen – der Vorgang kann inzwischen fertig sein.
    if (!(await hasInterruptedRestore(server.id))) return false;
    await stop(server);
    await recoverInterruptedRestore(server.id);
    await recreateContainer(await prisma.server.findUniqueOrThrow({ where: { id: server.id } }));
    return true;
  });
}
