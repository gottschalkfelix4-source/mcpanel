/**
 * `Content-Disposition` für Downloads. Umlaute, Anführungszeichen oder
 * Zeilenumbrüche im Dateinamen würden die Kopfzeile sonst zerbrechen; der
 * ASCII-Name ist der Rückfall für alte Programme, `filename*` trägt den echten.
 */
export function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
