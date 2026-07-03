import type { FastifyInstance, FastifyRequest } from 'fastify';
import { validate as uuidValidate, version as uuidVersion } from 'uuid';
import type { DbClient } from '../db/client.js';
import type { Env } from '../env.js';
import { makeSessionMiddleware } from '../auth/session.js';
import { ApiError } from '../lib/errors.js';
import { allocateSeq, ensureUserSeqRow } from '../lib/seq.js';
import { canonicalizePath } from '../lib/path-canon.js';

const MAX_CONTENT = 1024 * 1024; // 1 MiB

// Pagination: list endpoints previously returned every row (unbounded), which is a
// memory/latency footgun for accounts with many files/versions. Cap the page size and
// paginate with a `seq`-based cursor (results are ordered by seq DESC, so the cursor is
// an exclusive "seq < cursor" bound). `next_cursor` is the last row's seq when a full
// page was returned, else null.
const DEFAULT_PAGE = 200;
const MAX_PAGE = 500;

function clampLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE;
  return Math.min(Math.floor(n), MAX_PAGE);
}

// Parse an optional cursor (an exclusive seq upper bound). Rejects garbage rather than
// silently ignoring it, so a client bug can't accidentally page over the whole table.
function parseCursor(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new ApiError('invalid_request', 'cursor must be a non-negative integer seq');
  }
  return n;
}

interface FileParams { fileId: string }
interface VersionParams { fileId: string; versionId: string }

function requireUuid(s: string, v: 4 | 7, label: string): void {
  if (!uuidValidate(s)) throw new ApiError('invalid_request', `${label} not a uuid`);
  if (uuidVersion(s) !== v) throw new ApiError('invalid_request', `${label} must be uuid v${v}`);
}

function requireDeviceBound(req: FastifyRequest): string {
  const d = req.session?.device_id;
  if (!d) throw new ApiError('precondition_required', 'session not device-bound; POST /api/devices first');
  return d;
}

// Shared ownership/existence check. Returns true if (fileId, userId) exists
// (creates row implicitly is NOT this helper's job — caller decides).
// Uniform "not found" semantics: foreign file_id returns false, not throws.
async function fileExistsForUser(tx: DbClient, fileId: string, userId: string): Promise<{ exists: boolean; foreign: boolean }> {
  const r = await tx.query<{ user_id: string }>(`SELECT user_id FROM files WHERE id = $1`, [fileId]);
  if (r.rows.length === 0) return { exists: false, foreign: false };
  return { exists: true, foreign: r.rows[0]!.user_id !== userId };
}

// File content is stored as plaintext. The server's job is to (a) validate inputs,
// (b) enforce the size cap and per-user quota, and (c) keep bytes identical end-to-end.

