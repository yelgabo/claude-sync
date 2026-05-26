import type { FastifyInstance } from 'fastify';
import type { DbClient } from '../db/client.js';
import { makeSessionMiddleware } from '../auth/session.js';
import { ApiError } from '../lib/errors.js';

interface SyncQuery { since?: string; limit?: string }

export function registerSync(app: FastifyInstance, db: DbClient): void {
  const session = makeSessionMiddleware(db);

  app.get<{ Querystring: SyncQuery }>('/api/sync', { preHandler: session }, async (req) => {
    const sinceStr = req.query.since ?? '0';
    const limitStr = req.query.limit ?? '100';
    const since = Number(sinceStr);
    const limit = Math.min(Math.max(Number(limitStr) || 100, 1), 500);
    if (!Number.isFinite(since) || since < 0) throw new ApiError('invalid_request', 'since must be a non-negative integer');

    const r = await db.query<{
      file_id: string; version_id: string; seq: string | number;
      size_bytes: number; deleted: boolean; path: string | null;
    }>(
      `SELECT v.file_id, v.id AS version_id, v.seq, v.size_bytes, v.deleted, f.path
       FROM file_versions v JOIN files f ON f.id = v.file_id
       WHERE v.user_id = $1 AND v.seq > $2
       ORDER BY v.seq ASC LIMIT $3`,
      [req.user!.id, since, limit + 1],
    );

    const has_more = r.rows.length > limit;
    const changes = (has_more ? r.rows.slice(0, limit) : r.rows).map((c) => ({
      ...c, seq: Number(c.seq),
    }));
    const next_seq = changes.length > 0 ? changes[changes.length - 1]!.seq : since;
    return { changes, next_seq, has_more };
  });
}
