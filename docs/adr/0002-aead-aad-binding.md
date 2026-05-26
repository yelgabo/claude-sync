# ADR 0002: AEAD construction and AAD binding

## Status
Accepted (M1). Wire-format normative — changes require an AAD version-byte migration.

## Context
A content-blind backend can still be malicious in ways the AEAD must defeat: serving user A's
ciphertext at user B's `file_id`, swapping version N for version N-1, or replaying a blob across
key-rotation generations. Without AAD that binds these identifiers, the client decrypts whatever the
server returns and trusts it.

## Decision
- **AEAD primitive**: `crypto_aead_xchacha20poly1305_ietf` (XChaCha20-Poly1305 with 24-byte nonce).
- **AAD construction** (single helper at `server/src/lib/aad.ts`):
  ```
  AAD = 0x01 || user_id_bytes(16) || file_id_bytes(16) || version_id_bytes(16) || key_id_bytes(16)
  ```
  Total length: 65 bytes.
- The leading `0x01` is the **AAD construction version**, reserved for future migration without a
  flag day. Changes to the construction MUST bump this byte.
- **No `content_hash` is stored** server-side. It would be a long-term plaintext-equality oracle once
  per-user key + deterministic nonce bugs occur. The AEAD covers integrity; `version_id` PK covers
  idempotency for retries.

## Consequences
- A future change to AAD requires reading the leading byte to dispatch to the right construction.
- Server-stored metadata (path, size, timestamps) is still visible — see ADR 0003.
- `version_id` is in AAD, so clients MUST pick it before encrypt. We use UUID v4 (avoids the
  client-clock leakage that UUID v7 carries).
