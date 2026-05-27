import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Serve the web app at /app/* and / when the static bundle exists alongside the server.
// In production the Dockerfile copies web/dist to ./web in the runtime image.
export async function maybeServeWebApp(app: FastifyInstance): Promise<void> {
  const candidates = [
    resolve(__dirname, '..', '..', '..', 'web'),         // dist/lib/web.js -> ../../../web
    resolve(__dirname, '..', '..', '..', '..', 'web', 'dist'), // dev: web/dist from monorepo root
  ];
  const root = candidates.find((p) => existsSync(p));
  if (!root) {
    app.log.info('web app bundle not found; serving API only');
    return;
  }
  const fastifyStatic = (await import('@fastify/static')).default;
  await app.register(fastifyStatic, { root, prefix: '/', decorateReply: false });
  app.log.info({ root }, 'serving web app');
}