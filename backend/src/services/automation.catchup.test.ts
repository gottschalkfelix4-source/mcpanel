import { expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ prisma: {} }));
vi.mock('./docker.js', () => ({}));
vi.mock('./settings.js', () => ({ getSetting: async () => '', setSetting: async () => {} }));

const { minutesSince } = await import('./automation.js');
const { matchesCron, parseCron } = await import('./cron.js');

const at = (h: number, min: number, s = 0) => new Date(2026, 10, 10, h, min, s);

it('prüft im Normalbetrieb nur die laufende Minute', () => {
  expect(minutesSince(null, at(3, 0, 5))).toEqual([at(3, 0)]);
  expect(minutesSince(at(3, 0, 5).getTime(), at(3, 0, 25))).toEqual([at(3, 0)]);
  expect(minutesSince(at(3, 0, 45).getTime(), at(3, 1, 5))).toEqual([at(3, 1)]);
});

it('holt nach einem Neustart die verpassten Minuten nach – aber höchstens zwei Stunden', () => {
  const nightly = parseCron('0 3 * * *');
  // Panel war von 02:58 bis 03:10 weg: das Backup um 03:00 läuft trotzdem.
  const missed = minutesSince(at(2, 58, 40).getTime(), at(3, 10, 2));
  expect(missed[0]).toEqual(at(2, 59));
  expect(missed.at(-1)).toEqual(at(3, 10));
  expect(missed.some((minute) => matchesCron(nightly, minute))).toBe(true);
  // Seit gestern Abend aus: mittags wird nichts mehr nachgeholt.
  const long = minutesSince(at(1, 0).getTime(), at(12, 0));
  expect(long).toHaveLength(120);
  expect(long.some((minute) => matchesCron(nightly, minute))).toBe(false);
});
