# Technical guide

Everything that used to be in the README but doesn't need to be in the face of a first-time user.

## Repo layout

```
claude-sync/
├── server/          M1: Fastify + Postgres backend (Railway-deployed)
├── cli/             M2.5: TypeScript CLI sync engine
├── desktop/         M2: Electron tray app (Windows + macOS)
├── docs/adr/        4 ADRs: key management, AEAD/AAD, file-id addressing, sync cursor
├── scripts/         One-off scripts (icon generator)
└── .github/workflows/release.yml   GitHub Actions: builds Win .exe + Mac .dmg on tag push
```

## Architecture (10 decisions frozen in M1)

These are wire-format and data-model decisions clients will inherit forever. Changing them later costs a forced migration.

1. **Addressing**: opaque client-generated `file_id` (UUID v7). Plaintext `path` is a transitional column. See [ADR 0003](adr/0003-opaque-file-id-addressing.md).
2. **AEAD**: XChaCha20-Poly1305-IETF with AAD = `0x01 || user_id || file_id || version_id || key_id`. See [ADR 0002](adr/0002-aead-aad-binding.md).
3. **`version_id`**: client-generated UUID v4 (no client-clock leak via v7 timestamp bits).
4. **No `content_hash`** on the wire or in DB. AEAD covers integrity, version_id PK covers retry idempotency.
5. **Sync cursor**: per-user monotonic `seq` on dedicated `user_seq` table. See [ADR 0004](adr/0004-sync-cursor.md).
6. **Key management**: `vault_key_metadata` holds public KDF metadata only; unwrapped key never touches the server. See [ADR 0001](adr/0001-e2e-key-never-server-side.md).
7. **Upload transport**: `application/octet-stream` body, nonce/key_id in headers (no base64 inflation).
8. **Device identity**: derived from session, never from body. Session is device-bound at first `POST /api/devices`; `PUT /api/files/...` before bind returns 412.
9. **Deletion**: client-generated tombstone version via `DELETE /api/files/:fileId/versions/:versionId`. AAD-bound over empty plaintext.
10. **Sync-policy scope**: server stores no per-subpath include/exclude policy. Clients decide what to upload.

## Security model

| Layer | What protects you |
|---|---|
| **Wire** | TLS to the Railway backend |
| **At rest on server** | XChaCha20-Poly1305-IETF with AAD = `0x01 ‖ user_id ‖ file_id ‖ version_id ‖ key_id` (65 bytes). Server stores ciphertext only — no key, no decrypt code path |
| **Key derivation** | Argon2id over your password + a per-user salt the server stores |
| **Session** | `__Host-session` opaque cookie, server-revocable, 30-day expiry, `SameSite=Strict` |
| **CSRF defense** | `X-Requested-With: claude-sync` on every mutating route |
| **OAuth state** (if GitHub login enabled) | Single-use, signed `__Secure-` cookie + DB row |

**Convenience mode trade-off:** because we derive the vault key from your login password, the server briefly sees your password during `/auth/login` and could (if malicious) derive the same key. Acceptable for the dogfood phase. To disable: Settings tab → uncheck "Convenience mode" → next launch asks for a separate passphrase that never touches the server.

Read the 4 [ADRs](adr/) for the full reasoning behind each crypto choice.

## What gets synced (full table)

| Synced | Skipped |
|---|---|
| `skills/`, `commands/`, `agents/` | `projects/`, `sessions/`, `session-data/`, `history.jsonl` |
| `memory/` (auto-memory across sessions) | `cache/`, `paste-cache/`, `file-history/`, `backups/`, `shell-snapshots/` |
| `settings.json` (global hooks, MCP, theme) | `settings.local.json` (per-machine overrides) |
| `plugins/installed_plugins.json` | `plugins/cache/` and `plugins/marketplaces/` (rebuilt from URLs on demand) |
| `plugins/known_marketplaces.json` | `.credentials.json` (Anthropic API key — never leaves the machine) |
| `plugins/data/` | `bash-commands.log`, `cost-tracker.log`, `telemetry/`, `metrics/`, `mcp-health-cache.json` |

Edit the include/exclude lists in the **Settings tab** — they're live-editable chips.

## Building from source

Prereqs: Node 22+, pnpm 11+.