export function registerFiles(app: FastifyInstance, db: DbClient, env: Env): void {
  const session = makeSessionMiddleware(db);

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_CONTENT + 1024 },
    (_req, body, done) => done(null, body),
  );

  // List files (latest version per file, including tombstones with deleted=true).
  // Paginated: `?limit=<=500&cursor=<seq>`, ordered by latest seq DESC.
  app.get<{ Querystring: { path?: string; limit?: string; cursor?: string } }>('/api/files', { preHandler: session }, async (req) => {
    const filterPath = req.query.path;
    const limit = clampLimit(req.query.limit);
    const cursor = parseCursor(req.query.cursor);
    const params: unknown[] = [req.user!.id];
    let where = `f.user_id = $1`;
    if (typeof filterPath === 'string') {
      try { params.push(canonicalizePath(filterPath)); }
      catch { throw new ApiError('invalid_request', 'invalid path filter'); }
      where += ` AND f.path = $${params.length}`;
    }
    if (cursor !== null) {
      params.push(cursor);
      where += ` AND lv.seq < $${params.length}`;
    }
    params.push(limit);
    const limitIdx = params.length;
    const r = await db.query<{
      file_id: string; path: string | null; latest_version_id: string;
      latest_seq: string | number; updated_at: Date; size_bytes: number; deleted: boolean;
    }>(
      `SELECT f.id AS file_id, f.path, lv.id AS latest_version_id, lv.seq AS latest_seq,
              lv.uploaded_at AS updated_at, lv.size_bytes, lv.deleted
       FROM files f
       JOIN LATERAL (
         SELECT v.* FROM file_versions v
         WHERE v.file_id = f.id ORDER BY v.seq DESC LIMIT 1
       ) lv ON true
       WHERE ${where}
       ORDER BY lv.seq DESC
       LIMIT $${limitIdx}`,
      params,
    );
    const files = r.rows.map((row) => ({ ...row, latest_seq: Number(row.latest_seq) }));
    const next_cursor = files.length === limit ? files[files.length - 1]!.latest_seq : null;
    return { files, next_cursor };
  });

  // Shared upload path used by PUT (live) and DELETE (tombstone). Differs only by `deleted` flag,
  // empty-allowed semantics on the body, and what we do to `files.path` on tombstone.
  async function uploadVersion(
    req: FastifyRequest<{ Params: VersionParams }>,
    opts: { deleted: boolean },
  ): Promise<{ version_id: string; seq: number; uploaded_at: Date }> {
    requireUuid(req.params.fileId, 7, 'fileId');
    requireUuid(req.params.versionId, 4, 'versionId');
    const deviceId = requireDeviceBound(req);

    const content = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
    if (content.length > MAX_CONTENT) throw new ApiError('too_large', 'content exceeds 1 MiB');

    let canonPath: string | null = null;
    const xPath = req.headers['x-path'];
    if (typeof xPath === 'string' && xPath.length > 0) {
      try { canonPath = canonicalizePath(xPath); }
      catch (e) { throw new ApiError('invalid_request', `X-Path invalid: ${(e as Error).message}`); }
    }

    await ensureUserSeqRow(db, req.user!.id);

    return db.transaction(async (tx) => {
      const ownership = await fileExistsForUser(tx, req.params.fileId, req.user!.id);
      if (!ownership.exists) {
        if (opts.deleted) throw new ApiError('not_found', 'file not found');
        await tx.query(
          `INSERT INTO files (id, user_id, path) VALUES ($1, $2, $3)`,
          [req.params.fileId, req.user!.id, canonPath],
        );
      } else if (ownership.foreign) {
        throw new ApiError('not_found', 'file not found');
      } else if (opts.deleted) {
        // Tombstone clears path so the slot is reusable for a different file_id later.
        await tx.query(`UPDATE files SET path = NULL, updated_at = now() WHERE id = $1`, [req.params.fileId]);
      } else {
        await tx.query(`UPDATE files SET updated_at = now() WHERE id = $1`, [req.params.fileId]);
      }

      // Version_id uniqueness check — uniform 404 for both same-user and cross-user
      // collisions so the response is not an existence oracle.
      const verExists = await tx.query<{ user_id: string }>(
        `SELECT user_id FROM file_versions WHERE id = $1`, [req.params.versionId],
      );
      if (verExists.rows.length > 0) {
        throw new ApiError('not_found', 'version_id conflict');
      }

      // allocateSeq performs `UPDATE user_seq ... RETURNING`, taking a row-lock on the
      // per-user row that serializes concurrent PUTs from the same user. We run it
      // BEFORE the quota SUM so that the SUM happens inside the per-user critical
      // section — otherwise two concurrent PUTs would both see the pre-INSERT sum
      // (READ COMMITTED snapshot) and both pass the check, allowing transient overshoot.
      // Cost: a rejected quota check still consumes a seq number via the rolled-back UPDATE
      // (Postgres restores the value on ROLLBACK, so monotonicity holds).
      const seq = await allocateSeq(tx, req.user!.id);

      if (!opts.deleted) {
        const liveBytes = await tx.query<{ sum: string | number | null }>(
          `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS sum
           FROM file_versions WHERE user_id = $1 AND NOT deleted`,
          [req.user!.id],
        );
        const cur = Number(liveBytes.rows[0]!.sum ?? 0);
        if (cur + content.length > env.STORAGE_QUOTA_BYTES) {
          throw new ApiError('quota_exceeded', 'per-user storage quota exceeded');
        }
      }

      let ins;
      try {
        ins = await tx.query<{ uploaded_at: Date }>(
          `INSERT INTO file_versions
             (id, file_id, user_id, seq, ciphertext, size_bytes, deleted, uploaded_by_device)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING uploaded_at`,
          [
            req.params.versionId, req.params.fileId, req.user!.id, seq,
            content, content.length, opts.deleted, deviceId,
          ],
        );
      } catch (e) {
        // Race: a concurrent PUT slipped a row in with the same version_id PK
        // between our SELECT and INSERT. Postgres SQLSTATE 23505 = unique_violation.
        // Surface as uniform 404 (matches the deliberate-collision path above).
        const code = (e as { code?: string }).code;
        if (code === '23505') throw new ApiError('not_found', 'version_id conflict');
        throw e;
      }

      return { version_id: req.params.versionId, seq, uploaded_at: ins.rows[0]!.uploaded_at };
    });
  }

  app.put<{ Params: VersionParams }>(
    '/api/files/:fileId/versions/:versionId',
    { preHandler: session },
    async (req) => {
      const r = await uploadVersion(req, { deleted: false });
      return { seq: r.seq, uploaded_at: r.uploaded_at };
    },
  );

  app.delete<{ Params: VersionParams }>(
    '/api/files/:fileId/versions/:versionId',
    { preHandler: session },
    async (req) => uploadVersion(req, { deleted: true }),
  );

  // GET latest version's content
  app.get<{ Params: FileParams }>('/api/files/:fileId', { preHandler: session }, async (req, reply) => {
    requireUuid(req.params.fileId, 7, 'fileId');
    const r = await db.query<{
      id: string; ciphertext: Buffer; seq: string | number;
      deleted: boolean; uploaded_at: Date;
    }>(
      `SELECT v.id, v.ciphertext, v.seq, v.deleted, v.uploaded_at
       FROM files f JOIN file_versions v ON v.file_id = f.id
       WHERE f.id = $1 AND f.user_id = $2
       ORDER BY v.seq DESC LIMIT 1`,
      [req.params.fileId, req.user!.id],
    );
    if (r.rows.length === 0) throw new ApiError('not_found', 'file not found');
    const v = r.rows[0]!;
    if (v.deleted) {
      reply.header('X-Latest-Version-Id', v.id);
      throw new ApiError('gone', 'latest version is a tombstone');
    }
    reply
      .header('Content-Type', 'application/octet-stream')
      .header('X-Version-Id', v.id)
      .header('X-Seq', String(Number(v.seq)));
    return reply.send(v.ciphertext);
  });

  // Version history for a file. Paginated: `?limit=<=500&cursor=<seq>`, seq DESC.
  app.get<{ Params: FileParams; Querystring: { limit?: string; cursor?: string } }>('/api/files/:fileId/versions', { preHandler: session }, async (req) => {
    requireUuid(req.params.fileId, 7, 'fileId');
    const limit = clampLimit(req.query.limit);
    const cursor = parseCursor(req.query.cursor);
    const params: unknown[] = [req.params.fileId, req.user!.id];
    let seqClause = '';
    if (cursor !== null) {
      params.push(cursor);
      seqClause = ` AND v.seq < $${params.length}`;
    }
    params.push(limit);
    const limitIdx = params.length;
    const r = await db.query<{
      id: string; seq: string | number; uploaded_at: Date; size_bytes: number;
      uploaded_by_device: string | null; deleted: boolean;
    }>(
      `SELECT v.id, v.seq, v.uploaded_at, v.size_bytes, v.uploaded_by_device, v.deleted
       FROM files f JOIN file_versions v ON v.file_id = f.id
       WHERE f.id = $1 AND f.user_id = $2${seqClause}
       ORDER BY v.seq DESC
       LIMIT $${limitIdx}`,
      params,
    );
    // Distinguish "no such file" from "file exists but this page is empty" (e.g. cursor
    // past the end): only 404 when the file itself is absent.
    if (r.rows.length === 0) {
      const exists = await db.query<{ id: string }>(
        `SELECT id FROM files WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [req.params.fileId, req.user!.id],
      );
      if (exists.rows.length === 0) throw new ApiError('not_found', 'file not found');
    }
    const versions = r.rows.map((v) => ({ ...v, seq: Number(v.seq) }));
    const next_cursor = versions.length === limit ? versions[versions.length - 1]!.seq : null;
    return { versions, next_cursor };
  });

  app.get<{ Params: VersionParams }>('/api/files/:fileId/versions/:versionId', { preHandler: session }, async (req, reply) => {
    requireUuid(req.params.fileId, 7, 'fileId');
    requireUuid(req.params.versionId, 4, 'versionId');
    const r = await db.query<{
      ciphertext: Buffer; deleted: boolean; uploaded_at: Date; seq: string | number;
    }>(
      `SELECT v.ciphertext, v.deleted, v.uploaded_at, v.seq
       FROM files f JOIN file_versions v ON v.file_id = f.id
       WHERE f.id = $1 AND f.user_id = $2 AND v.id = $3 LIMIT 1`,
      [req.params.fileId, req.user!.id, req.params.versionId],
    );
    if (r.rows.length === 0) throw new ApiError('not_found', 'version not found');
    const v = r.rows[0]!;
    reply
      .header('Content-Type', 'application/octet-stream')
      .header('X-Version-Id', req.params.versionId)
      .header('X-Seq', String(Number(v.seq)))
      .header('X-Deleted', v.deleted ? 'true' : 'false');
    return reply.send(v.ciphertext);
  });
}


