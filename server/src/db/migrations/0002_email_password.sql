-- Email+password authentication. GitHub OAuth becomes optional.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash text;

ALTER TABLE users
  ALTER COLUMN github_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uniq
  ON users (lower(email))
  WHERE email IS NOT NULL;