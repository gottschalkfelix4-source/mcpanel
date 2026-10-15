import type { Server } from '@prisma/client';
import { badRequest } from '../lib/errors.js';
import * as dockerSvc from './docker.js';
import { rconCommand, rconNotDelivered } from './rcon.js';

/**
 * Konsolenbefehl an einen laufenden Server – bewusst ohne Serversperre, damit
 * Befehle parallel zu Backups und den Befehlen anderer Nutzer funktionieren.
 *
 * Auf stdin wird nur ausgewichen, wenn RCON den Befehl sicher nicht übermittelt
 * hat (Verbindung oder Anmeldung gescheitert). Nach einem Timeout ist er
 * womöglich schon ausgeführt; ein zweiter Weg würde ihn doppelt auslösen.
 */
export async function sendServerCommand(server: Server, command: string): Promise<{ via: 'rcon' | 'stdin'; response: string }> {
  try {
    return { via: 'rcon', response: await rconCommand(server, command) };
  } catch (err) {
    if (!rconNotDelivered(err)) {
      throw badRequest('Befehl wurde gesendet, der Server hat aber nicht rechtzeitig geantwortet. Er wird nicht automatisch wiederholt.');
    }
    await dockerSvc.writeStdin(server, command);
    return { via: 'stdin', response: '' };
  }
}
