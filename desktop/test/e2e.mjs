// E2E test: launches Electron, drives the renderer via Playwright,
// asserts login flow + file listing work.

import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { copyFileSync, existsSync, unlinkSync } from 'node:fs';

const EMAIL = process.env.CLAUDE_SYNC_EMAIL ?? 'yelnil@gmail.com';
const PASSWORD = process.env.CLAUDE_SYNC_PASSWORD ?? 'first-test-passphrase-1234';
const PASSPHRASE = process.env.CLAUDE_SYNC_PASSPHRASE ?? 'vault-test-passphrase-1234';

const CONFIG_DIR = join(homedir(), '.claude-sync');
const CONFIG = join(CONFIG_DIR, 'config.json');
const BACKUP = join(CONFIG_DIR, 'config.json.e2e-backup');

function preserve() {
  if (existsSync(CONFIG)) copyFileSync(CONFIG, BACKUP);
}
function restore() {
  if (existsSync(BACKUP)) copyFileSync(BACKUP, CONFIG);
}

async function run() {
  preserve();
  try {
    // Start with no session â€” force login flow
    if (existsSync(CONFIG)) unlinkSync(CONFIG);

    console.log('Launching Electron...');
    const app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: new URL('..', import.meta.url).pathname.replace(/^\//, ''),
      timeout: 30_000,
    });

    const win = await app.firstWindow({ timeout: 15_000 });
    win.on('console', (msg) => console.log('[renderer ' + msg.type() + ']', msg.text()));
    win.on('pageerror', (err) => console.log('[pageerror]', err.message));
    await win.waitForLoadState('domcontentloaded');
    console.log('Window loaded.');
    // Wait a tick for refresh() to run
    await win.waitForTimeout(2000);
    const initial = await win.evaluate(() => ({
      authHidden: document.getElementById('auth-section')?.hidden,
      pill: document.getElementById('status-pill')?.textContent,
      hasBridge: typeof claudeSync !== 'undefined',
    }));
    console.log('Initial state:', JSON.stringify(initial));

    // 1. Login form should be visible
    await win.waitForSelector('#auth-section:not([hidden])', { timeout: 5_000 });
    console.log('Login form visible.');

    // 2. Submit login
    await win.fill('#email', EMAIL);
    await win.fill('#password', PASSWORD);
    await Promise.all([
      win.click('#login-btn'),
      win.waitForSelector('#device-section:not([hidden]), #vault-section:not([hidden]), #sync-section:not([hidden])', { timeout: 15_000 }),
    ]);
    console.log('Login posted.');

    // 3. If we landed on device-section, register a device.
    if (await win.locator('#device-section:not([hidden])').count() > 0) {
      await win.fill('#device-name', 'e2e-test-device');
      await Promise.all([
        win.click('#device-form button[type=submit]'),
        win.waitForSelector('#vault-section:not([hidden]), #sync-section:not([hidden])', { timeout: 15_000 }),
      ]);
      console.log('Device registered.');
    }

    // 4. Vault: unlock (vault metadata already on server from earlier CLI test).
    if (await win.locator('#vault-section:not([hidden])').count() > 0) {
      await win.fill('#vault-passphrase', PASSPHRASE);
      await Promise.all([
        win.click('#vault-form button[type=submit]'),
        win.waitForSelector('#sync-section:not([hidden])', { timeout: 30_000 }),
      ]);
      console.log('Vault unlocked.');
    }

    // 5. Sync section should be visible and showing the file list.
    await win.waitForSelector('#sync-section:not([hidden])');
    // Wait for file list to populate (sync runs immediately on unlock).
    await win.waitForFunction(() => {
      const el = document.getElementById('file-list');
      return el && el.textContent && el.textContent.length > 0 && !el.textContent.includes('Loading');
    }, null, { timeout: 30_000 });
    const fileListText = await win.textContent('#file-list');
    const fileCount = await win.textContent('#file-count');
    console.log('File list rendered:');
    console.log('  count: ' + (fileCount ?? '(empty)'));
    console.log('  preview: ' + (fileListText ?? '').slice(0, 200));

    // 6. Verify settings panel shows synced config
    await win.waitForSelector('#settings-section:not([hidden])');
    const syncRoot = await win.textContent('#sync-root');
    const serverUrl = await win.textContent('#server-url');
    const include = await win.textContent('#include-prefixes');
    console.log('Settings:');
    console.log('  sync root:    ' + syncRoot);
    console.log('  server:       ' + serverUrl);
    console.log('  includes:     ' + include);

    assert.ok(syncRoot && syncRoot.length > 0, 'sync root should be populated');
    assert.ok(serverUrl && serverUrl.startsWith('http'), 'server url should be populated');

    // 7. Status pill should not show error
    const pillText = (await win.textContent('#status-pill')) ?? '';
    console.log('Status pill: ' + pillText);
    assert.ok(!pillText.includes('error'), 'status pill must not show error after unlock');

    console.log('\nALL ASSERTIONS PASSED');
    await app.close();
    process.exit(0);
  } finally {
    restore();
  }
}

run().catch((e) => {
  console.error('E2E FAIL:', e);
  restore();
  process.exit(1);
});