import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Env } from '../env.js';

export async function registerRateLimits(app: FastifyInstance, env: Env): Promise<void> {
  await app.register(rateLimit, { global: false });

  // Per-user quota for AUTHENTICATED /api/ traffic. Attached below as a preHandler so it
  // runs AFTER the session middleware has validated the cookie and populated req.user —
  // the key is therefore a real user id, never an attacker-supplied, unvalidated cookie.
  // `await` keeps this robust whether the factory is sync or async in this plugin version.
  const perUserApiLimiter = await app.rateLimit({
    max: env.RATE_LIMIT_API_PER_USER,
    timeWindow: '1 minute',
    keyGenerator: (req) => (req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`),
  });

  app.addHook('onRoute', (route) => {
    if (typeof route.url !== 'string') return;
    if (route.url === '/healthz') {
      route.config = {
        ...(route.config ?? {}),
        rateLimit: { max: 60, timeWindow: '1 minute' },
      };
    } else if (route.url.startsWith('/auth/')) {
      route.config = {
        ...(route.config ?? {}),
        rateLimit: { max: env.RATE_LIMIT_AUTH_PER_IP, timeWindow: '1 minute' },
      };
    } else if (route.url.startsWith('/api/')) {
      // (1) Always-on per-IP ceiling, evaluated at onRequest — BEFORE the session
      // middleware validates the cookie. The key is the client IP, NOT the cookie, so an
      // unauthenticated attacker who rotates a forged __Host-session value on every
      // request CANNOT mint a fresh bucket to escape the cap: all requests from that IP
      // share one counter. This also bounds the downstream loadActiveSession DB lookups
      // per IP, preventing DB-load amplification.
      route.config = {
        ...(route.config ?? {}),
        rateLimit: {
          max: env.RATE_LIMIT_API_PER_USER, timeWindow: '1 minute',
          keyGenerator: (req) => `ip:${req.ip}`,
        },
      };
      // (2) Per-user quota, evaluated at preHandler — AFTER session validation — so one
      // authenticated user cannot exhaust another's quota. Appended after the existing
      // preHandlers (which include the session middleware) so req.user is populated.
      const pre = route.preHandler;
      const arr = pre ? (Array.isArray(pre) ? [...pre] : [pre]) : [];
      arr.push(perUserApiLimiter);
      route.preHandler = arr;
    }
  });
}
