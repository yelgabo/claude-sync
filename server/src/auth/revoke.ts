import type { FastifyInstance } from 'fastify';
import type { DbClient } from '../db/client.js';
import {
  clearSessionCookie, makeSessionMiddleware,
  revokeAllSessions, revokeSession,
} from './session.js';

export function registerRevoke(app: FastifyInstance, db: DbClient): void {
  const session = makeSessionMiddleware(db);

  app.post('/auth/logout', { preHandler: session }, async (req, reply) => {
    await revokeSession(db, req.session!.id);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.post('/auth/sessions/revoke-all', { preHandler: session }, async (req, reply) => {
    await revokeAllSessions(db, req.user!.id);
    clearSessionCookie(reply);
    return { ok: true };
  });
}
