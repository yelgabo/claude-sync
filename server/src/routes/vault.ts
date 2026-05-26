import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '../db/client.js';
import { makeSessionMiddleware } from '../auth/session.js';
import { ApiError } from '../lib/errors.js';

const PutKey = z.object({
  kdf_algo: z.literal('argon2id'),
  kdf_salt_b64: z.string().min(1),
  key_id: z.string().uuid(),
});

export function registerVault(app: FastifyInstance, db: DbClient): void {
  const session = makeSessionMiddleware(db);

  app.get('/api/vault/key-metadata', { preHandler: session }, async (req) => {
    const r = await db.query<{ kdf_algo: string; kdf_salt: Buffer; key_id: string }>(
      `SELECT kdf_algo, kdf_salt, key_id FROM vault_key_metadata WHERE user_id = $1`,
      [req.user!.id],
    );
    if (r.rows.length === 0) throw new ApiError('not_found', 'no vault key set');
    const row = r.rows[0]!;
    return {
      kdf_algo: row.kdf_algo,
      kdf_salt_b64: row.kdf_salt.toString('base64url'),
      key_id: row.key_id,
    };
  });

  // Transactional to close the SELECT-then-INSERT race: two concurrent PUTs from the
  // same session could otherwise both see "no versions" and one would silently overwrite
  // the other's key, breaking decryption for already-uploaded blobs.
  app.put('/api/vault/key-metadata', { preHandler: session }, async (req) => {
    const parsed = PutKey.safeParse(req.body);
    if (!parsed.success) throw new ApiError('invalid_request', parsed.error.issues.map((i) => i.message).join('; '));

    const saltBytes = Buffer.from(parsed.data.kdf_salt_b64, 'base64url');
    if (saltBytes.length < 16 || saltBytes.length > 32) {
      throw new ApiError('invalid_request', 'kdf_salt must be 16-32 bytes');
    }

    await db.transaction(async (tx) => {
      // FOR UPDATE on the user row serializes concurrent vault-key writes for the same user.
      await tx.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [req.user!.id]);

      const existing = await tx.query<{ user_id: string }>(
        `SELECT user_id FROM vault_key_metadata WHERE user_id = $1`, [req.user!.id],
      );

      if (existing.rows.length > 0) {
        const versions = await tx.query<{ c: number | string }>(
          `SELECT count(*)::int AS c FROM file_versions WHERE user_id = $1`, [req.user!.id],
        );
        const count = Number(versions.rows[0]!.c);
        if (count > 0) {
          throw new ApiError('conflict', 'vault key already set; rotation not implemented in M1');
        }
        await tx.query(
          `UPDATE vault_key_metadata
           SET kdf_algo = $2, kdf_salt = $3, key_id = $4, updated_at = now()
           WHERE user_id = $1`,
          [req.user!.id, parsed.data.kdf_algo, saltBytes, parsed.data.key_id],
        );
      } else {
        await tx.query(
          `INSERT INTO vault_key_metadata (user_id, kdf_algo, kdf_salt, key_id) VALUES ($1, $2, $3, $4)`,
          [req.user!.id, parsed.data.kdf_algo, saltBytes, parsed.data.key_id],
        );
      }
    });
    return { ok: true };
  });
}
