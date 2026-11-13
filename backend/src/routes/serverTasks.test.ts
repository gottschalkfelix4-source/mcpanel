import { expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ prisma: {} }));
const { logTail } = await import('./servers.js');

it('liefert vom Aufgabenprotokoll nur das Ende, an einer Zeilengrenze', () => {
  const log = Array.from({ length: 2000 }, (_, i) => `Zeile ${i}`).join('\n');
  const tail = logTail(log, 200);
  expect(tail.length).toBeLessThanOrEqual(200);
  expect(tail.startsWith('Zeile ')).toBe(true);
  expect(tail.endsWith('Zeile 1999')).toBe(true);
  expect(logTail('kurz')).toBe('kurz');
  expect(logTail(null)).toBe('');
});
