import crypto from 'node:crypto';

/**
 * Zeitbasierte Einmalcodes nach RFC 6238 (SHA-1, 6 Stellen, 30 Sekunden) –
 * das, was jede Authenticator-App versteht. Bewusst ohne Fremdpaket.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Ungültiges Base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function hotp(secret: string, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

export function totp(secret: string, now = Date.now()): string {
  return hotp(secret, Math.floor(now / 1000 / STEP_SECONDS));
}

/**
 * Prüft einen Code mit ±1 Zeitschritt Toleranz (Uhren gehen selten genau).
 * Gibt den getroffenen Zeitschritt zurück, damit ein Code nicht zweimal
 * verwendet werden kann.
 */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  const input = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(input)) return null;
  const step = Math.floor(now / 1000 / STEP_SECONDS);
  for (const candidate of [step, step - 1, step + 1]) {
    const expected = hotp(secret, candidate);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(input))) return candidate;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer = 'MCPanel'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
