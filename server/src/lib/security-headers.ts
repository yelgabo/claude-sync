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
    // CSRF defense: the session cookie is SameSite=strict, but require a custom header
    // that a cross-site <form>/simple request cannot set as defense-in-depth. Cover
    // BOTH /api/ mutations and state-changing /auth/* POSTs (login, signup, logout,
    // password reset request/confirm). GET flows (e.g. /auth/github OAuth redirects)
    // are non-mutating and intentionally exempt. The CLI, web, and reset-page clients
    // already send `X-Requested-With: claude-sync` on every mutating request.
    const path = req.url.split('?', 1)[0] ?? req.url;
    const guarded = path.startsWith('/api/') || path.startsWith('/auth/');
    if (!guarded) return;
    if (!MUTATING.has(req.method)) return;
    const xrw = req.headers['x-requested-with'];
    if (xrw !== 'claude-sync') throw new ApiError('invalid_request', 'missing X-Requested-With');
  });
}
