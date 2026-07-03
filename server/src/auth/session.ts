import { v4 as uuidv4 } from 'uuid';
import { randomBytes, createHash } from 'node:crypto';
import type { DbClient } from '../db/client.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../lib/errors.js';

export const SESSION_COOKIE = '__Host-session';
export const SESSION_TTL_DAYS = 30;

export interface SessionRow {
  id: string;
  user_id: string;
  device_id: string | null;
  expires_at: Date;
  revoked_at: Date | null;
}

// The cookie carries this high-entropy random token; the DB only ever stores its
// SHA-256 hash. 32 random bytes (256 bits) is well above session-guessing concerns.
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: DbClient,
  userId: string,
  deviceId: string | null = null,
): Promise<string> {
  const id = uuidv4();                 // internal PK, never leaves the server
  const token = newSessionToken();     // goes into the cookie
  const tokenHash = hashSessionToken(token);
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.query(
    `INSERT INTO sessions (id, user_id, device_id, expires_at, token_hash) VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, deviceId, expires, tokenHash],
  );
  return token;
}

export async function loadActiveSession(db: DbClient, token: string): Promise<SessionRow | null> {
  const tokenHash = hashSessionToken(token);
  const r = await db.query<SessionRow>(
    `SELECT id, user_id, device_id, expires_at, revoked_at FROM sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1`,
    [tokenHash],
  );
  return r.rows[0] ?? null;
}

export async function bumpLastSeen(db: DbClient, sessionId: string): Promise<void> {
  await db.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [sessionId]);
}

export async function revokeSession(db: DbClient, id: string): Promise<void> {
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [id]);
}

export async function revokeAllSessions(db: DbClient, userId: string): Promise<void> {
  await db.query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}

export async function bindSessionDevice(db: DbClient, sessionId: string, deviceId: string): Promise<void> {
  await db.query(`UPDATE sessions SET device_id = $1 WHERE id = $2`, [deviceId, sessionId]);
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true, secure: true, sameSite: 'strict', path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string };
    session?: SessionRow;
  }
}

export function makeSessionMiddleware(db: DbClient) {
  return async function sessionMiddleware(req: FastifyRequest): Promise<void> {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw new ApiError('unauthorized', 'no session');
    const session = await loadActiveSession(db, token);
    if (!session) throw new ApiError('unauthorized', 'session invalid');
    req.user = { id: session.user_id };
    req.session = session;
    // Bump by the internal PK, not the cookie token (which is no longer the PK).
    await bumpLastSeen(db, session.id);
  };
}

