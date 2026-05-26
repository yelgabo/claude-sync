import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, safeStorage, shell, Notification } from 'electron';
import { join } from 'node:path';
import { hostname } from 'node:os';
import {
  Api, ApiError, loadConfig, saveConfig, deriveVaultKey, push as cliPush, pull as cliPull,
  type Config,
} from '@claude-sync/cli';

interface AppState {
  win: BrowserWindow | null;
  tray: Tray | null;
  vaultKey: Buffer | null;          // derived from passphrase, held in memory only
  syncTimer: NodeJS.Timeout | null;
  syncing: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
}

const state: AppState = {
  win: null, tray: null, vaultKey: null, syncTimer: null,
  syncing: false, lastSyncAt: null, lastError: null,
};

const SYNC_INTERVAL_MS = 15_000;

async function api(): Promise<Api> {
  return new Api(await loadConfig());
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

function updateTrayMenu(): void {
  if (!state.tray) return;
  const loggedIn = state.vaultKey !== null;
  const status = state.syncing
    ? 'SyncingÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦'
    : state.lastError
      ? `Error: ${state.lastError.slice(0, 60)}`
      : state.lastSyncAt
        ? `Last sync ${new Date(state.lastSyncAt).toLocaleTimeString()}`
        : 'Idle';

  state.tray.setToolTip(`Claude Sync ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ${status}`);
  state.tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: 'separator' },
    { label: 'Open window', click: () => showWindow() },
    { label: 'Sync now', enabled: loggedIn && !state.syncing, click: () => { void syncOnce(); } },
    { type: 'separator' },
    { label: 'Open Railway dashboard', click: () => shell.openExternal('https://claude-sync-production.up.railway.app/healthz') },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]));
}

function showWindow(): void {
  if (state.win && !state.win.isDestroyed()) {
    state.win.show(); state.win.focus(); return;
  }
  state.win = new BrowserWindow({
    width: 520, height: 620,
    title: 'Claude Sync',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  state.win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  state.win.on('closed', () => { state.win = null; });
}

async function syncOnce(): Promise<void> {
  if (state.syncing || !state.vaultKey) return;
  state.syncing = true;
  state.lastError = null;
  updateTrayMenu();
  broadcast('sync-state', { syncing: true });
  // Get the cleartext passphrase-equivalent: we hold the *derived* key,
  // but the CLI push/pull APIs take a passphrase. We need to re-derive ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â or
  // refactor to accept a key directly. Easier: store the passphrase and re-derive each call.
  // (See state.passphrase below ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â kept in memory only.)
  try {
    await cliPull({ passphrase: passphraseRef.value ?? '' });
    await cliPush({ passphrase: passphraseRef.value ?? '' });
    state.lastSyncAt = Date.now();
  } catch (e) {
    state.lastError = (e as Error).message;
    new Notification({ title: 'Claude Sync error', body: state.lastError }).show();
  } finally {
    state.syncing = false;
    updateTrayMenu();
    broadcast('sync-state', { syncing: false, lastSyncAt: state.lastSyncAt, lastError: state.lastError });
  }
}

function startSyncLoop(): void {
  if (state.syncTimer) return;
  state.syncTimer = setInterval(() => { void syncOnce(); }, SYNC_INTERVAL_MS);
  void syncOnce();  // immediate first sync
}

function stopSyncLoop(): void {
  if (state.syncTimer) { clearInterval(state.syncTimer); state.syncTimer = null; }
  state.vaultKey = null;
  passphraseRef.value = null;
  updateTrayMenu();
}

// Passphrase reference ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â held in module-local closure, never persisted unless `Remember`
const passphraseRef: { value: string | null } = { value: null };

// === Secure storage of session cookie + remembered passphrase ===
// safeStorage uses OS keychain (Windows DPAPI). Available after app.ready.
async function savePassphrase(p: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) return;
  const enc = safeStorage.encryptString(p);
  const cfg = await loadConfig();
  (cfg as Config & { rememberedPassphraseB64?: string }).rememberedPassphraseB64 = enc.toString('base64');
  await saveConfig(cfg as Config);
}

async function loadRememberedPassphrase(): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;
  const cfg = await loadConfig() as Config & { rememberedPassphraseB64?: string };
  if (!cfg.rememberedPassphraseB64) return null;
  try {
    return safeStorage.decryptString(Buffer.from(cfg.rememberedPassphraseB64, 'base64'));
  } catch { return null; }
}

async function clearRememberedPassphrase(): Promise<void> {
  const cfg = await loadConfig() as Config & { rememberedPassphraseB64?: string };
  delete cfg.rememberedPassphraseB64;
  await saveConfig(cfg);
}

