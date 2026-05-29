import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '../db/client.js';
import { ApiError } from '../lib/errors.js';
import { ensureUserSeqRow } from '../lib/seq.js';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from './password.js';
import { createSession, setSessionCookie, makeSessionMiddleware, clearSessionCookie, revokeSession } from './session.js';

const Credentials = z.object({
  email: z.string().email().max(254),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
});

function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

export function registerEmailAuth(app: FastifyInstance, db: DbClient): void {
  const session = makeSessionMiddleware(db);

  app.post('/auth/signup', async (req, reply) => {
    const parsed = Credentials.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('invalid_request', parsed.error.issues.map((i) => i.message).join('; '));
    }
    const email = normalizeEmail(parsed.data.email);

    // Pre-check duplicate before paying scrypt cost (~500 ms / 134 MiB). The
    // unique-constraint catch below still handles the TOCTOU race between two
    // concurrent signups for the same email.
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = $1 LIMIT 1`,
      [email],
    );
    if (existing.rows.length > 0) {
      throw new ApiError('conflict', 'email already registered');
    }

    const hash = await hashPassword(parsed.data.password);

    const id = uuidv4();
    try {
      await db.query(
        `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
        [id, email, hash],
      );
    } catch (e) {
      // 23505 = unique_violation on users_email_lower_uniq
      if ((e as { code?: string }).code === '23505') {
        throw new ApiError('conflict', 'email already registered');
      }
      throw e;
    }
    await ensureUserSeqRow(db, id);

    const sessionId = await createSession(db, id, null);
    setSessionCookie(reply, sessionId);
    return { user: { id, email } };
  });

  app.post('/auth/login', async (req, reply) => {
    const parsed = Credentials.safeParse(req.body);
    if (!parsed.success) throw new ApiError('invalid_request', 'email and password required');
    const email = normalizeEmail(parsed.data.email);

    // Uniform error message for "no such user" and "wrong password" — no account-enum oracle.
    const r = await db.query<{ id: string; password_hash: string | null }>(
      `SELECT id, password_hash FROM users WHERE lower(email) = $1 LIMIT 1`,
      [email],
    );
    const row = r.rows[0];
    // Always run a verify to keep timing roughly equal even when the user doesn't exist
    // (verify against a constant dummy hash; result discarded).
    const DUMMY = 'scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
                  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const hash = row?.password_hash ?? DUMMY;
    const ok = await verifyPassword(parsed.data.password, hash);
    if (!row || !row.password_hash || !ok) {
      throw new ApiError('unauthorized', 'invalid email or password');
    }

    const sessionId = await createSession(db, row.id, null);
    setSessionCookie(reply, sessionId);
    return { user: { id: row.id, email } };
  });

  app.post('/auth/logout-current', { preHandler: session }, async (req, reply) => {
    // Convenience alias since /auth/logout is already registered by registerRevoke.
    await revokeSession(db, req.session!.id);
    clearSessionCookie(reply);
    return { ok: true };
  });
}
