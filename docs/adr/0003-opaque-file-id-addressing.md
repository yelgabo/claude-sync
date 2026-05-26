# ADR 0003: Opaque `file_id` addressing; plaintext `path` is transitional

## Status
Accepted (M1). Plaintext `path` column will be removed or replaced in a later milestone.

## Context
A naive design uses the user's `.claude`-relative path as the primary key. That bakes the path into
every API route, every DB index, every metadata join — making "let's encrypt the path tree later"
mean migrating every blob and rewriting every route.

## Decision
- **Addressing**: opaque `file_id` (UUID v7, client-generated). Routes are `/api/files/:fileId/...`.
- **Plaintext `path`** is a separate column on `files`, populated from the optional `X-Path` request
  header. It is **transitional** — the server treats it as metadata only and the client can omit it.
- The bootstrap protocol (README) tells clients to maintain a local `path ↔ file_id` map so M2/M3
  clients can later operate without sending `X-Path` at all.
- Path canonicalization (`src/lib/path-canon.ts`) is enforced when `X-Path` is present.

## Consequences
- Migrating to encrypted/hashed paths in a later milestone is a `path` column nullification + new
  encrypted column, not a re-architecting.
- Two devices that create the same file concurrently with different `file_id`s will collide on the
  `(user_id, path) UNIQUE` index. Clients use `GET /api/files?path=...` to pre-flight (documented in
  the bootstrap protocol).
