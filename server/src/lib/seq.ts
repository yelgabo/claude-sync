import type { DbClient } from '../db/client.js';
export async function ensureUserSeqRow(db: DbClient, userId: string): Promise<void> {
  await db.query(`INSERT INTO user_seq (user_id, next) VALUES ($1, 1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
}
export async function allocateSeq(tx: DbClient, userId: string): Promise<number> {
  const r = await tx.query<{ next: string | number }>(
    `UPDATE user_seq SET next = next + 1 WHERE user_id = $1 RETURNING next - 1 AS next`, [userId],
  );
  if (r.rows.length === 0) throw new Error(`user_seq missing for ${userId}`);
  const v = r.rows[0]!.next;
  return typeof v === 'string' ? Number(v) : v;
}
