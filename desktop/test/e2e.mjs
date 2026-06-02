// E2E test: launches Electron, drives the renderer via Playwright,
// asserts login flow + file listing work.

import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { copyFileSync, existsSync, unlinkSync } from 'node:fs';

const RUN_ID = Math.random().toString(36).slice(2, 8);
const EMAIL = process.env.CLAUDE_SYNC_EMAIL ?? `e2e+${RUN_ID}@example.com`;
const PASSWORD = process.env.CLAUDE_SYNC_PASSWORD ?? 'first-test-passphrase-1234';

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
    // Start with no session — force login flow
    if (existsSync(CONFIG)) unlinkSync(CONFIG);

    console.log('Launching Electron...');
    const app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: new URL('..', import.meta.url).pathname.replace(/^\//, ''),
      timeout: 30_000,
    });
    app.process().stdout?.on('data', (d) => process.stdout.write('[main stdout] ' + d.toString()));
    app.process().stderr?.on('data', (d) => process.stdout.write('[main stderr] ' + d.toString()));

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

    // 2. Sign up a fresh user (auto-registers this device and starts syncing)
    await win.fill('#email', EMAIL);
    await win.fill('#password', PASSWORD);
    await Promise.all([
      win.click('#signup-btn'),
      win.waitForSelector('#app-shell:not([hidden])', { timeout: 30_000 }),
    ]);
    console.log('Signed up: ' + EMAIL);

    // 3. App shell appears once the device is registered and sync is running.
    await win.waitForSelector('#app-shell:not([hidden])', { timeout: 30_000 });
    console.log('App shell visible (device registered, sync running).');

    // 5. Sync section should be visible and showing the file list.
    await win.waitForSelector('#app-shell:not([hidden])');
    // Wait for file list to populate (sync runs immediately on unlock).
    await win.waitForFunction(() => {
      const el = document.getElementById('file-tree');
      return el && el.textContent && el.textContent.length > 0 && !el.textContent.includes('Loading');
    }, null, { timeout: 30_000 });
    const fileListText = await win.textContent('#file-tree');
    const fileCount = await win.textContent('#file-count');
    console.log('File list rendered:');
    console.log('  count: ' + (fileCount ?? '(empty)'));
    console.log('  preview: ' + (fileListText ?? '').slice(0, 200));

    // 6. Verify settings tab shows synced config
    await win.click('button.tab[data-tab=settings]');
    await win.waitForTimeout(500);
    const syncRoot = await win.textContent('#sync-root');
    const serverUrl = await win.textContent('#server-url');
    const include = await win.textContent('#includes-list');
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