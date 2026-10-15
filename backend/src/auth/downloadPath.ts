/**
 * Vergleichsform einer Download-Adresse: Pfad plus sortierte Abfrage ohne
 * `token`. So passt die beim Ausstellen genannte Adresse zur späteren Anfrage,
 * egal wie der Browser Leerzeichen kodiert.
 */
export function canonicalDownloadPath(url: string): string {
  const parsed = new URL(url, 'http://panel.invalid');
  const params = new URLSearchParams(parsed.search);
  params.delete('token');
  params.sort();
  const query = params.toString();
  return parsed.pathname + (query ? `?${query}` : '');
}