// === Convenience-mode auto vault setup ===
// When config.convenienceMode is true, derive the vault key from the user's login
// password. Trade-off vs the 1Password-style separate passphrase: the server briefly
// sees the login password during /auth/login, so a malicious server could derive the
// same key. Acceptable for the dogfood phase; users can disable convenience mode in
// Settings to require a separate passphrase.
async function tryConvenienceUnlock(loginPassword: string): Promise<{ status: 'created' | 'unlocked' | 'skipped' }> {
  const cfg = await loadConfig();
  if (!cfg.convenienceMode || !cfg.session) return { status: 'skipped' };
  const a = new Api(cfg);
  const existing = await a.getVaultMeta();
  if (existing) {
    cfg.kdfAlgo = existing.kdf_algo;
    cfg.kdfSaltB64 = existing.kdf_salt_b64;
    cfg.keyId = existing.key_id;
    await saveConfig(cfg);
    state.vaultKey = await deriveVaultKey(loginPassword, existing.kdf_salt_b64);
    passphraseRef.value = loginPassword;
    return { status: 'unlocked' };
  }
  const { newSalt16 } = await import('@claude-sync/cli');
  const { randomUUID } = await import('node:crypto');
  const salt = await newSalt16();
  const keyId = randomUUID();
  await a.putVaultMeta({ kdf_algo: 'argon2id', kdf_salt_b64: salt.toString('base64url'), key_id: keyId });
  cfg.kdfAlgo = 'argon2id';
  cfg.kdfSaltB64 = salt.toString('base64url');
  cfg.keyId = keyId;
  await saveConfig(cfg);
  state.vaultKey = await deriveVaultKey(loginPassword, salt.toString('base64url'));
  passphraseRef.value = loginPassword;
  return { status: 'created' };
}

// === IPC handlers ===

ipcMain.handle('app:status', async () => {
  const cfg = await loadConfig();
  return {
    serverUrl: cfg.serverUrl,
    syncRoot: cfg.syncRoot,
    cursor: cfg.cursor,
    loggedIn: !!cfg.session,
    userId: cfg.userId ?? null,
    deviceId: cfg.deviceId ?? null,
    vaultInitialized: !!cfg.keyId,
    keyId: cfg.keyId ?? null,
    unlocked: state.vaultKey !== null,
    syncing: state.syncing,
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError,
    canRememberSecrets: safeStorage.isEncryptionAvailable(),
    convenienceMode: cfg.convenienceMode,
  };
});

ipcMain.handle('auth:signup', async (_e, args: { email: string; password: string }) => {
  const cfg = await loadConfig();
  const a = new Api(cfg);
  const { user, sessionCookie } = await a.signup(args.email, args.password);
  cfg.session = sessionCookie;
  cfg.userId = user.id;
  await saveConfig(cfg);
  // Auto register device + unlock vault when convenience mode is enabled.
  if (cfg.convenienceMode) {
    if (!cfg.deviceId) {
      const dev = await a.createDevice(hostname());
      const cfg2 = await loadConfig();
      cfg2.deviceId = dev.device.id;
      await saveConfig(cfg2);
    }
    const r = await tryConvenienceUnlock(args.password);
    if (r.status === 'created' || r.status === 'unlocked') {
      startSyncLoop();
      updateTrayMenu();
    }
  }
  return { user };
});

ipcMain.handle('auth:login', async (_e, args: { email: string; password: string }) => {
  const cfg = await loadConfig();
  const a = new Api(cfg);
  const { user, sessionCookie } = await a.login(args.email, args.password);
  cfg.session = sessionCookie;
  cfg.userId = user.id;
  await saveConfig(cfg);
  if (cfg.convenienceMode) {
    try {
      console.log('[auth:login] convenience mode on; deviceId=' + cfg.deviceId);
      if (!cfg.deviceId) {
        const dev = await a.createDevice(hostname());
        const cfg2 = await loadConfig();
        cfg2.deviceId = dev.device.id;
        await saveConfig(cfg2);
        console.log('[auth:login] device created id=' + dev.device.id);
      }
      const r = await tryConvenienceUnlock(args.password);
      console.log('[auth:login] convenience unlock status=' + r.status);
      if (r.status === 'created' || r.status === 'unlocked') {
        startSyncLoop();
        updateTrayMenu();
      }
    } catch (err) {
      console.error('[auth:login] convenience block failed:', (err as Error).message, (err as Error).stack);
    }
  } else {
    console.log('[auth:login] convenience mode OFF');
  }
  return { user };
});

ipcMain.handle('auth:logout', async () => {
  const cfg = await loadConfig();
  try { await new Api(cfg).logout(); } catch { /* ignore */ }
  delete cfg.session;
  delete cfg.deviceId;
  await saveConfig(cfg);
  stopSyncLoop();
  await clearRememberedPassphrase();
  return { ok: true };
});

ipcMain.handle('device:register', async (_e, args: { name: string }) => {
  const cfg = await loadConfig();
  const a = new Api(cfg);
  const { device } = await a.createDevice(args.name);
  cfg.deviceId = device.id;
  await saveConfig(cfg);
  return { device };
});

