# ADR 0001: The vault encryption key never touches the server

## Status
Accepted (M1).

## Context
Claude Sync stores users' `~/.claude` file contents in a hosted backend. The data includes secrets
(MCP tokens, API keys in `settings.json`, agent prompts that may carry private references). Users must
be able to trust that even a compromised server, malicious operator, or stolen DB backup cannot reveal
plaintext.

## Decision
**The unwrapped symmetric encryption key (or any material from which the server could derive it) MUST
NOT touch the server, in any code path, ever.**

Concretely:
- The wire protocol carries `kdf_algo`, `kdf_salt`, and `key_id` — public KDF metadata only.
- The client derives the actual symmetric key from a user-supplied passphrase + `kdf_salt`, locally.
- The server has no decrypt code path. `crypto_aead_xchacha20poly1305_ietf_decrypt` is not imported
  anywhere in `server/src/`.
- A future "decrypt-for-search" feature is explicitly ruled out — it would require breaking this
  invariant.

## Consequences
- Server cannot help with key recovery if the user forgets the passphrase. Documented in the README.
- Server-side full-text search over content is impossible (correctly).
- Reviewer-enforced: any PR adding a libsodium decrypt import to `server/src/` is a NACK.
- Greppable invariant: `grep -r 'decrypt' server/src/` should return zero hits.
