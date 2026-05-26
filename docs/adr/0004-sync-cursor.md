# ADR 0004: Per-user monotonic sync cursor in a dedicated table

## Status
Accepted (M1).

## Context
The PRD's success metric requires <60 seconds to propagate a new file to a second device. A
client-side poll of `GET /api/files` then per-file `GET` does not scale to a mature vault. Clients
need an efficient "what changed since cursor X" feed.

## Decision
- Each user has a monotonic `seq bigint`, allocated by:
  ```sql
  UPDATE user_seq SET next = next + 1 WHERE user_id = $1 RETURNING next - 1 AS next
  ```
  called inside the same transaction as the `file_versions` insert. Rollback unwinds both.
- `seq` lives on a **dedicated `user_seq` table** (one row per user, columns `(user_id, next)`).
  Putting it on `users` would serialize unrelated user-row updates (last_seen_at, vault metadata
  writes) behind hot-path uploads.
- `GET /api/sync?since=:seq&limit=N` returns rows from `file_versions` (joined to `files` for
  `path`), ordered by `seq` ASC, with `has_more` and `next_seq` for paging.

## Bootstrap protocol (clients)
1. `POST /api/devices` → bind session to device.
2. `GET /api/vault/key-metadata` → derive vault key from passphrase + `kdf_salt`.
3. `GET /api/files` → build local `path ↔ file_id` map; record max `latest_seq` as initial cursor.
4. For each file you want to materialize: `GET /api/files/:fileId`.
5. Steady state: poll `GET /api/sync?since=cursor`; advance cursor on each successful pull.

## Consequences
- Per-user write serialization on `user_seq` row is acceptable for a single-user MVP (≤3 devices).
- The denormalized `file_versions.user_id` column is what makes the per-user feed query cheap
  (no `JOIN files` to filter by user).
- A quota-exceeded PUT that aborts the tx does NOT advance `seq` — tested in `sync.test.ts`.
