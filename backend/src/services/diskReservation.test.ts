import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ used: 0 }));
vi.mock('./diskUsage.js', () => ({ getDiskUsage: () => ({ total: m.used }) }));

const { reservationMeter, reserveDisk, reservedBytes } = await import('./diskReservation.js');

const MB = 1024 * 1024;
const server = { id: 's', quotaDiskMb: 10 };
beforeEach(() => { m.used = 4 * MB; });

it('lässt parallele Uploads zusammen nicht über das Kontingent', () => {
  const a = reserveDisk(server);
  const b = reserveDisk(server);
  a.update(3 * MB);
  expect(reservedBytes('s')).toBe(3 * MB);
  // Jeder für sich hätte noch 6 MB gehabt – zusammen sind es 7.
  expect(() => b.update(4 * MB)).toThrow(/Speicherkontingent/);
  a.release();
  b.release();
  expect(reservedBytes('s')).toBe(0);
});

it('rechnet eine ersetzte Datei an', () => {
  const a = reserveDisk(server, 5 * MB);
  a.update(9 * MB); // wächst nur um 4 MB
  expect(reservedBytes('s')).toBe(4 * MB);
  a.release();
});

it('kennt ohne Kontingent keine Grenze, zählt aber mit', () => {
  const a = reserveDisk({ id: 'u', quotaDiskMb: 0 });
  a.update(500 * MB);
  expect(reservedBytes('u')).toBe(500 * MB);
  a.release();
  expect(reservedBytes('u')).toBe(0);
});

it('bricht einen Datenstrom ab, sobald das Kontingent voll ist', async () => {
  const other = reserveDisk(server);
  other.update(5 * MB);
  const own = reserveDisk(server);
  let written = 0;
  const sink = new Writable({ write(chunk: Buffer, _e, cb) { written += chunk.length; cb(); } });
  const source = Readable.from(Array.from({ length: 4 }, () => Buffer.alloc(MB)));
  await expect(pipeline(source, reservationMeter(own), sink)).rejects.toThrow(/Speicherkontingent/);
  expect(written).toBeLessThanOrEqual(MB);
  own.release();
  other.release();
});
