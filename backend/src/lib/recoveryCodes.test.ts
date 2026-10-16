import { describe, expect, it } from 'vitest';
import { generateRecoveryCodes, hashRecoveryCode, looksLikeRecoveryCode, normalizeRecoveryCode } from './recoveryCodes.js';

describe('Wiederherstellungscodes', () => {
  it('erzeugt zehn verschiedene Codes im Format XXXXX-XXXXX ohne verwechselbare Zeichen', () => {
    const { codes, hashes } = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-HJKMNP-TV-Z2-9]{5}-[A-HJKMNP-TV-Z2-9]{5}$/);
    expect(hashes).toEqual(codes.map(hashRecoveryCode));
  });

  it('speichert nur Hashes und vergleicht unabhängig von Schreibweise, Leerzeichen und Bindestrich', () => {
    const { codes, hashes } = generateRecoveryCodes(1);
    expect(hashes[0]).not.toContain(codes[0].replace('-', ''));
    const lax = ` ${codes[0].toLowerCase().replace('-', ' ')} `;
    expect(normalizeRecoveryCode(lax)).toBe(codes[0].replace('-', ''));
    expect(hashRecoveryCode(lax)).toBe(hashes[0]);
  });

  it('unterscheidet Wiederherstellungscodes von sechsstelligen Einmalcodes', () => {
    expect(looksLikeRecoveryCode('ABCDE-23456')).toBe(true);
    expect(looksLikeRecoveryCode('abcde23456')).toBe(true);
    expect(looksLikeRecoveryCode('123456')).toBe(false);
    expect(looksLikeRecoveryCode('1234567890')).toBe(false);
    expect(looksLikeRecoveryCode('ABCDE-2345')).toBe(false);
  });
});
