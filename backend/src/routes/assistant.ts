import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, requireServer } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { HttpError } from '../lib/errors.js';
import { askAssistant } from '../services/assistant.js';

const askSchema = z.object({
  /** Leer: das Panel bittet um die Absturzanalyse. */
  question: z.string().max(2000).optional(),
  /** Bisheriger Verlauf – der Client hält ihn, das Panel merkt sich nichts. */
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(12_000) }))
    .max(20)
    .default([]),
});

/**
 * KI-Assistent je Server. Wer die Konsole lesen darf, darf auch fragen –
 * mehr als das Protokoll und die Dateiliste bekommt der Dienst nicht zu sehen.
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

      const result = await askAssistant(access.server, body.question ?? null, body.history);
      await audit(
        req.user!.id,
        access.server.id,
        'assistant.ask',
        body.question?.slice(0, 120) || 'Absturzanalyse',
      );
      return result;
    },
  );
}
