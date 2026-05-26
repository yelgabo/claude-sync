-- claude-sync M1 initial schema

CREATE TABLE IF NOT EXISTS users (
  id              uuid PRIMARY KEY,
  github_id       bigint UNIQUE NOT NULL,
  email           text,
  storage_bytes   bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_seq (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  next            bigint NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS vault_key_metadata (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kdf_algo        text NOT NULL,
  kdf_salt        bytea NOT NULL,
  key_id          uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz
);

CREATE TABLE IF NOT EXISTS sessions (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id       uuid REFERENCES devices(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS oauth_states (
  state           text PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS oauth_states_expires_at_idx ON oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS files (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS files_user_id_idx ON files (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS files_user_path_uniq ON files (user_id, path) WHERE path IS NOT NULL;

CREATE TABLE IF NOT EXISTS file_versions (
  id                  uuid PRIMARY KEY,
  file_id             uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL,
  seq                 bigint NOT NULL,
  ciphertext          bytea NOT NULL,
  nonce               bytea NOT NULL,
  size_bytes          integer NOT NULL,
  deleted             boolean NOT NULL DEFAULT false,
  key_id              uuid NOT NULL,
  uploaded_by_device  uuid REFERENCES devices(id) ON DELETE SET NULL,
  uploaded_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS file_versions_user_seq_uniq ON file_versions (user_id, seq);
CREATE INDEX IF NOT EXISTS file_versions_file_seq_idx ON file_versions (file_id, seq);
CREATE INDEX IF NOT EXISTS file_versions_user_file_seq_idx ON file_versions (user_id, file_id, seq);
CREATE INDEX IF NOT EXISTS file_versions_user_seq_idx ON file_versions (user_id, seq);