```bash
git clone https://github.com/yelgabo/claude-sync
cd claude-sync
pnpm install

# Run the desktop app from source (auto-rebuilds on changes)
pnpm -F @claude-sync/desktop dev

# Run server tests (53 integration tests against ephemeral pglite)
pnpm -F @claude-sync/server test

# Run desktop end-to-end test (Playwright drives Electron against live server)
pnpm -F @claude-sync/desktop test:e2e
```

## Self-hosting the backend

The default Claude Sync points at `https://claude-sync-production.up.railway.app`. If you'd rather run your own:

```bash
cd server
pnpm install
# Set DATABASE_URL, AUTH_URL, AUTH_SECRET (32+ chars), PORT in .env
pnpm db:migrate
pnpm dev
```

In the desktop app's Settings, change Server URL to your instance.

A `Dockerfile` is included; the repo also ships a `railway.json` for one-click Railway deploys.

## CLI (optional, no UI)

For headless boxes, scripting, or just nerds who prefer terminals:

```bash
pnpm -F @claude-sync/cli build
node cli/dist/index.js help

# example flow
node cli/dist/index.js signup you@example.com
node cli/dist/index.js device "my-laptop"
node cli/dist/index.js vault-init
node cli/dist/index.js push    # one-shot
node cli/dist/index.js watch   # continuous loop
```

## Releasing a new version

The `.github/workflows/release.yml` workflow runs in two modes:

| Trigger | What happens | Where artifacts go |
|---|---|---|
| `workflow_dispatch` (manual button) | Builds `.exe` + `.dmg` | Uploaded as **workflow artifacts** (retained 24h) — testing/dev only |
| **git tag matching `v*`** | Builds `.exe` + `.dmg` AND auto-publishes via `electron-builder` | Attached to a real **GitHub Release** that the desktop app auto-updates from |

### Cutting a release

```bash
# 1. Bump the version in desktop/package.json
$EDITOR desktop/package.json

# 2. Commit the bump
git commit -am "Release v0.0.2"

# 3. Tag and push
git tag v0.0.2
git push origin main
git push origin v0.0.2
```

The push of the tag fires `.github/workflows/release.yml`. Within ~3 minutes:
- `claude-sync-X.Y.Z-win32-x64.exe` (NSIS installer)
- `claude-sync-X.Y.Z-darwin-x64.dmg` + `claude-sync-X.Y.Z-darwin-arm64.dmg`
- `latest.yml` + `latest-mac.yml` (auto-update manifests)

…all show up under https://github.com/yelgabo/claude-sync/releases/tag/vX.Y.Z. Already-installed apps poll the manifest hourly and prompt to install.

### Manual artifact build (no release)

If you just want to test the latest commit without publishing a Release:

1. [Actions tab](https://github.com/yelgabo/claude-sync/actions/workflows/release.yml) → **Run workflow** → select `main`
2. Wait ~3 minutes, then download the `installers-windows-latest` / `installers-macos-latest` artifacts (retained 24h)

## Code signing (deferred)

The current builds are unsigned. Consequences:
- **Windows**: SmartScreen flags as "unrecognized publisher" on first run. User clicks **More info → Run anyway**. Easy to bypass; users adapt quickly.
- **Mac**: Gatekeeper flags as "damaged" because of the `com.apple.quarantine` xattr. User strips it once with `xattr -cr` after install.

When dogfood is stable, two options to fix:
- **Windows**: EV code-signing cert (~$300/yr) or Azure Trusted Signing.
- **Mac**: Apple Developer Program ($99/yr) + notarization through Apple's API. Wire `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD` secrets into the GH Actions workflow and electron-builder handles the rest.

## Contributing

PRs welcome. Run all tests before opening one:
```bash
pnpm -F @claude-sync/server test
pnpm -F @claude-sync/desktop test:e2e
pnpm -F @claude-sync/desktop typecheck
```

## Roadmap

Tracked in `.claude/prds/claude-sync.prd.md`:

- [x] **M1** — Backend foundation on Railway
- [x] **M2.5** — Interim CLI
- [x] **M2** — Windows desktop client (Electron) with tabbed UI, devices, activity, file tree + version restore
- [ ] **M3** — macOS desktop client (same Electron build — already packaged via GH Actions; needs code signing for a clean install)
- [ ] **M4** — Per-subpath toggle UI polish (mostly already there)
- [x] **M5** — Version history + restore (delivered as part of M2)
- [ ] **M6** — Standalone web app: log in, browse, restore
- [ ] **M7** — 30-day dogfood validation