# Claude Sync

**Get the same Claude on every computer.**

If you use Claude Code on more than one machine — say a desktop and a laptop — you've probably noticed something annoying: a skill you wrote on one computer isn't on the other. Same with custom commands, agents, and Claude's memory of past conversations. They live on whichever device you set them up on, and they stay there.

Claude Sync fixes that. Install it on each of your computers, sign in with the same email and password, and your `.claude/` folder follows you around. Edit a skill on your laptop, and it appears on your desktop within seconds.

Your files are **end-to-end encrypted** before they leave your device — the server that ships them between your computers can't read what's inside.

---

## Install

Pick your platform. The whole thing takes about 60 seconds.

### 🪟 Windows

1. Go to the [Releases page](https://github.com/yelgabo/claude-sync/releases/latest)
2. Download `claude-sync-{latest-version}-win32-x64.exe`
3. Double-click to install. Windows might warn you about an "unrecognized app" — click **More info → Run anyway**.

### 🍎 macOS

1. Go to the [Releases page](https://github.com/yelgabo/claude-sync/releases/latest)
2. Download the right `.dmg`:
   - **Apple Silicon** (M1/M2/M3/M4 Macs): `claude-sync-{version}-darwin-arm64.dmg`
   - **Intel** Macs: `claude-sync-{version}-darwin-x64.dmg`
3. Open the `.dmg` and drag **Claude Sync** to **Applications**.
4. **First launch on macOS** — the app isn't signed with an Apple Developer certificate yet, so macOS will say *"Claude Sync is damaged and can't be opened"*. It's not damaged, just unsigned. To fix it once:

   Open **Terminal** (Cmd+Space → "Terminal") and paste:
   ```bash
   xattr -cr "/Applications/Claude Sync.app"
   ```
   Press Enter. Now you can open the app normally. You only ever need to do this once per install.

   > If the above doesn't work (some macOS versions are stricter), run this too:
   > ```bash
   > codesign --force --deep --sign - "/Applications/Claude Sync.app"
   > ```

---

## Set it up (first time)

When you launch the app:

1. **Sign up** with an email and a password (12+ characters). Pick one you'll remember — it's also what unlocks your encrypted files.
2. The app **registers this computer as a device** automatically.
3. Within 15 seconds you'll see your synced files appear in the **Files** tab.

That's it. The app lives in your system tray (Windows) or menu bar (Mac), and syncs every 15 seconds in the background.

### Adding a second computer

Install the app on your other computer. Sign in with **the same email and password**. Your files appear in the Files tab within a few seconds.

---

## What you can do in the app

The window has four tabs:

| Tab | What's there |
|---|---|
| **Files** | Everything currently synced. Click a file to see its history. Restore an older version with one click. |
| **Activity** | The last 50 sync events (which file changed, when). Useful for "wait, why did that file just update?" |
| **Devices** | All your linked computers. Rename them so you remember which is which. Lost a laptop? Revoke it with one click. |
| **Settings** | Change what gets synced, how often, whether to use a separate vault passphrase. |

A tray icon (system tray on Windows, menu bar on Mac) stays alive after you close the window. Right-click it for **Sync now / Pause / Quit**.

---

## What gets synced (and what doesn't)

**Synced** — the things that make your Claude *yours*:

- Your **skills**, **commands**, and **agents** (under `~/.claude/skills/`, `commands/`, `agents/`)
- Your **memory** — Claude's notes about you that persist across conversations
- Your **settings** — global preferences like theme, model choice, MCP servers, hooks
- The **list of installed plugins** (the actual plugin code re-downloads on each machine — saves bandwidth)

**Not synced** — machine-specific stuff that shouldn't follow you:

- Your Anthropic **API key** (each machine has its own)
- **Conversation history** (huge, machine-bound)
- Caches, logs, temp files
- Machine-specific overrides (`settings.local.json`)

You can fine-tune what's synced in the **Settings** tab.

---

## Troubleshooting

**Mac says "Claude Sync is damaged"** — see the [Install section](#-macos) above for the one-line `xattr` fix. This happens because the app isn't yet signed with a paid Apple Developer certificate.

**Windows SmartScreen blocks the installer** — click **More info → Run anyway**. The installer is also unsigned (same reason). You only see this once.

**App won't sync** — check the status pill in the top-right of the window. If it says "sync error", click the Sync tab and look at the message. The most common cause is your computer going offline; sync resumes automatically when you're back online.

**Forgot your password** — your password is also your encryption key (by default), so we can't reset it without losing your encrypted files. You'd have to start over with a fresh account. You can change this behavior in Settings → uncheck "Convenience mode" → use a separate vault passphrase.

**Something else broken?** Open an [issue on GitHub](https://github.com/yelgabo/claude-sync/issues).

---

## Privacy & security

**Your files are encrypted on your device before they leave it.** The server stores ciphertext only and has no key to decrypt them. Even if someone broke into the server, they couldn't read your files.

The encryption is XChaCha20-Poly1305 with associated-data binding (industry-standard authenticated encryption). The exact implementation details, including all the cryptographic decisions and why we made them, are in [`docs/TECHNICAL.md`](docs/TECHNICAL.md).

**Your password trade-off:** by default, your login password also derives your encryption key. This is convenient (one secret to remember) but means a malicious server could in theory derive the same key during login. If you want stronger separation, turn off "Convenience mode" in Settings — you'll get a separate vault passphrase that the server never sees.

---

## For developers / power users

- **Building from source, running tests, contributing:** see [`docs/TECHNICAL.md`](docs/TECHNICAL.md)
- **Self-hosting the backend** on your own Railway / Fly / Vercel instance: see [`docs/TECHNICAL.md`](docs/TECHNICAL.md#self-hosting-the-backend)
- **The architecture decisions** (4 ADRs covering crypto, addressing, sync cursor): see [`docs/adr/`](docs/adr/)

## License

MIT.