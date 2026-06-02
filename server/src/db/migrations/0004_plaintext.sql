-- Encryption removed. File content is now stored as plaintext.
-- The `file_versions.ciphertext` column keeps its name for compatibility but now
-- holds raw file bytes. The AEAD `nonce`/`key_id` columns are no longer written;
-- make them nullable so plaintext rows can omit them. The client-side vault key was
-- derived from these, so vault_key_metadata is no longer needed.
-- Idempotent: safe to re-run on every boot (migrations have no tracking table).

ALTER TABLE file_versions ALTER COLUMN nonce DROP NOT NULL;
ALTER TABLE file_versions ALTER COLUMN key_id DROP NOT NULL;

DROP TABLE IF EXISTS vault_key_metadata;
