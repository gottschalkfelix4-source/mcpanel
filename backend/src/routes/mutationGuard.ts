import type { FastifyInstance } from 'fastify';
import { withServerOperation } from '../services/operations.js';

/** Wrap the handler itself so AsyncLocalStorage covers all awaited work. */
export function guardMutations(app: FastifyInstance) {
  app.addHook('onRoute', options => {
    const methods = Array.isArray(options.method) ? options.method : [options.method];
    if (methods.every(method => method === 'GET' || method === 'HEAD')) return;
    const handler = options.handler;
    options.handler = function(req, reply) {
      return withServerOperation((req.params as { id: string }).id, 'Dateiänderung', async () => handler.call(this, req, reply));
    };
  });
}
