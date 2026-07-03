import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import { loadEnv, type Env } from './env.js';
import { createPgClient, type DbClient } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { loggerOptions } from './lib/redact.js';
import { registerSecurityHeaders } from './lib/security-headers.js';
import { registerRateLimits } from './lib/rate-limit.js';
import { registerGithubAuth, type GithubAuthDeps } from './auth/github.js';
import { registerEmailAuth } from './auth/email.js';
import { registerPasswordReset } from './auth/reset.js';
import { registerRevoke } from './auth/revoke.js';
import { registerDevices } from './routes/devices.js';
import { registerFiles } from './routes/files.js';
import { registerSync } from './routes/sync.js';
import { ApiError } from './lib/errors.js';
import { maybeServeWebApp } from './lib/web.js';

export interface BuildOpts {
  env?: Env;
  db?: DbClient;
  skipMigrations?: boolean;
  githubDeps?: Partial<GithubAuthDeps>;
  disableRateLimit?: boolean;
}

export async function buildApp(opts: BuildOpts = {}): Promise<{ app: FastifyInstance; db: DbClient; env: Env }> {
  const env = opts.env ?? loadEnv();
  let db = opts.db;
  if (!db) {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL required');
    db = createPgClient(env.DATABASE_URL);
  }
  if (!opts.skipMigrations && !opts.db) await runMigrations(db);

  const app = Fastify({
    logger: loggerOptions(),
    trustProxy: env.AUTH_TRUST_HOST,
    bodyLimit: 2 * 1024 * 1024,
    disableRequestLogging: false,
  });

  await app.register(cookie, { secret: env.AUTH_SECRET });
  await app.register(sensible);
  registerSecurityHeaders(app);
  if (!opts.disableRateLimit) await registerRateLimits(app, env);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.status).send(err.toJSON());
    }
    req.log.error({ err }, 'unhandled');
    return reply.code(500).send({ error: { code: 'internal', message: 'internal error' } });
  });

  app.get('/healthz', async (req, reply) => {
    try {
      await db!.query('SELECT 1');
      return { ok: true, db: 'up' };
    } catch (err) {
      // Return 503 (not 200) when the DB is unreachable so load balancers / uptime
      // checks actually treat the instance as unhealthy and stop routing to it.
      req.log.error({ err }, 'healthz db check failed');
      return reply.code(503).send({ ok: false, db: 'down' });
    }
  });

  registerEmailAuth(app, db);
  registerPasswordReset(app, db, env);
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    registerGithubAuth(app, { db, env: env as GithubAuthDeps['env'], ...opts.githubDeps });
  }
  registerRevoke(app, db);
  registerDevices(app, db);
  registerFiles(app, db, env);
  registerSync(app, db);

  await maybeServeWebApp(app);

  app.addHook('onClose', async () => {
    if (!opts.db) await db!.end();
  });

  return { app, db, env };
}

const isMain = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMain) {
  const { app, env } = await buildApp();
  await app.listen({ host: '0.0.0.0', port: env.PORT });
}



