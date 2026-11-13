import { z } from 'zod';

/**
 * Projekt-, Versions- und Datei-IDs von Modrinth/CurseForge.
 *
 * Sie wandern unverändert in API-Adressen und in Dateinamen des Caches. Ein
 * „/“, „?“ oder „..“ darin würde die Anfrage auf einen anderen Endpunkt lenken
 * bzw. die heruntergeladene Datei aus dem Cache-Ordner heraus in einen fremden
 * Serverordner schreiben. Erlaubt ist deshalb nur, was die Anbieter für IDs
 * und Kurznamen selbst zulassen – ohne Pfad- und URL-Sonderzeichen.
 */
export const PROVIDER_ID = /^[A-Za-z0-9_!@$()+,'-][A-Za-z0-9_.!@$()+,'-]{0,63}$/;

export const providerId = z.string().regex(PROVIDER_ID, 'Ungültige Projekt- oder Versionskennung');

export function isProviderId(value: string): boolean {
  return PROVIDER_ID.test(value);
}
