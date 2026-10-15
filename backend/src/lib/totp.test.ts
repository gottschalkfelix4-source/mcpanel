import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateSecret, otpauthUrl, totp, verifyTotp } from './totp.js';

// Testvektoren aus RFC 6238, Anhang B (SHA-1, auf sechs Stellen gekürzt).
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('kodiert Base32 verlustfrei', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(RFC_SECRET).toString()).toBe('12345678901234567890');
    expect(base32Decode('gezd gnbv-gy3t qojq====').toString()).toBe('1234567890');
    expect(() => base32Decode('01!')).toThrow();
  });

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('liefert zum Zeitpunkt %i den RFC-Code %s', (seconds, code) => {
    expect(totp(RFC_SECRET, seconds * 1000)).toBe(code);
  });

  it('akzeptiert einen Zeitschritt Abweichung und nennt den getroffenen Schritt', () => {
    const now = 1234567890 * 1000;
    const step = Math.floor(1234567890 / 30);
    expect(verifyTotp(RFC_SECRET, '005924', now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now - 30_000), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now + 30_000), now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now - 90_000), now)).toBeNull();
  });

  it('weist alles ab, was kein sechsstelliger Code ist', () => {
    for (const code of ['', '12345', '1234567', 'abcdef', '00592a']) {
      expect(verifyTotp(RFC_SECRET, code, 1234567890 * 1000)).toBeNull();
    }
    // Leerzeichen aus dem Abtippen stören nicht.
    expect(verifyTotp(RFC_SECRET, '005 924', 1234567890 * 1000)).not.toBeNull();
  });

  it('erzeugt zufällige 160-Bit-Geheimnisse und eine gültige otpauth-Adresse', () => {
    const a = generateSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateSecret()).not.toBe(a);
    const url = new URL(otpauthUrl(a, 'felix'));
    expect(url.protocol).toBe('otpauth:');
    expect(url.searchParams.get('secret')).toBe(a);
    expect(url.searchParams.get('issuer')).toBe('MCPanel');
    expect(decodeURIComponent(url.pathname)).toContain('MCPanel:felix');
  });
});
