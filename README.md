# Claude Sync

End-to-end-encrypted backend for syncing a user's `~/.claude` folder across machines.
Backend-only for M1 (no UI). See `.claude/prds/claude-sync.prd.md` and
`.claude/plans/claude-sync.plan.md` (in the parent `GitHub/` directory) for product and
implementation specs.

## Status
- **M1a** (auth + per-file PUT/GET + deploy artifacts) — code complete.
- **M1b** (delete-tombstones, sync feed, docs) — code complete.
- Tests passing locally on pglite; Railway deploy is user-driven (see below).

## Architecture (10 decisions frozen in M1)
1. **Addressing**: opaque client-generated `file_id` (UUID v7). Plaintext `path` is a transitional
   column. See ADR 0003.
2. **AEAD**: XChaCha20-Poly1305-IETF with AAD = `0x01 || user_id || file_id || version_id || key_id`.
   See ADR 0002 (and `server/src/lib/aad.ts`).
3. **`version_id`**: client-generated UUID v4 (no client-clock leak via v7 timestamp bits).
4. **No `content_hash`** on the wire or in DB. AEAD covers integrity, version_id PK covers retry
   idempotency.
5. **Sync cursor**: per-user monotonic `seq` on dedicated `user_seq` table. See ADR 0004.
6. **Key management**: `vault_key_metadata` holds public KDF metadata only; unwrapped key never
   touches the server. See ADR 0001.
7. **Upload transport**: `application/octet-stream` body, nonce/key_id in headers (no base64 inflation).
8. **Device identity**: derived from session, never from body. Session is device-bound at first
   `POST /api/devices`; `PUT /api/files/...` before bind returns 412.
9. **Deletion**: client-generated tombstone version via `DELETE /api/files/:fileId/versions/:versionId`.
   AAD-bound over empty plaintext.
10. **Sync-policy scope**: server stores no per-subpath include/exclude policy. Clients decide what
    to upload.

## What the server can see vs. cannot
| Server sees | Server cannot read |
|---|---|
| `path` (M1 transitional) | `ciphertext` (E2E encrypted) |
| `size_bytes`, `uploaded_at` | Plaintext contents |
| `device_id`, `device.name` | The vault key |
| `seq`, `key_id` |   |
| `content_hash` of ciphertext | (none stored — ADR 0002) |

## API surface (M1)
See `src/routes/*.ts` for the implementations. Highlights:
- `GET /healthz`
- **Email + password** (default in M1): `POST /auth/signup`, `POST /auth/login`
- **GitHub OAuth** (optional — only if `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` set): `GET /auth/github`, `GET /auth/github/callback`
- `POST /auth/logout`, `POST /auth/sessions/revoke-all`
- `GET /api/me`, `POST /api/devices`, `GET /api/devices`
- `GET /api/vault/key-metadata`, `PUT /api/vault/key-metadata`
- `GET /api/files` (optional `?path=`), `PUT /api/files/:fileId/versions/:versionId`,
  `GET /api/files/:fileId`, `GET /api/files/:fileId/versions`,
  `GET /api/files/:fileId/versions/:versionId`,
  `DELETE /api/files/:fileId/versions/:versionId`
- `GET /api/sync?since=:seq&limit=N`

All mutating `/api/*` routes require `X-Requested-With: claude-sync` (CSRF defense-in-depth).
Sessions are 30-day; revocation supported.

## Client bootstrap protocol
See `docs/adr/0004-sync-cursor.md` — M2/M3 desktop clients should follow this.

## Local dev
```
pnpm install
pnpm -F @claude-sync/server typecheck
pnpm -F @claude-sync/server test
```

The test suite uses pglite (in-process Postgres) so no Docker is needed.

For `pnpm dev` against a real Postgres, set `DATABASE_URL` in `.env` and `pnpm -F @claude-sync/server db:migrate`.

## Deploy to Railway (M1 task 11)
This is **user-driven** because it requires creating a GitHub OAuth app and setting Railway env vars.

**Deploy checklist** (in order):
1. **Skip GitHub OAuth for now** — email+password auth is the default and needs no external setup. If
   you want to add GitHub login later, create an OAuth app at https://github.com/settings/developers
   and set `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` in Railway. Callback URL must be exactly
   `${AUTH_URL}/auth/github/callback`.
2. In the Railway project `compassionate-charisma` (shared with kimbo + anki-srs because the Trial
   plan blocks new projects):
   - Create a new service from this repo (Dockerfile build).
   - Add a **separate** Postgres add-on (do not share with kimbo/anki-srs).
   - Set env vars:
     - `DATABASE_URL` (auto-provided by the Postgres add-on)
     - `AUTH_URL` = the public Railway URL (e.g., `https://claude-sync-production.up.railway.app`)
     - `AUTH_TRUST_HOST=true`
     - `AUTH_SECRET` = 32+ random bytes, base64url
     - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (optional — omit to use email+password only)
     - `PORT=8080`
   - Generate a public domain.
3. Smoke test: `curl https://<domain>/healthz` → `{ ok: true, db: "up" }`, then complete OAuth in a
   browser, then exercise the PUT/GET/DELETE/sync round-trip with `curl`.

## Acceptance checklist (M1)
- [x] 12 plan tasks implemented (M1a tasks 1–7, 10, 11; M1b 8, 9, 12)
- [x] Tests: auth, files, sync, AAD fixtures, path-canon properties, redactor
- [ ] Deployed to Railway and smoke-tested end-to-end (user-driven)
- [x] 4 ADRs committed
- [x] `__Host-session` for session cookie; `__Secure-oauth-state` for OAuth state cookie
- [x] OAuth `state` single-use (DB row + signed cookie, both consumed on callback)
- [x] `X-Requested-With` enforced on mutating `/api/*` routes
- [x] No `content_hash` field; AAD construction in one helper
- [x] `next_seq` on dedicated `user_seq` table; lazy sweep of `oauth_states`
- [x] Per-user storage quota + per-user/per-IP rate limits
- [x] Security headers (HSTS, nosniff, no X-Powered-By)
- [x] `version_id` UUID v4; `file_id` UUID v7 (validated server-side)
