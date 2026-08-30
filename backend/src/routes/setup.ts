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
});

async function isFresh(): Promise<boolean> {
  return (await prisma.user.count()) === 0;
}

export default async function setupRoutes(app: FastifyInstance) {
  /** Zustand für die Oberfläche: Assistent zeigen oder Anmeldung? */
  app.get('/status', async () => {
    const needsSetup = await isFresh();

    // Ohne Docker-Socket kann das Panel keine Server starten – das soll man
    // in der Einrichtung sehen und nicht erst beim ersten Serverstart.
    let docker: { ok: boolean; message: string };
    try {
      const version = await dockerSvc.docker.version();
      docker = { ok: true, message: `Docker ${version.Version}` };
    } catch (err) {
      docker = {
        ok: false,
        message: err instanceof Error ? err.message : 'Docker-Socket nicht erreichbar',
      };
    }

    return {
      needsSetup,
      docker,
      /** Vorschlag für das Adressfeld. */
      suggestedHost: config.publicHost,
      portRange: config.portRange,
      dataRoot: config.dataRoot,
      curseforgeConfigured: Boolean(await getCurseforgeKey()),
    };
  });

  /** Prüft einen CurseForge-Schlüssel, bevor er gespeichert wird. */
  app.post('/check-curseforge', async (req) => {
    if (!(await isFresh())) throw forbidden('Die Einrichtung ist bereits abgeschlossen');
    const { apiKey } = z.object({ apiKey: z.string().min(1) }).parse(req.body);

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

  app.post('/', async (req, reply) => {
    if (!(await isFresh())) throw forbidden('Die Einrichtung ist bereits abgeschlossen');
    const body = setupSchema.parse(req.body);

    const user = await prisma.user.create({
      data: {
        email: body.email.toLowerCase(),
        username: body.username,
        role: 'ADMIN',
        passwordHash: await bcrypt.hash(body.password, 10),
      },
    });

    if (body.publicHost?.trim()) {
      await setSetting('panel.publicHost', body.publicHost.trim());
    }
    if (body.curseforgeApiKey?.trim()) {
      await setSetting('curseforge.apiKey', body.curseforgeApiKey.trim());
    }

    await prisma.auditLog
      .create({ data: { userId: user.id, action: 'setup.complete', detail: user.username } })
      .catch(() => {});

    // Direkt angemeldet weiterleiten – ein frisch gesetztes Passwort noch
    // einmal eintippen zu lassen, wäre reine Schikane.
    const token = signToken({ sub: user.id, username: user.username, role: user.role });
    reply.code(201);
    return {
      token,
      user: { id: user.id, email: user.email, username: user.username, role: user.role },
    };
  });
}
