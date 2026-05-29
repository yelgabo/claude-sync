import type { FastifyInstance } from 'fastify';
import { ApiError } from './errors.js';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Auth responses carry Set-Cookie with the session token; a misconfigured proxy
    // or CDN must not cache and re-serve them. Also cover anything else that sets
    // a cookie as a backstop.
    if (req.url.startsWith('/auth/') || reply.getHeader('set-cookie')) {
      reply.header('Cache-Control', 'no-store');
    }
    reply.removeHeader('X-Powered-By');
    reply.removeHeader('Server');
    return payload;
  });
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    if (!MUTATING.has(req.method)) return;
    const xrw = req.headers['x-requested-with'];
    if (xrw !== 'claude-sync') throw new ApiError('invalid_request', 'missing X-Requested-With');
  });
}
