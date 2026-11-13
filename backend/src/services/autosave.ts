import type { Server } from '@prisma/client';
import { rconCommand } from './rcon.js';

/**
 * Automatisches Speichern wieder einschalten.
 *
 * Bleibt „save-on“ aus, speichert der Server bis zum nächsten Neustart nicht
 * mehr von selbst – ein Absturz kostete dann den ganzen Fortschritt seither.
 * Deshalb mehrere Versuche und eine deutliche Meldung im Protokoll. Wirft nie:
 * der Aufruf steht in `finally`-Blöcken und darf deren Ergebnis nicht überdecken.
 */
export async function restoreAutosave(server: Server, bereich = 'backup'): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rconCommand(server, 'save-on');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  console.error(`[${bereich}] ${server.name}: „save-on“ kam nicht an – automatisches Speichern ist womöglich aus. Bitte „save-on“ in der Konsole senden oder den Server neu starten.`);
}
