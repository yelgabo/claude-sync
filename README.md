# Claude Sync

**Get the same Claude on every computer.**

If you use Claude Code on more than one machine â€” say a desktop and a laptop â€” you've probably noticed something annoying: a skill you wrote on one computer isn't on the other. Same with custom commands, agents, and Claude's memory of past conversations. They live on whichever device you set them up on, and they stay there.

Claude Sync fixes that. Install it on each of your computers, sign in with the same email and password, and your `.claude/` folder follows you around. Edit a skill on your laptop, and it appears on your desktop within seconds.

Your files are **end-to-end encrypted** before they leave your device â€” the server that ships them between your computers can't read what's inside.

> **Try it without installing anything:** the web app at **[claude-sync-production.up.railway.app](https://claude-sync-production.up.railway.app)** lets you browse, diff, and download your synced files from any browser. Read-only â€” install the desktop app to push changes.

---

## Install

Pick your platform. The whole thing takes about 60 seconds.

### ðŸªŸ Windows

Download `*-win32-x64.exe` from the [Releases page](https://github.com/yelgabo/claude-sync/releases/latest) and run it. SmartScreen warns once ("unrecognized app") â€” click **More info â†’ Run anyway**.

### ðŸŽ macOS

Download the `.dmg` from the [Releases page](https://github.com/yelgabo/claude-sync/releases/latest) â€” `*-darwin-arm64.dmg` for Apple Silicon, `*-darwin-x64.dmg` for Intel. Signed and notarized by Apple, so it just opens.

---

## Set it up (first time)

When you launch the app:

1. **Sign up** with an email and a password (12+ characters). Pick one you'll remember â€” it's also what unlocks your encrypted files.
2. The app **registers this computer as a device** automatically.
3. Within 15 seconds you'll see your synced files appear in the **Files** tab.

That's it. The app lives in your system tray (Windows) or menu bar (Mac), and syncs every 15 seconds in the background.

### Adding a second computer

Install the app on your other computer. Sign in with **the same email and password**. Your files appear in the Files tab within a few seconds.

### Or use the web app — no install required

If you're at someone else's computer and just need to grab a file:

**https://claude-sync-production.up.railway.app**

Sign in with your normal email + password. Browse your synced files, see version history, click **Compare** to see what changed between any two versions, or click **Download** to save a file. Everything is decrypted in your browser — the server still can't read your data.

The web app is read-only (no editing or uploading); install the desktop app on a machine you control to push changes.

---

## What you can do in the app

The window has four tabs:

| Tab | What's there |
|---|---|
| **Files** | Everything currently synced. Click a file to see its history. **Compare** any older version against the latest with a colored diff. **Restore** an older version with one click. |
| **Activity** | The last 50 sync events (which file changed, when). Useful for "wait, why did that file just update?" |
| **Devices** | All your linked computers. Rename them so you remember which is which. Lost a laptop? Revoke it with one click. |
| **Settings** | Change what gets synced, how often, whether to use a separate vault passphrase. |

A tray icon (system tray on Windows, menu bar on Mac) stays alive after you close the window. Right-click it for **Sync now / Pause / Quit**.

### Sync conflicts

If you edit the same file on two computers while one is offline, the desktop app catches it. Before overwriting your local edit with the remote version, it saves your local copy as `<filename>.conflict-<timestamp>` so nothing is lost. The Activity tab flags the conflict; you can open both files side-by-side and merge by hand.

---

## What gets synced (and what doesn't)

**Synced** â€” the things that make your Claude *yours*:

- Your **skills**, **commands**, and **agents** (under `~/.claude/skills/`, `commands/`, `agents/`)
- Your **memory** â€” Claude's notes about you that persist across conversations
- Your **settings** â€” global preferences like theme, model choice, MCP servers, hooks
- The **list of installed plugins** (the actual plugin code re-downloads on each machine â€” saves bandwidth)

**Not synced** â€” machine-specific stuff that shouldn't follow you:

- Your Anthropic **API key** (each machine has its own)
- **Conversation history** (huge, machine-bound)
- Caches, logs, temp files
- Machine-specific overrides (`settings.local.json`)

You can fine-tune what's synced in the **Settings** tab.

---

## Troubleshooting

**Windows SmartScreen blocks the installer** â€” click **More info â†’ Run anyway**. The Windows installer isn't code-signed yet, so SmartScreen warns "unrecognized publisher"; you only see this once. (The macOS app *is* signed and notarized, so Macs don't show this.)

**App won't sync** â€” check the status pill in the top-right of the window. If it says "sync error", click the Sync tab and look at the message. The most common cause is your computer going offline; sync resumes automatically when you're back online.

**Forgot your password** â€” your password is also your encryption key (by default), so we can't reset it without losing your encrypted files. You'd have to start over with a fresh account. You can change this behavior in Settings â†’ uncheck "Convenience mode" â†’ use a separate vault passphrase.

**Something else broken?** Open an [issue on GitHub](https://github.com/yelgabo/claude-sync/issues).

---

## Privacy & security

**Your files are encrypted on your device before they leave it.** The server stores ciphertext only and has no key to decrypt them. Even if someone broke into the server, they couldn't read your files.

The encryption is XChaCha20-Poly1305 with associated-data binding (industry-standard authenticated encryption). The exact implementation details, including all the cryptographic decisions and why we made them, are in [`docs/TECHNICAL.md`](docs/TECHNICAL.md).

**Your password trade-off:** by default, your login password also derives your encryption key. This is convenient (one secret to remember) but means a malicious server could in theory derive the same key during login. If you want stronger separation, turn off "Convenience mode" in Settings â€” you'll get a separate vault passphrase that the server never sees.

---

## For developers / power users

- **Building from source, running tests, contributing:** see [`docs/TECHNICAL.md`](docs/TECHNICAL.md)
- **Self-hosting the backend** on your own Railway / Fly / Vercel instance: see [`docs/TECHNICAL.md`](docs/TECHNICAL.md#self-hosting-the-backend)
- **The architecture decisions** (4 ADRs covering crypto, addressing, sync cursor): see [`docs/adr/`](docs/adr/)

## License

MIT.