ipcMain.handle('vault:init', async (_e, args: { passphrase: string }) => {
  const cfg = await loadConfig();
  if (!cfg.session) throw new Error('not logged in');
  const a = new Api(cfg);
  const existing = await a.getVaultMeta();
  if (existing) {
    cfg.kdfAlgo = existing.kdf_algo;
    cfg.kdfSaltB64 = existing.kdf_salt_b64;
    cfg.keyId = existing.key_id;
    await saveConfig(cfg);
    // Try the passphrase against the existing salt; if derivation succeeds we adopt.
    state.vaultKey = await deriveVaultKey(args.passphrase, existing.kdf_salt_b64);
    passphraseRef.value = args.passphrase;
    return { mode: 'adopted', keyId: existing.key_id };
  }
  // Create new
  const { newSalt16 } = await import('@claude-sync/cli');
  const { randomUUID } = await import('node:crypto');
  const salt = await newSalt16();
  const keyId = randomUUID();
  await a.putVaultMeta({ kdf_algo: 'argon2id', kdf_salt_b64: salt.toString('base64url'), key_id: keyId });
  cfg.kdfAlgo = 'argon2id';
  cfg.kdfSaltB64 = salt.toString('base64url');
  cfg.keyId = keyId;
  await saveConfig(cfg);
  state.vaultKey = await deriveVaultKey(args.passphrase, salt.toString('base64url'));
  passphraseRef.value = args.passphrase;
  return { mode: 'created', keyId };
});

ipcMain.handle('vault:unlock', async (_e, args: { passphrase: string; remember: boolean }) => {
  const cfg = await loadConfig();
  if (!cfg.session) throw new Error('not logged in');
  if (!cfg.deviceId) throw new Error('no device registered');
  if (!cfg.kdfSaltB64 || !cfg.keyId) throw new Error('vault not initialized');
  state.vaultKey = await deriveVaultKey(args.passphrase, cfg.kdfSaltB64);
  passphraseRef.value = args.passphrase;
  if (args.remember) await savePassphrase(args.passphrase);
  startSyncLoop();
  updateTrayMenu();
  return { ok: true };
});

ipcMain.handle('vault:lock', async () => {
  stopSyncLoop();
  await clearRememberedPassphrase();
  return { ok: true };
});

ipcMain.handle('sync:now', async () => {
  if (!state.vaultKey) throw new Error('vault locked');
  await syncOnce();
  return { ok: true };
});

ipcMain.handle('settings:get', async () => {
  const cfg = await loadConfig();
  return {
    syncRoot: cfg.syncRoot,
    includePrefixes: cfg.includePrefixes,
    excludePrefixes: cfg.excludePrefixes,
    serverUrl: cfg.serverUrl,
    convenienceMode: cfg.convenienceMode,
  };
});

ipcMain.handle('settings:set', async (_e, args: { syncRoot?: string; includePrefixes?: string[]; excludePrefixes?: string[]; serverUrl?: string; convenienceMode?: boolean }) => {
  const cfg = await loadConfig();
  if (args.syncRoot !== undefined) cfg.syncRoot = args.syncRoot;
  if (args.includePrefixes !== undefined) cfg.includePrefixes = args.includePrefixes;
  if (args.excludePrefixes !== undefined) cfg.excludePrefixes = args.excludePrefixes;
  if (args.serverUrl !== undefined) cfg.serverUrl = args.serverUrl;
  await saveConfig(cfg);
  return { ok: true };
});

ipcMain.handle('files:list', async () => {
  const cfg = await loadConfig();
  if (!cfg.session) throw new Error('not logged in');
  const a = new Api(cfg);
  // Api doesn't expose a list method; use raw fetch with the cookie.
  const res = await fetch(`${cfg.serverUrl}/api/files`, {
    headers: { 'cookie': `__Host-session=${cfg.session}`, 'x-requested-with': 'claude-sync' },
  });
  if (!res.ok) throw new Error(`list failed: HTTP ${res.status}`);
  return res.json() as Promise<{ files: Array<{ file_id: string; path: string | null; latest_seq: number; size_bytes: number; deleted: boolean }> }>;
});

// === Lifecycle ===

app.whenReady().then(async () => {
  // Tray icon: use a 16x16 empty PNG as placeholder; user can ship a proper one later.
  const icon = nativeImage.createEmpty();
  state.tray = new Tray(icon);
  state.tray.setToolTip('Claude Sync');
  updateTrayMenu();
  state.tray.on('click', () => showWindow());

  // Try auto-unlock with remembered passphrase
  try {
    const cfg = await loadConfig();
    if (cfg.session && cfg.deviceId && cfg.kdfSaltB64) {
      const remembered = await loadRememberedPassphrase();
      if (remembered) {
        state.vaultKey = await deriveVaultKey(remembered, cfg.kdfSaltB64);
        passphraseRef.value = remembered;
        startSyncLoop();
        updateTrayMenu();
        new Notification({ title: 'Claude Sync', body: 'Auto-unlocked; sync running in the background.' }).show();
      }
    }
  } catch (e) {
    state.lastError = (e as Error).message;
  }

  showWindow();
});

// Don't quit when window closes ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â stay in tray.
// Stay alive in the tray after all windows close (do not call app.quit()).
app.on('window-all-closed', () => { /* no-op: tray keeps us alive */ });