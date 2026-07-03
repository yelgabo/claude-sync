import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Env } from '../env.js';
import { ApiError } from './errors.js';

// A tiny fixed-window per-key limiter, deliberately INDEPENDENT of @fastify/rate-limit.
// The plugin marks a request as "already rate-limited" (req[rateLimitRan]) after the
// FIRST of its limiters runs and short-circuits every subsequent one — so a second,
// plugin-based per-user limiter stacked behind the per-IP onRequest ceiling would
// silently no-op. This standalone limiter is not subject to that dedup, so the per-user
// quota actually enforces on top of the per-IP ceiling.
export function makePerUserLimiter(max: number, windowMs: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = 0;
  // Opportunistic sweep so the map doesn't grow unbounded with one-off user ids.
  function sweep(now: number): void {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
  }
  return async function perUserRateLimit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = req.user?.id;
    // Unauthenticated traffic is bounded by the per-IP onRequest ceiling; nothing to do
    // here until the session middleware has populated req.user.
    if (!userId) return;
    const now = Date.now();
    sweep(now);
    let b = buckets.get(userId);
    if (!b || now >= b.resetAt) { b = { count: 0, resetAt: now + windowMs }; buckets.set(userId, b); }
    b.count += 1;
    if (b.count > max) {
      reply.header('retry-after', String(Math.ceil((b.resetAt - now) / 1000)));
      throw new ApiError('too_many_requests', 'per-user rate limit exceeded');
    }
  };
}

export async function registerRateLimits(app: FastifyInstance, env: Env): Promise<void> {
  // Per-user quota, attached below as a preHandler so it runs AFTER the session
  // middleware has validated the cookie and populated req.user — the key is therefore a
  // real user id, never an attacker-supplied, unvalidated cookie.
  const perUserApiLimiter = makePerUserLimiter(env.RATE_LIMIT_API_PER_USER, 60_000);

  // ORDERING IS LOAD-BEARING. @fastify/rate-limit installs its OWN `onRoute` hook when it
  // is registered, and that hook reads each route's `config.rateLimit` to decide whether
  // to attach a per-route onRequest limiter. Fastify runs onRoute hooks in registration
  // order, so the hook that SETS `config.rateLimit` MUST be registered BEFORE the plugin —
  // otherwise the plugin's hook runs first, sees no config, and the per-IP ceilings on
  // /api/, /auth/, and /healthz are silently never installed.
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

  await app.register(rateLimit, {
    global: false,
    // The plugin THROWS whatever this returns when a limit is exceeded. Return an
    // ApiError so it flows through the app's existing setErrorHandler and yields a
    // proper 429 (a plain Error would be masked as 500 by that handler). `ban` is
    // disabled (default), but map its 403 correctly for robustness.
    errorResponseBuilder: (_req, ctx: { statusCode?: number; after?: string }) =>
      ctx.statusCode === 403
        ? new ApiError('forbidden', 'rate limit ban in effect')
        : new ApiError('too_many_requests', `rate limit exceeded, retry in ${ctx.after ?? 'a moment'}`),
  });
}
