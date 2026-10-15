/**
 * Ersteinrichtung im Browser.
 *
 * Diese Routen sind bewusst *nicht* angemeldet erreichbar – sie müssen es
 * sein, denn es gibt beim ersten Start noch kein Konto. Genau deshalb ist der
 * Zugang hart daran gebunden, dass die Benutzertabelle leer ist: sobald ein
 * Konto existiert, antwortet jeder Schreibzugriff hier mit 403. Sonst könnte
 * sich jeder Besucher jederzeit einen zweiten Administrator anlegen.
 */
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { config } from '../config.js';
import { prisma } from '../db.js';
import { signToken } from '../auth/jwt.js';
import { forbidden } from '../lib/errors.js';
import { getCurseforgeKey, setSetting } from '../services/settings.js';
import * as curseforge from '../providers/curseforge.js';
import * as dockerSvc from '../services/docker.js';

const setupSchema = z.object({
  username: z.string().min(3, 'Mindestens 3 Zeichen').max(32),
  email: z.string().email('Keine gültige E-Mail-Adresse'),
  password: z.string().min(8, 'Mindestens 8 Zeichen').max(200),
  /** Adresse, unter der Spieler die Server erreichen. */
  publicHost: z.string().max(200).optional(),
  curseforgeApiKey: z.string().max(300).optional(),
  setupCode: z.string().max(40).optional(),
});

async function isFresh(): Promise<boolean> {
  return (await prisma.user.count()) === 0;
}

/**
 * Einrichtungscode: Wer das Panel zuerst im Browser öffnet, darf nicht
 * automatisch Administrator werden – sonst gewinnt bei einem offen im Netz
 * stehenden Container der schnellste Fremde. Der Code steht im Container-
 * Protokoll und in `<data>/.setup-code`, beides sieht nur der Betreiber.
 */
let setupCode: string | null = null;
const setupCodeFile = () => path.join(config.dataRoot, '.setup-code');

export async function prepareSetupCode(log: (msg: string) => void): Promise<void> {
  const existing = await fs.readFile(setupCodeFile(), 'utf8').catch(() => '');
  setupCode = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(existing.trim()) ? existing.trim() : null;
  if (!setupCode) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const chars = Array.from(crypto.randomBytes(12), (byte) => alphabet[byte % alphabet.length]).join('');
    setupCode = `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
    await fs.writeFile(setupCodeFile(), `${setupCode}\n`, { mode: 0o600 }).catch(() => {});
  }
  log(`Einrichtungscode für den Assistenten: ${setupCode} (steht auch in ${setupCodeFile()})`);
}

function assertSetupCode(code: string | undefined): void {
  const expected = Buffer.from(setupCode ?? '');
  // Abgetippt wird gern ohne Bindestriche oder mit Leerzeichen.
  const plain = (code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const given = Buffer.from(plain.length === 12 ? `${plain.slice(0, 4)}-${plain.slice(4, 8)}-${plain.slice(8)}` : plain);
  if (!setupCode || expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    throw forbidden('Einrichtungscode ist falsch. Er steht im Protokoll des Containers.');
  }
}

const setupLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export default async function setupRoutes(app: FastifyInstance) {
  /** Zustand für die Oberfläche: Assistent zeigen oder Anmeldung? */
  app.get('/status', async () => {
    const needsSetup = await isFresh();
    const build = {
      version: config.build.version || null,
      revision: config.build.revision ? config.build.revision.slice(0, 7) : null,
      date: config.build.date || null,
    };
    // Nach der Einrichtung braucht die Anmeldeseite nur noch den Stand –
    // Docker-Version, Pfade und Portbereich gehen Unangemeldete nichts an.
    if (!needsSetup) return { needsSetup, build };

    // Ohne Docker-Socket kann das Panel keine Server starten – das soll man
    // in der Einrichtung sehen und nicht erst beim ersten Serverstart.
    let docker: { ok: boolean; message: string };
    try {
      const version = await dockerSvc.docker.version();
      docker = { ok: true, message: `Docker ${version.Version}` };
    } catch (err) {
      docker = {
        ok: false,
        message: 'Docker-Socket nicht erreichbar – ist /var/run/docker.sock eingebunden?',
      };
    }

    return {
      needsSetup,
      // Damit man auch ohne Anmeldung sieht, welcher Stand laeuft - genau die
      // Frage, die sich stellt, wenn statt des Assistenten die Anmeldung kommt.
      build,
      docker,
      setupCodeRequired: true,
      /** Vorschlag für das Adressfeld. */
      suggestedHost: config.publicHost,
      portRange: config.portRange,
      dataRoot: config.dataRoot,
      curseforgeConfigured: Boolean(await getCurseforgeKey()),
    };
  });

  /** Prüft einen CurseForge-Schlüssel, bevor er gespeichert wird. */
  app.post('/check-curseforge', { config: setupLimit }, async (req) => {
    if (!(await isFresh())) throw forbidden('Die Einrichtung ist bereits abgeschlossen');
    const { apiKey, setupCode: code } = z.object({ apiKey: z.string().min(1), setupCode: z.string().max(40).optional() }).parse(req.body);
    assertSetupCode(code);

    try {
      await curseforge.verifyKey(apiKey);
      return { ok: true, message: 'Schlüssel akzeptiert' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message.slice(0, 200) : 'Schlüssel abgelehnt',
      };
    }
  });

  app.post('/', { config: setupLimit }, async (req, reply) => {
    if (!(await isFresh())) throw forbidden('Die Einrichtung ist bereits abgeschlossen');
    const body = setupSchema.parse(req.body);
    assertSetupCode(body.setupCode);

    const passwordHash = await bcrypt.hash(body.password, 10);
    const user = await prisma.$transaction(async (tx) => {
      // Shared database lock: concurrent processes cannot both finish setup.
      await tx.$executeRaw`LOCK TABLE "User" IN EXCLUSIVE MODE`;
      if (await tx.user.count()) throw forbidden('Die Einrichtung ist bereits abgeschlossen');
      const created = await tx.user.create({ data: {
        email: body.email.toLowerCase(), username: body.username, role: 'ADMIN', passwordHash,
      } });
      for (const [key, value] of [['panel.publicHost', body.publicHost], ['curseforge.apiKey', body.curseforgeApiKey]]) {
        if (value?.trim()) await tx.setting.upsert({ where: { key: key! }, create: { key: key!, value: value.trim() }, update: { value: value.trim() } });
      }
      return created;
    });

    await prisma.auditLog
      .create({ data: { userId: user.id, action: 'setup.complete', detail: user.username } })
      .catch(() => {});
    setupCode = null;
    await fs.rm(setupCodeFile(), { force: true }).catch(() => {});

    // Direkt angemeldet weiterleiten – ein frisch gesetztes Passwort noch
    // einmal eintippen zu lassen, wäre reine Schikane.
    const token = signToken({ sub: user.id, username: user.username, role: user.role, sessionVersion: user.sessionVersion });
    reply.code(201);
    return {
      token,
      user: { id: user.id, email: user.email, username: user.username, role: user.role },
    };
  });
}
