import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Env } from '../env.js';

export async function registerRateLimits(app: FastifyInstance, env: Env): Promise<void> {
  await app.register(rateLimit, { global: false });
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
      route.config = {
        ...(route.config ?? {}),
        rateLimit: {
          max: env.RATE_LIMIT_API_PER_USER, timeWindow: '1 minute',
          keyGenerator: (req) => (req.user?.id ?? req.ip),
        },
      };
    }
  });
}
