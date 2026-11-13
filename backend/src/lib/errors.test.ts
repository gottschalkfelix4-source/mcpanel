import { expect, it } from 'vitest';
import { badRequest, publicErrorMessage } from './errors.js';

it('gibt eigene Meldungen unverändert weiter', () => {
  expect(publicErrorMessage(badRequest('Server läuft nicht'))).toBe('Server läuft nicht');
  expect(publicErrorMessage(new Error('Speicherplatz reicht nicht'))).toBe('Speicherplatz reicht nicht');
});

it('verbirgt Systemfehler mit Pfaden und Docker-Details', () => {
  const fs = Object.assign(new Error("ENOENT: no such file or directory, open '/data/servers/x/a'"), { code: 'ENOENT', errno: -2 });
  expect(publicErrorMessage(fs)).toMatch(/Interner Fehler/);
  expect(publicErrorMessage(new Error('(HTTP code 404) no such container'))).toMatch(/Interner Fehler/);
});

it('übersetzt Netzwerkfehler', () => {
  const dns = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND webhook.invalid' } });
  expect(publicErrorMessage(dns)).toMatch(/Adresse nicht gefunden/);
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  expect(publicErrorMessage(refused)).toMatch(/Verbindung abgelehnt/);
  expect(publicErrorMessage(new TypeError('fetch failed'))).toMatch(/Netzwerkfehler/);
});
