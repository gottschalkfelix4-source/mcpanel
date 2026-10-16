import crypto from 'node:crypto';

/**
 * Wiederherstellungscodes für den zweiten Faktor: zehn Einmalcodes im Format
 * XXXXX-XXXXX (Crockford-ähnliches Alphabet ohne verwechselbare Zeichen).
 * Gespeichert werden nur SHA-256-Hashes – 50 Bit Zufall pro Code machen ein
 * langsames Hashverfahren überflüssig.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const RECOVERY_CODE_COUNT = 10;

function randomBlock(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

/** Großschreibung, ohne Leerzeichen und Bindestriche – so tippt sie jeder anders. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(`mcpanel-recovery:${normalizeRecoveryCode(code)}`).digest('hex');
}

/** Sieht die Eingabe wie ein Wiederherstellungscode aus (statt eines 6-stelligen TOTP)? */
export function looksLikeRecoveryCode(code: string): boolean {
  return /^[A-Z0-9]{10}$/.test(normalizeRecoveryCode(code)) && !/^\d+$/.test(normalizeRecoveryCode(code));
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: count }, () => `${randomBlock(5)}-${randomBlock(5)}`);
  return { codes, hashes: codes.map(hashRecoveryCode) };
}
