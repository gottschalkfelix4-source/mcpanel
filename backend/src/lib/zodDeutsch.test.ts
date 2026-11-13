import { expect, it } from 'vitest';
import { z } from 'zod';
import './zodDeutsch.js';

const meldung = (schema: z.ZodTypeAny, wert: unknown) => {
  const result = schema.safeParse(wert);
  return result.success ? null : result.error.issues[0].message;
};

it('meldet Eingabefehler auf Deutsch', () => {
  expect(meldung(z.object({ passwort: z.string().min(8) }), { passwort: 'kurz' })).toBe('Mindestens 8 Zeichen');
  expect(meldung(z.object({ name: z.string() }), {})).toBe('Pflichtfeld fehlt');
  expect(meldung(z.string().min(1), '')).toBe('Darf nicht leer sein');
  expect(meldung(z.number().int().max(65535), 70000)).toBe('Höchstens 65.535');
  expect(meldung(z.enum(['start', 'stop']), 'x')).toBe('Erlaubt: start, stop');
  expect(meldung(z.string().email(), 'kein')).toBe('Keine gültige E-Mail-Adresse');
  expect(meldung(z.number(), 'abc')).toBe('Erwartet: Zahl, erhalten: Text');
});

it('lässt eigene Meldungen stehen', () => {
  expect(meldung(z.string().min(8, 'Das Passwort braucht mindestens 8 Zeichen'), 'x')).toBe('Das Passwort braucht mindestens 8 Zeichen');
});
