-- Store only a SHA-256 hash of the session token, never the raw token.
-- The cookie carries a high-entropy random token; the DB stores sha256(token).
-- A DB read (backup leak, SQLi, snapshot) no longer yields usable session cookies.
--
-- `id` stays the internal primary key (server-generated uuid), used for revoke/device
-- binding. `token_hash` is what the session middleware looks up by. Pre-existing rows
-- (raw-uuid PK cookies) simply stop matching after deploy, which logs those sessions
-- out — acceptable for a security fix.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_uniq
  ON sessions (token_hash) WHERE token_hash IS NOT NULL;
