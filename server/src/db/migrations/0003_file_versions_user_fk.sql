-- Add the missing FOREIGN KEY on file_versions.user_id -> users.id.
-- Without this, orphan rows are possible if any path bypasses the files cascade.
-- Idempotent: only adds the constraint when it does not already exist.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'file_versions_user_id_fk'
  ) THEN
    ALTER TABLE file_versions
      ADD CONSTRAINT file_versions_user_id_fk
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END
$$;
