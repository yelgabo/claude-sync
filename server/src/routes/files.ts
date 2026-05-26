import type { FastifyInstance, FastifyRequest } from 'fastify';
import { validate as uuidValidate, version as uuidVersion } from 'uuid';
import type { DbClient } from '../db/client.js';
import type { Env } from '../env.js';
import { makeSessionMiddleware } from '../auth/session.js';
import { ApiError } from '../lib/errors.js';
import { allocateSeq, ensureUserSeqRow } from '../lib/seq.js';
import { canonicalizePath } from '../lib/path-canon.js';

const MAX_CIPHERTEXT = 1024 * 1024; // 1 MiB
const POLY1305_TAG = 16; // minimum valid AEAD ciphertext length

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

function decodeBase64Url(s: string | undefined, label: string): Buffer {
  if (typeof s !== 'string' || s.length === 0) throw new ApiError('invalid_request', `${label} missing`);
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new ApiError('invalid_request', `${label} not base64url`);
  return Buffer.from(s, 'base64url');
}

// Shared ownership/existence check. Returns true if (fileId, userId) exists
// (creates row implicitly is NOT this helper's job — caller decides).
// Uniform "not found" semantics: foreign file_id returns false, not throws.
async function fileExistsForUser(tx: DbClient, fileId: string, userId: string): Promise<{ exists: boolean; foreign: boolean }> {
  const r = await tx.query<{ user_id: string }>(`SELECT user_id FROM files WHERE id = $1`, [fileId]);
  if (r.rows.length === 0) return { exists: false, foreign: false };
  return { exists: true, foreign: r.rows[0]!.user_id !== userId };
}

// SECURITY: the server never decrypts. AAD integrity (binding ciphertext to
// user/file/version/key) is verified by the *reading* client. The server's job
// is to (a) validate inputs, (b) reject obvious garbage (length, uuid version),
// and (c) keep ciphertext byte-identical end-to-end.

