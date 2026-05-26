import { v4 as uuidv4 } from 'uuid';
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

export function newSessionId(): string {
  return uuidv4();
}

export async function createSession(
  db: DbClient,
  userId: string,
  deviceId: string | null = null,
): Promise<string> {
  const id = newSessionId();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.query(
    `INSERT INTO sessions (id, user_id, device_id, expires_at) VALUES ($1, $2, $3, $4)`,
    [id, userId, deviceId, expires],
  );
  return id;
}

export async function loadActiveSession(db: DbClient, id: string): Promise<SessionRow | null> {
  const r = await db.query<SessionRow>(
    `SELECT id, user_id, device_id, expires_at, revoked_at FROM sessions
     WHERE id = $1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1`,
    [id],
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

export function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
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
    const id = req.cookies[SESSION_COOKIE];
    if (!id) throw new ApiError('unauthorized', 'no session');
    const session = await loadActiveSession(db, id);
    if (!session) throw new ApiError('unauthorized', 'session invalid');
    req.user = { id: session.user_id };
    req.session = session;
    await bumpLastSeen(db, id);
  };
}

