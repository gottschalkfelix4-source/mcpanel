import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeCurseforgeFingerprint, murmurHash2 } from './curseforgeFingerprint.js';

const fixture = (name: string) => path.join(__dirname, '__fixtures__', name);

/**
 * Erwartungswerte aus der Referenz-Implementierung @meza/curseforge-fingerprint
 * (C++-Binding mit denselben Fixture-Dateien); die Werte gelten gegen die
 * echte CurseForge-API als Fingerprints.
 */
describe('computeCurseforgeFingerprint', () => {
  it('entspricht der Referenz-Implementierung (Fixture 1)', async () => {
    const data = await fs.readFile(fixture('cf-test1.md'));
    expect(computeCurseforgeFingerprint(new Uint8Array(data))).toBe(3608199863);
  });

  it('entspricht der Referenz-Implementierung (Fixture 2)', async () => {
    const data = await fs.readFile(fixture('cf-test2.md'));
    expect(computeCurseforgeFingerprint(new Uint8Array(data))).toBe(3493718775);
  });

  it('ist unabhängig von Zeilenenden und Leerzeichen', () => {
    const a = new TextEncoder().encode('Hallo Welt!\nZweite Zeile\r\nDritte');
    const b = new TextEncoder().encode('HalloWelt!ZweiteZeileDritte');
    expect(computeCurseforgeFingerprint(a)).toBe(computeCurseforgeFingerprint(b));
  });

  it('liefert für leere Eingabe den MurmurHash2-Wert des leeren Arrays', () => {
    expect(computeCurseforgeFingerprint(new Uint8Array(0))).toBe(murmurHash2(new Uint8Array(0), 1));
  });
});
