export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const unauthorized = (m = 'Nicht angemeldet') => new HttpError(401, m);
export const forbidden = (m = 'Keine Berechtigung') => new HttpError(403, m);
export const notFound = (m = 'Nicht gefunden') => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);

/**
 * Systemfehler (Dateisystem mit Pfaden, Prisma mit Abfragedetails, Docker-API)
 * gehen nie an den Client. Eigene, deutsch formulierte Fehlermeldungen schon.
 */
export function isInternalError(error: Error): boolean {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && !code.startsWith('FST_')) return true;
  if ((error as { errno?: unknown }).errno !== undefined) return true;
  if (error.name.startsWith('Prisma')) return true;
  return /\(HTTP code \d+\)|ECONNREFUSED|ENOENT|EACCES|\/data\/|\/var\/run\//.test(error.message ?? '');
}

/** Netzwerkfehler von fetch/undici in verständliches Deutsch. */
const NETZWERK: [RegExp, string][] = [
  [/ENOTFOUND|EAI_AGAIN/, 'Adresse nicht gefunden – Rechnername oder DNS prüfen'],
  [/ECONNREFUSED/, 'Verbindung abgelehnt – läuft der Dienst, stimmt der Port?'],
  [/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|TimeoutError|aborted due to timeout/i, 'Zeitüberschreitung – der Dienst hat nicht geantwortet'],
  [/ECONNRESET|socket hang up|UND_ERR_SOCKET/i, 'Verbindung unterbrochen'],
  [/CERT|certificate|self[- ]signed|SSL|TLS/i, 'TLS-Zertifikat wird nicht akzeptiert'],
  [/EHOSTUNREACH|ENETUNREACH/, 'Ziel im Netz nicht erreichbar'],
];

/**
 * Meldung, die ein Nutzer sehen darf: eigene Fehler unverändert, Netzwerk-
 * fehler übersetzt, alles andere neutral (die Rohmeldung gehört ins Protokoll).
 */
export function publicErrorMessage(error: unknown, fallback = 'Interner Fehler – Details stehen im Panel-Protokoll'): string {
  if (error instanceof HttpError) return error.message;
  if (!(error instanceof Error)) return fallback;
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const text = `${(error as { code?: string }).code ?? ''} ${error.name} ${error.message} ${cause?.code ?? ''} ${cause?.message ?? ''}`;
  if (/fetch failed|^Error: connect|getaddrinfo|socket|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOST|ENET|CERT|certificate|UND_ERR|TimeoutError/i.test(text)) {
    for (const [muster, meldung] of NETZWERK) if (muster.test(text)) return meldung;
    return 'Netzwerkfehler – der Dienst war nicht erreichbar';
  }
  return isInternalError(error) ? fallback : error.message || fallback;
}
