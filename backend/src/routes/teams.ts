import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, requireServer } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { applyTeamAction, createParty, listTeams } from '../services/ftbTeams.js';

/**
 * FTB-Teams-Partys (`/api/servers/:id/teams`). Ansehen darf, wer die Konsole
 * lesen darf; ändern, wer Befehle senden darf – dieselben Befehle ließen sich
 * sonst auch von Hand in der Konsole eingeben.
 */
export default async function teamRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const access = await requireServer(req, PERMISSIONS.CONSOLE_READ);
    return { ...(await listTeams(access.server)), canManage: access.can(PERMISSIONS.CONSOLE_COMMAND) };
  });

  const player = z.string().regex(/^[.*]?[A-Za-z0-9_]{1,32}$/, 'Ungültiger Spielername');
  const name = z.string().trim().min(1).max(50).regex(/^[^\r\n\0§]+$/, 'Ungültiger Name');
  const actionSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('disband') }),
    z.object({ type: z.literal('add'), player }),
    z.object({ type: z.literal('remove'), player }),
    z.object({ type: z.literal('transfer'), player }),
    z.object({ type: z.literal('rename'), name }),
  ]);

  app.post('/:partyId/action', async (req) => {
    const access = await requireServer(req, PERMISSIONS.CONSOLE_COMMAND);
    const { partyId } = req.params as { partyId: string };
    const action = actionSchema.parse(req.body);
    const response = await applyTeamAction(access.server, partyId, action);
    await audit(req.user!.id, access.server.id, `teams.${action.type}`, `${partyId}${'player' in action ? ` ${action.player}` : 'name' in action ? ` ${action.name}` : ''}`);
    return { ok: true, response };
  });

  app.post('/', async (req) => {
    const access = await requireServer(req, PERMISSIONS.CONSOLE_COMMAND);
    const body = z.object({ player, name }).parse(req.body);
    const response = await createParty(access.server, body.player, body.name);
    await audit(req.user!.id, access.server.id, 'teams.create', `${body.name} für ${body.player}`);
    return { ok: true, response };
  });
}
