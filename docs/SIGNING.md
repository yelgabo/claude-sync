# Code signing & notarization

Sets of steps you (the maintainer) do **once** to get signed, notarized macOS builds out of GitHub Actions. Windows code signing is a separate cert+process — see the bottom of this doc.

---

## macOS — Developer ID + Notarization (Apple)

### Prereqs
- Apple Developer Program membership active ($99/yr — sign up at https://developer.apple.com/programs/)
- Access to a Mac (only needed once, to generate the cert and export it)

### Step 1 — Create the Developer ID Application certificate

1. On your Mac, open **Keychain Access** → menu **Certificate Assistant** → **Request a Certificate From a Certificate Authority…**
2. Fill in:
   - **Email**: your Apple ID email
   - **Common Name**: anything (e.g., "Claude Sync signing cert")
   - **CA Email**: leave blank
   - **Request is**: **Saved to disk**
3. Save the `.certSigningRequest` file to your Desktop.
4. Go to https://developer.apple.com/account/resources/certificates/list
5. Click **+** → choose **Developer ID Application** (NOT Mac App Distribution) → Continue
6. Upload the `.certSigningRequest` file → Continue
7. Download the `.cer` file Apple gives you back.
8. Double-click the `.cer` to install it in your Keychain. It joins the **Apple Worldwide Developer Relations** chain.

Verify in Keychain Access → **My Certificates** — you should see a line like:
```
Developer ID Application: Your Name (TEAMIDXXXX)
```

### Step 2 — Export the cert as a `.p12` for GitHub Actions

GitHub can't reach into your Mac keychain, so we export the cert + private key.

1. In Keychain Access → **My Certificates**, find your **Developer ID Application** entry.
2. Right-click → **Export "Developer ID Application: ..."**
3. Save as `.p12` format. Pick a strong password — write it down, you'll need it next step.
4. Base64-encode the `.p12` on the Mac terminal:
   ```bash
   base64 -i ~/Desktop/cert.p12 | pbcopy
   ```
   That copies the encoded blob to your clipboard.

### Step 3 — Get your Team ID and App-Specific Password

- **Team ID**: https://developer.apple.com/account → **Membership** → "Team ID" (10-char alphanumeric like `A1B2C3D4E5`)
- **App-Specific Password** (for notarization):
  1. Go to https://appleid.apple.com → **Sign-In and Security** → **App-Specific Passwords**
  2. Generate a new one labeled "Claude Sync notarize"
  3. Copy the password (looks like `abcd-efgh-ijkl-mnop`)

### Step 4 — Add five secrets to GitHub

Go to https://github.com/yelgabo/claude-sync/settings/secrets/actions → **New repository secret**. Add these five:

| Secret name | Value |
|---|---|
| `MAC_CSC_LINK` | The base64-encoded `.p12` you copied in Step 2 |
| `MAC_CSC_KEY_PASSWORD` | The password you set on the `.p12` |
| `APPLE_ID` | Your Apple Developer email |
| `APPLE_APP_SPECIFIC_PASSWORD` | The 16-char password from Step 3 |
| `APPLE_TEAM_ID` | Your Team ID from Step 3 |

### Step 5 — Cut a new tag

```bash
# bump version
$EDITOR desktop/package.json   # change "0.0.1" → "0.0.2"
git commit -am "Release v0.0.2 (signed + notarized)"
git tag v0.0.2
git push origin main v0.0.2
```

The workflow runs. The Mac job:
- electron-builder reads `CSC_LINK` + `CSC_KEY_PASSWORD` and signs the `.app` bundle
- After signing, it submits to Apple's `notarytool` via `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`
- Apple notarizes (~3–10 minutes); electron-builder staples the ticket to the `.app`
- Builds the `.dmg` containing the now-trusted app

Users downloading the `.dmg` from your Releases will open it without any "damaged" warning — macOS Gatekeeper sees the Developer ID signature + notarization ticket and lets it run.

### Verifying locally after a tagged release

Download the `.dmg` from the Releases page and run:
```bash
spctl -a -v "/Applications/Claude Sync.app"
# expected: "/Applications/Claude Sync.app: accepted; source=Notarized Developer ID"

codesign --verify --deep --strict --verbose=4 "/Applications/Claude Sync.app"
# expected: "valid on disk", "satisfies its Designated Requirement"
```

---

## Windows — Code Signing (deferred for now)

Windows SmartScreen warnings on first run are common for any unsigned installer and disappear after enough users run it (Microsoft tracks "reputation"). For a clean experience on day one, you need:

- An **EV (Extended Validation) code-signing certificate** — $200–500/yr from CAs like DigiCert, Sectigo, SSL.com.
- Or **Azure Trusted Signing** ($10/month, dramatically cheaper, but needs Azure tenant setup).

When you have the cert:
1. Export as `.pfx` with a password
2. Add `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` secrets to GitHub
3. Update the workflow's env block to include them on the `dist:win` job:
   ```yaml
   CSC_LINK: ${{ secrets.WIN_CSC_LINK }}
   CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}
   ```

(Yes, both Windows and Mac use the same env-var names — the workflow only sets one or the other depending on the OS via matrix conditions, OR you set both and electron-builder picks the right one per platform. The current workflow passes the mac ones; add Windows when you have the cert.)

---

## What happens if a secret is missing?

- **No Mac certificates** → `electron-builder` falls back to ad-hoc signing (`-` identity). Apps will still build but Gatekeeper will reject them — users see the "damaged" error.
- **No Apple notarization credentials** → app is signed locally but not notarized. macOS Catalina+ will block opening it (the "verify with developer" dance). Users have to `xattr -cr` manually.
- **No Windows cert** → unsigned `.exe`. SmartScreen warns "unrecognized publisher" but users can click through.

You can have signed-without-notarized (covers a lot of cases) by leaving only `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` blank.