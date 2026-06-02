import { randomBytes, createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '../db/client.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from './password.js';
import { revokeAllSessions } from './session.js';

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const RequestBody = z.object({
  email: z.string().email().max(254),
});

const ConfirmBody = z.object({
  token: z.string().min(1).max(256),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
});

function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function registerPasswordReset(app: FastifyInstance, db: DbClient, env: Env): void {
  // Request a reset link. Always returns 200 with no hint about whether the email
  // exists — no account-enumeration oracle. The raw token only ever leaves the server
  // inside the link (logged here; wire real email later). In dev/test we echo the URL
  // so the flow is exercisable end-to-end.
  app.post('/auth/reset/request', async (req) => {
    const parsed = RequestBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError('invalid_request', 'valid email required');
    const email = normalizeEmail(parsed.data.email);

    const r = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = $1 AND password_hash IS NOT NULL LIMIT 1`,
      [email],
    );
    let resetUrl: string | undefined;
    const user = r.rows[0];
    if (user) {
      const token = randomBytes(32).toString('base64url');
      const tokenHash = sha256hex(token);
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
      await db.query(
        `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
        [uuidv4(), user.id, tokenHash, expiresAt],
      );
      resetUrl = `${env.AUTH_URL.replace(/\/$/, '')}/reset.html?token=${token}`;
      req.log.info({ email, resetUrl }, 'password reset link issued');
    }

    // Dev/test: surface the URL so it can be followed without an email provider.
    if (env.NODE_ENV !== 'production' && resetUrl) {
      return { ok: true, reset_url: resetUrl };
    }
    return { ok: true };
  });

  // Confirm a reset: consume the token, set the new password, revoke all sessions
  // (forces re-login everywhere with the new credential).
  app.post('/auth/reset/confirm', async (req) => {
    const parsed = ConfirmBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('invalid_request', parsed.error.issues.map((i) => i.message).join('; '));
    }
    const tokenHash = sha256hex(parsed.data.token);

    const r = await db.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() LIMIT 1`,
      [tokenHash],
    );
    const row = r.rows[0];
    if (!row) throw new ApiError('invalid_request', 'invalid or expired reset token');

    const newHash = await hashPassword(parsed.data.password);

    await db.transaction(async (tx) => {
      // Re-check + consume the token inside the tx so two concurrent confirms can't
      // both succeed on the same token.
      const consume = await tx.query<{ id: string }>(
        `UPDATE password_reset_tokens SET used_at = now()
         WHERE id = $1 AND used_at IS NULL AND expires_at > now()
         RETURNING id`,
        [row.id],
      );
      if (consume.rows.length === 0) throw new ApiError('invalid_request', 'invalid or expired reset token');

      await tx.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [row.user_id, newHash]);
      // Invalidate any tokens still outstanding for this user.
      await tx.query(
        `UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
        [row.user_id],
      );
      await revokeAllSessions(tx, row.user_id);
    });

    return { ok: true };
  });
}
