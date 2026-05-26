import type { DbClient } from '../db/client.js';

// Sweep aggressively: any expired row, or any consumed row older than 1 hour.
// Keeps the table small under normal flow and DoS-resistant under attack.
export async function sweepOauthStates(db: DbClient): Promise<void> {
  await db.query(
    `DELETE FROM oauth_states
     WHERE expires_at < now()
        OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '1 hour')`,
  );
}
