import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/**
 * `purpose` trennt die Tokenarten: eine Sitzung (ohne Angabe, wie bisher),
 * ein kurzlebiger Download-Link für genau eine Adresse und der Zwischenschritt
 * einer Anmeldung mit zweitem Faktor. Nur Sitzungstoken öffnen die API.
 */
export interface TokenPayload {
  sub: string;
  username: string;
  role: 'ADMIN' | 'USER';
  sessionVersion?: number;
  /** Gerätesitzung (Tabelle Session). Ältere Token ohne Angabe gelten weiter bis zum Ablauf. */
  sid?: string;
  purpose?: 'download' | 'mfa';
  /** Nur bei Download-Token: die gebundene Adresse samt Abfrage. */
  path?: string;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn as never });
}

/** Zwei Minuten reichen, damit der Browser den Download beginnt. */
export function signDownloadToken(payload: Omit<TokenPayload, 'purpose'>, path: string): string {
  return jwt.sign({ ...payload, purpose: 'download', path }, config.jwtSecret, { expiresIn: 120 });
}

/** Passwort war richtig, es fehlt noch der Einmalcode. */
export function signMfaToken(payload: Omit<TokenPayload, 'purpose'>): string {
  return jwt.sign({ ...payload, purpose: 'mfa' }, config.jwtSecret, { expiresIn: 300 });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, config.jwtSecret) as TokenPayload;
}
