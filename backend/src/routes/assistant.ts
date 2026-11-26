import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { audit, requireServer } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { HttpError, publicErrorMessage } from '../lib/errors.js';
import { askAssistant, askAssistantGlobal, askAssistantGlobalStream, askAssistantStream } from '../services/assistant.js';
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
 * Antwort als Server-Sent-Events: `delta`-Events mit Textteilen, am Ende ein
 * `done`-Event mit Modell und Reparaturvorschlägen. Ein Fehler kommt als
 * `error`-Event (Status bleibt 200, weil der Antwortstrom schon läuft) –
 * der Client zeigt die Meldung dann an der richtigen Stelle im Verlauf.
 * `X-Accel-Buffering: no` sagt dem nginx, dass er nicht puffern darf.
 */
async function streamReply(
  reply: FastifyReply,
  run: (send: (event: 'delta' | 'done', data: unknown) => void) => Promise<{ model: string; actions?: unknown[] }>,
): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event: 'delta' | 'done' | 'error', data: unknown) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  try {
    const meta = await run(send);
    send('done', { model: meta.model, actions: meta.actions ?? [] });
  } catch (err) {
    send('error', { message: publicErrorMessage(err, 'Anfrage fehlgeschlagen') });
  } finally {
    reply.raw.end();
  }
}

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

  /** Wie `/ask`, aber als Server-Sent-Events: die Antwort erscheint live. */
  app.post(
    '/ask-stream',
    {
      config: {
        rateLimit: {
          max: 12,
          timeWindow: '1 minute',
          errorResponseBuilder: () =>
            new HttpError(429, 'Zu viele Anfragen an den KI-Assistenten. Bitte warte eine Minute.'),
        },
      },
    },
    async (req, reply) => {
      const access = await requireServer(req, PERMISSIONS.CONSOLE_READ);
      const body = askSchema.parse(req.body ?? {});
      await streamReply(reply, async (send) => {
        const result = await askAssistantStream(
          access.server,
          body.question ?? null,
          body.history,
          { access, userId: req.user!.id },
          (text) => send('delta', { text }),
        );
        await audit(
          req.user!.id,
          access.server.id,
          'assistant.ask',
          body.question?.slice(0, 120) || 'Absturzanalyse',
        );
        return result;
      });
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

/**
 * Globaler Assistent (die Figur unten rechts) ohne Serverkontext. Bewusst
 * OHNE `requireServer`: Der Dienst bekommt keine Serverdaten zu sehen
 * (siehe `GLOBAL_PROMPT` in services/assistant.ts). Wer mit einem Server
 * als Kontext sprechen will, nutzt den Server-Endpunkt – der prüft den
 * Zugriff frisch. So kann niemand über einen fremden Server plaudern.
 */
export async function globalAssistantRoutes(app: FastifyInstance) {
  app.post(
    '/ask',
    {
      config: {
        rateLimit: {
          max: 12,
          timeWindow: '1 minute',
          errorResponseBuilder: () =>
            new HttpError(429, 'Zu viele Anfragen an den KI-Assistenten. Bitte warte eine Minute.'),
        },
      },
    },
    async (req) => {
      const body = askSchema.parse(req.body ?? {});
      const frage = body.question?.trim();
      if (!frage) throw new HttpError(400, 'Bitte eine Frage stellen.');

      const result = await askAssistantGlobal(frage, body.history);
      await audit(req.user!.id, null, 'assistant.ask', frage.slice(0, 120));
      return result;
    },
  );

  /** Wie `/ask`, aber als Server-Sent-Events: die Antwort erscheint live. */
  app.post(
    '/ask-stream',
    {
      config: {
        rateLimit: {
          max: 12,
          timeWindow: '1 minute',
          errorResponseBuilder: () =>
            new HttpError(429, 'Zu viele Anfragen an den KI-Assistenten. Bitte warte eine Minute.'),
        },
      },
    },
    async (req, reply) => {
      const body = askSchema.parse(req.body ?? {});
      const frage = body.question?.trim();
      if (!frage) throw new HttpError(400, 'Bitte eine Frage stellen.');

      await streamReply(reply, async (send) => {
        const result = await askAssistantGlobalStream(frage, body.history, (text) => send('delta', { text }));
        await audit(req.user!.id, null, 'assistant.ask', frage.slice(0, 120));
        return result;
      });
    },
  );
}
