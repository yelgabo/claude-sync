import type { FastifyInstance } from 'fastify';
import { ApiError } from './errors.js';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.removeHeader('X-Powered-By');
    return payload;
  });
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    if (!MUTATING.has(req.method)) return;
    const xrw = req.headers['x-requested-with'];
    if (xrw !== 'claude-sync') throw new ApiError('invalid_request', 'missing X-Requested-With');
  });
}
