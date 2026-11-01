import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, requireServer } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { HttpError } from '../lib/errors.js';
import { askAssistant } from '../services/assistant.js';
import { executeAction } from '../services/assistantActions.js';

const askSchema = z.object({
  /** Leer: das Panel bittet um die Absturzanalyse. */
  question: z.string().max(2000).optional(),
  /** Bisheriger Verlauf – der Client hält ihn, das Panel merkt sich nichts. */
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(12_000) }))
    .max(20)
    .default([]),
});

const freigabeSchema = z.object({
  /** Vorher ein Backup anlegen (nur wo der Vorschlag es anbietet). */
  sicherung: z.boolean().default(false),
  /** Abgetippter Servername bei riskanten Vorschlägen. */
  bestaetigung: z.string().max(100).optional(),
});

/**
 * KI-Assistent je Server. Wer die Konsole lesen darf, darf auch fragen –
 * mehr als das Protokoll und die Dateiliste bekommt der Dienst nicht zu sehen.
 * Reparaturen schlägt er nur vor; jede einzelne braucht eine Freigabe über
 * `/actions/:actionId/execute` und das passende eigene Recht.
 */
export default async function assistantRoutes(app: FastifyInstance) {
  app.post(
    '/ask',
    {
      config: {
        // Jede Frage kostet beim Anbieter Geld – ein hängender Klick-Finger
        // soll das Guthaben nicht leeren.
        rateLimit: {
          max: 12,
          timeWindow: '1 minute',
          errorResponseBuilder: () =>
            new HttpError(429, 'Zu viele Anfragen an den KI-Assistenten. Bitte warte eine Minute.'),
        },
      },
    },
    async (req) => {
      const access = await requireServer(req, PERMISSIONS.CONSOLE_READ);
      const body = askSchema.parse(req.body ?? {});

      const result = await askAssistant(access.server, body.question ?? null, body.history, {
        access,
        userId: req.user!.id,
      });
      await audit(
        req.user!.id,
        access.server.id,
        'assistant.ask',
        body.question?.slice(0, 120) || 'Absturzanalyse',
      );
      return result;
    },
  );

  app.post(
    '/actions/:actionId/execute',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
          errorResponseBuilder: () =>
            new HttpError(429, 'Zu viele Freigaben in kurzer Zeit. Bitte warte eine Minute.'),
        },
      },
    },
    async (req) => {
      // Das eigentliche Recht prüft executeAction je Aktion frisch.
      const access = await requireServer(req, PERMISSIONS.CONSOLE_READ);
      const { actionId } = req.params as { actionId: string };
      const body = freigabeSchema.parse(req.body ?? {});
      return executeAction(req.user!, access.server.id, actionId, body);
    },
  );
}