export function registerFiles(app: FastifyInstance, db: DbClient, env: Env): void {
  const session = makeSessionMiddleware(db);

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_CIPHERTEXT + 1024 },
    (_req, body, done) => done(null, body),
  );

  // List files (latest version per file, including tombstones with deleted=true)
  app.get<{ Querystring: { path?: string } }>('/api/files', { preHandler: session }, async (req) => {
    const filterPath = req.query.path;
    const params: unknown[] = [req.user!.id];
    let where = `f.user_id = $1`;
    if (typeof filterPath === 'string') {
      try { params.push(canonicalizePath(filterPath)); }
      catch { throw new ApiError('invalid_request', 'invalid path filter'); }
      where += ` AND f.path = $2`;
    }
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
       ORDER BY lv.seq DESC`,
      params,
    );
    return { files: r.rows.map((row) => ({ ...row, latest_seq: Number(row.latest_seq) })) };
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

    const ciphertext = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
    if (ciphertext.length > MAX_CIPHERTEXT) throw new ApiError('too_large', 'ciphertext exceeds 1 MiB');
    // Even tombstones must carry an AEAD over empty plaintext → at least the Poly1305 tag.
    if (ciphertext.length < POLY1305_TAG) {
      throw new ApiError('invalid_request', `ciphertext too short (need >= ${POLY1305_TAG} bytes for AEAD tag)`);
    }

    const nonce = decodeBase64Url(req.headers['x-nonce'] as string | undefined, 'X-Nonce');
    if (nonce.length !== 24) throw new ApiError('invalid_request', 'X-Nonce must decode to 24 bytes');

    const keyIdRaw = req.headers['x-key-id'];
    if (typeof keyIdRaw !== 'string' || !uuidValidate(keyIdRaw)) {
      throw new ApiError('invalid_request', 'X-Key-Id must be a uuid');
    }
    const keyId = keyIdRaw;

    let canonPath: string | null = null;
    const xPath = req.headers['x-path'];
    if (typeof xPath === 'string' && xPath.length > 0) {
      try { canonPath = canonicalizePath(xPath); }
      catch (e) { throw new ApiError('invalid_request', `X-Path invalid: ${(e as Error).message}`); }
    }

    await ensureUserSeqRow(db, req.user!.id);

    return db.transaction(async (tx) => {
      // Verify key matches a registered vault key for this user — INSIDE the tx so
      // a concurrent key-metadata write can't TOCTOU us.
      const vk = await tx.query<{ key_id: string }>(
        `SELECT key_id FROM vault_key_metadata WHERE user_id = $1`, [req.user!.id],
      );
      if (vk.rows.length === 0 || vk.rows[0]!.key_id !== keyId) {
        throw new ApiError('invalid_request', 'X-Key-Id does not match registered vault key');
      }

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
        if (cur + ciphertext.length > env.STORAGE_QUOTA_BYTES) {
          throw new ApiError('quota_exceeded', 'per-user storage quota exceeded');
        }
      }

      let ins;
      try {
        ins = await tx.query<{ uploaded_at: Date }>(
          `INSERT INTO file_versions
             (id, file_id, user_id, seq, ciphertext, nonce, size_bytes, deleted, key_id, uploaded_by_device)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING uploaded_at`,
          [
            req.params.versionId, req.params.fileId, req.user!.id, seq,
            ciphertext, nonce, ciphertext.length, opts.deleted, keyId, deviceId,
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

  // GET latest version's ciphertext
  app.get<{ Params: FileParams }>('/api/files/:fileId', { preHandler: session }, async (req, reply) => {
    requireUuid(req.params.fileId, 7, 'fileId');
    const r = await db.query<{
      id: string; ciphertext: Buffer; nonce: Buffer; key_id: string; seq: string | number;
      deleted: boolean; uploaded_at: Date;
    }>(
      `SELECT v.id, v.ciphertext, v.nonce, v.key_id, v.seq, v.deleted, v.uploaded_at
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
      .header('X-Nonce', v.nonce.toString('base64url'))
      .header('X-Key-Id', v.key_id)
      .header('X-Seq', String(Number(v.seq)));
    return reply.send(v.ciphertext);
  });

  app.get<{ Params: FileParams }>('/api/files/:fileId/versions', { preHandler: session }, async (req) => {
    requireUuid(req.params.fileId, 7, 'fileId');
    const r = await db.query<{
      id: string; seq: string | number; uploaded_at: Date; size_bytes: number;
      uploaded_by_device: string | null; deleted: boolean; key_id: string;
    }>(
      `SELECT v.id, v.seq, v.uploaded_at, v.size_bytes, v.uploaded_by_device, v.deleted, v.key_id
       FROM files f JOIN file_versions v ON v.file_id = f.id
       WHERE f.id = $1 AND f.user_id = $2
       ORDER BY v.seq DESC`,
      [req.params.fileId, req.user!.id],
    );
    if (r.rows.length === 0) throw new ApiError('not_found', 'file not found');
    return { versions: r.rows.map((v) => ({ ...v, seq: Number(v.seq) })) };
  });

  app.get<{ Params: VersionParams }>('/api/files/:fileId/versions/:versionId', { preHandler: session }, async (req, reply) => {
    requireUuid(req.params.fileId, 7, 'fileId');
    requireUuid(req.params.versionId, 4, 'versionId');
    const r = await db.query<{
      ciphertext: Buffer; nonce: Buffer; key_id: string; deleted: boolean; uploaded_at: Date; seq: string | number;
    }>(
      `SELECT v.ciphertext, v.nonce, v.key_id, v.deleted, v.uploaded_at, v.seq
       FROM files f JOIN file_versions v ON v.file_id = f.id
       WHERE f.id = $1 AND f.user_id = $2 AND v.id = $3 LIMIT 1`,
      [req.params.fileId, req.user!.id, req.params.versionId],
    );
    if (r.rows.length === 0) throw new ApiError('not_found', 'version not found');
    const v = r.rows[0]!;
    reply
      .header('Content-Type', 'application/octet-stream')
      .header('X-Version-Id', req.params.versionId)
      .header('X-Nonce', v.nonce.toString('base64url'))
      .header('X-Key-Id', v.key_id)
      .header('X-Seq', String(Number(v.seq)))
      .header('X-Deleted', v.deleted ? 'true' : 'false');
    return reply.send(v.ciphertext);
  });
}


