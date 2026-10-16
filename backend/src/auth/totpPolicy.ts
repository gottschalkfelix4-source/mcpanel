import type { User } from '@prisma/client';
import { getSetting } from '../services/settings.js';

/** Wer den zweiten Faktor eingerichtet haben muss. */
export type TotpPolicy = 'off' | 'admins' | 'all';
export const TOTP_POLICY_KEY = 'security.requireTotp';
export const TOTP_POLICIES: TotpPolicy[] = ['off', 'admins', 'all'];

export async function getTotpPolicy(): Promise<TotpPolicy> {
  // Nicht-leere Vorgabe, damit der Einstellungscache greift und nicht jede
  // Anfrage die Datenbank fragt.
  const value = await getSetting(TOTP_POLICY_KEY, 'off');
  return (TOTP_POLICIES as string[]).includes(value) ? (value as TotpPolicy) : 'off';
}

export function policyApplies(policy: TotpPolicy, user: Pick<User, 'role'>): boolean {
  return policy === 'all' || (policy === 'admins' && user.role === 'ADMIN');
}

/** Muss dieses Konto den zweiten Faktor erst noch einrichten? */
export async function totpSetupRequired(user: Pick<User, 'role' | 'totpEnabled'>): Promise<boolean> {
  if (user.totpEnabled) return false;
  return policyApplies(await getTotpPolicy(), user);
}

/**
 * Adressen, die ein Konto ohne vorgeschriebenen zweiten Faktor noch erreichen
 * darf: das eigene Profil, die Einrichtung selbst und das Abmelden.
 */
const ALLOWED = [/^\/api\/auth\/me(\?|$)/, /^\/api\/auth\/totp\//, /^\/api\/auth\/logout(\?|$|-all)/, /^\/api\/auth\/sessions(\/|\?|$)/, /^\/api\/settings\/public(\?|$)/];

export function allowedWithoutTotp(url: string): boolean {
  return ALLOWED.some((re) => re.test(url));
}

export const TOTP_REQUIRED_MESSAGE =
  'Für dieses Konto ist die Zwei-Faktor-Anmeldung vorgeschrieben. Bitte richte sie zuerst im Profil ein.';
