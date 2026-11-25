import fs from 'node:fs/promises';
import path from 'node:path';
import webpush from 'web-push';
import type { NotificationChannel, PushSubscription as PushSubscriptionRow } from '@prisma/client';
import { prisma } from '../db.js';
import { config } from '../config.js';

/**
 * Web-Push (PWA): das Panel meldet Ereignisse direkt auf die Geräte, auf
 * denen die App installiert ist – ohne Discord, Webhook oder E-Mail.
 *
 * Die Zustellung läuft über den Push-Dienst des Browsers (FCM, Mozilla …).
 * Dafür braucht das Panel ein VAPID-Schlüsselpaar; es liegt – wie das
 * Sitzungs-Geheimnis – im Datenverzeichnis und wird beim ersten Start
 * erzeugt. Wer das Panel umzieht, nimmt die Datei mit: unveränderte
 * Schlüssel halten die Abos der Geräte gültig.
 */

const VAPID_FILE = '.vapid-keys';
const SUBJECT = 'mailto:mcpanel@localhost';

interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

let keysPromise: Promise<VapidKeyPair> | null = null;
let configured = false;

/**
 * Lädt das VAPID-Schlüsselpaar oder erzeugt und speichert es. Ein einziges
 * Promise stellt sicher, dass auch gleichzeitige Erstaufrufe (zwei Tabs,
 * mehrere Server-Container) dasselbe Paar bekommen – zwei Paare würden die
 * Abos der Geräte gegenseitig ungültig machen.
 */
export function ensureVapidKeys(): Promise<VapidKeyPair> {
  keysPromise ??= (async () => {
    const file = path.join(config.dataRoot, VAPID_FILE);
    let pair: VapidKeyPair | null = null;
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as VapidKeyPair;
      if (parsed.publicKey && parsed.privateKey) pair = parsed;
    } catch {
      /* erste Start – unten wird erzeugt */
    }
    if (!pair) {
      pair = webpush.generateVAPIDKeys();
      await fs.mkdir(config.dataRoot, { recursive: true });
      await fs.writeFile(file, JSON.stringify(pair, null, 2), { mode: 0o600 });
    }
    if (!configured) {
      webpush.setVapidDetails(SUBJECT, pair.publicKey, pair.privateKey);
      configured = true;
    }
    return pair;
  })();
  return keysPromise;
}

/**
 * Öffentlicher Schlüssel für den Browser. `applicationServerKey` verlangt
 * base64url ohne Auffüllung – die beim Erzeugen entstandenen `=` entfernen.
 */
export async function publicVapidKey(): Promise<string> {
  const pair = await ensureVapidKeys();
  return pair.publicKey.replace(/=+$/, '');
}

function subscriptionOf(row: PushSubscriptionRow): webpush.PushSubscription {
  return { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
}

/**
 * Zustellung an alle Geräte des Kanal-Besitzers. Wirft, wenn kein Gerät
 * angemeldet ist oder keine einzige Zustellung gelang – der Aufrufer
 * schreibt dann in `lastStatus`, dass etwas hakt. Verwaiste Abos (der
 * Push-Dienst kennt den Endpoint nicht mehr: 404/410) werden entfernt.
 */
export async function sendPush(channel: NotificationChannel, payload: unknown): Promise<{ delivered: number }> {
  if (!channel.userId) throw new Error('Push-Kanal ohne Besitzer');
  await ensureVapidKeys();

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId: channel.userId, user: { active: true } },
  });
  if (subscriptions.length === 0) {
    throw new Error('Kein Gerät für Push-Benachrichtigungen angemeldet');
  }

  const body = JSON.stringify(payload);
  let delivered = 0;
  let ersterFehler: string | null = null;
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(subscriptionOf(sub), body);
      delivered++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // Das Gerät hat das Abo verloren (Browser-Daten gelöscht …) – aufräumen.
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        continue;
      }
      ersterFehler ??= err instanceof Error ? err.message : String(err);
    }
  }
  if (delivered === 0 && ersterFehler) throw new Error(ersterFehler);
  return { delivered };
}
