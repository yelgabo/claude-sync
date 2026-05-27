# Claude Sync

End-to-end encrypted sync for your `~/.claude` folder — skills, commands, agents, memory, and settings follow you across machines.

> Like Dropbox, but scoped to `.claude/` and the server can't read your files.

![status](https://img.shields.io/badge/status-dogfooding-orange)
![platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS-blue)
![e2e](https://img.shields.io/badge/E2E-encrypted-success)

---

## What it does

You write a skill on your PC; 15 seconds later it's on your laptop. You add an MCP server to your global `settings.json` on the laptop; it shows up on your PC. Your auto-memory follows you. Same Claude Code on every machine.

Files are encrypted client-side (XChaCha20-Poly1305 + AAD) before they leave your device — the server stores ciphertext and metadata only. Even if someone roots the server, your files are unreadable without your password.

## Install

Three install paths, in order of "easiest first":

| Path | When to use | What you get |
|---|---|---|
| **Tagged Release** | `git tag vX.Y.Z` has been pushed | Permanent `.exe` / `.dmg` on the [Releases page](https://github.com/yelgabo/claude-sync/releases); app auto-updates on future tags |
| **Workflow artifact** | A maintainer manually ran the build workflow | Download from the [latest Actions run](https://github.com/yelgabo/claude-sync/actions/workflows/release.yml) → "Artifacts" section (retained 24h) — useful for testing unreleased commits |
| **Dev clone** | You're hacking on the code or no Release exists yet | Clone repo + `pnpm install` + `pnpm start` — runs from source |

### Windows

**Tagged Release (recommended):** download `claude-sync-{version}-win-x64.exe` from [Releases](https://github.com/yelgabo/claude-sync/releases) → run → done.

**Dev path (works today):**
```powershell
# Prereqs: Node 22+ and pnpm
winget install OpenJS.NodeJS.LTS
npm i -g pnpm

git clone https://github.com/yelgabo/claude-sync
cd claude-sync
pnpm install
pnpm -F @claude-sync/desktop start
```

### macOS

**Tagged Release (recommended):** download `claude-sync-{version}-mac-arm64.dmg` (or `-x64.dmg` for Intel) from [Releases](https://github.com/yelgabo/claude-sync/releases) → drag to Applications. First launch needs right-click → Open (unsigned for now; Gatekeeper warning is normal).

**Dev path:**
```bash
brew install node@22
npm i -g pnpm

git clone https://github.com/yelgabo/claude-sync
cd claude-sync
pnpm install
pnpm -F @claude-sync/desktop start
```

## First-run setup (any platform)

1. **Sign up** with an email + 12+ char password.
2. The app auto-registers this machine as a device and uses your login password to derive your vault key (no separate passphrase). This is **convenience mode** — see [Security model](#security-model) for the trade-off and how to disable it.
3. The Files tab populates within 15 seconds with what's eligible to sync from `~/.claude`.

On a **second device**, repeat steps 1–2 with the **same email + password**. Convenience mode derives the same vault key client-side; your files appear in the Files tab.

## What gets synced

| Synced | Skipped |
|---|---|
| `skills/`, `commands/`, `agents/` | `projects/`, `sessions/`, `session-data/`, `history.jsonl` |
| `memory/` (auto-memory across sessions) | `cache/`, `paste-cache/`, `file-history/`, `backups/`, `shell-snapshots/` |
| `settings.json` (global hooks, MCP, theme) | `settings.local.json` (per-machine overrides) |
| `plugins/installed_plugins.json` | `plugins/cache/` and `plugins/marketplaces/` (rebuilt from URLs on demand) |
| `plugins/known_marketplaces.json` | `.credentials.json` (Anthropic API key — never leaves the machine) |
| `plugins/data/` | `bash-commands.log`, `cost-tracker.log`, `telemetry/`, `metrics/`, `mcp-health-cache.json` |

Edit the include/exclude lists in the **Settings tab** — they're live-editable chips.

## The desktop app

Tabs: **Files** (tree + per-file version history + restore), **Activity** (last 50 sync events), **Devices** (rename / revoke any device including this one), **Settings** (sync scope, interval, convenience mode toggle, sync root).

A tray icon stays alive after window close. Right-click for **Sync now / Pause / Quit**. Background sync runs every 15s (configurable in Settings: 5–3600s).

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

Details: [`docs/adr/`](docs/adr/) — four ADRs covering key management, AEAD/AAD construction, opaque file IDs, and the sync cursor.

## Self-hosting the backend

The server is live at `https://claude-sync-production.up.railway.app`. If you'd rather run your own:

```bash
cd server
pnpm install
# Set DATABASE_URL, AUTH_URL, AUTH_SECRET (32+ chars), PORT in .env
pnpm db:migrate
pnpm dev
```

In the desktop app's Settings, change Server URL to your instance.

A `Dockerfile` is included; the repo also ships a `railway.json` for one-click Railway deploys. See [`docs/adr/0004-sync-cursor.md`](docs/adr/0004-sync-cursor.md) and [`server/README.md`](server/) (TODO) for backend internals.

## CLI (optional)

If you'd rather sync from the terminal — useful for headless boxes or scripting:

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

## Repo layout

```
claude-sync/
├── server/          M1: Fastify + Postgres backend (Railway-deployed)
├── cli/             M2.5: TypeScript CLI sync engine
├── desktop/         M2: Electron tray app (Windows + macOS)
├── docs/adr/        4 ADRs: key management, AEAD/AAD, file-id addressing, sync cursor
└── .github/workflows/release.yml   GitHub Actions: builds Win .exe + Mac .dmg on tag push
```

## Releasing a new version

The `.github/workflows/release.yml` workflow runs in two modes:

| Trigger | What happens | Where artifacts go |
|---|---|---|
| `workflow_dispatch` (manual button) | Builds `.exe` + `.dmg` | Uploaded as **workflow artifacts** (retained 24h) — testing/dev only |
| **git tag matching `v*`** | Builds `.exe` + `.dmg` AND auto-publishes via `electron-builder` | Attached to a real **GitHub Release** that the desktop app auto-updates from |

### Cutting a release

```bash
# 1. Bump the version everywhere
#    (just edit desktop/package.json "version" — that's the source of truth for electron-builder)
$EDITOR desktop/package.json

# 2. Commit the bump
git commit -am "Release v0.0.1"

# 3. Tag and push
git tag v0.0.1
git push origin main
git push origin v0.0.1
```

The push of the tag fires `.github/workflows/release.yml`. Within ~3 minutes:
- `claude-sync-0.0.1-win-x64.exe` (NSIS installer) + `claude-sync-0.0.1-win-x64.exe` (portable variant)
- `claude-sync-0.0.1-mac-x64.dmg` + `claude-sync-0.0.1-mac-arm64.dmg`
- `latest.yml` + `latest-mac.yml` (auto-update manifests)

…all show up at https://github.com/yelgabo/claude-sync/releases/tag/v0.0.1.

Already-installed apps poll the latest manifest hourly and prompt the user to install the update.

### Manual artifact build (no release)

If you just want to test the latest commit without publishing a Release:

1. Go to the [Actions tab](https://github.com/yelgabo/claude-sync/actions/workflows/release.yml)
2. Click **Run workflow** → select `main` → **Run**
3. Wait ~3 minutes, then download the `installers-windows-latest` / `installers-macos-latest` artifacts (retained 24h)

## Roadmap

Tracked in `.claude/prds/claude-sync.prd.md`:

- [x] **M1** — Backend foundation on Railway
- [x] **M2.5** — Interim CLI
- [x] **M2** — Windows desktop client (Electron) with tabbed UI, devices, activity, file tree + version restore
- [ ] **M3** — macOS desktop client (same Electron build — needs Mac packaging via GH Actions)
- [ ] **M4** — Per-subpath toggle UI polish (mostly already there)
- [x] **M5** — Version history + restore (delivered as part of M2)
- [ ] **M6** — Standalone web app: log in, browse, restore
- [ ] **M7** — 30-day dogfood validation

## Contributing

Run tests before opening a PR:
```bash
pnpm -F @claude-sync/server test       # 53 tests
pnpm -F @claude-sync/desktop test:e2e  # Playwright e2e against the live API
```

## License

MIT.