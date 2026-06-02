import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, safeStorage, shell, Notification } from 'electron';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import { join } from 'node:path';
import { hostname } from 'node:os';
import {
  Api, loadConfig, saveConfig, push as cliPush, pull as cliPull,
} from '@claude-sync/cli';

interface AppState {
  win: BrowserWindow | null;
  tray: Tray | null;
  running: boolean;                 // sync loop active (logged in + device registered)
  syncTimer: NodeJS.Timeout | null;
  syncing: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  paused: boolean;
}

const state: AppState = {
  win: null, tray: null, running: false, syncTimer: null,
  syncing: false, lastSyncAt: null, lastError: null, paused: false,
};

let syncIntervalMs = 15_000;

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

function updateTrayMenu(): void {
  if (!state.tray) return;
  const status = state.syncing
    ? 'Syncing...'
    : state.lastError
      ? `Error: ${state.lastError.slice(0, 60)}`
      : state.lastSyncAt
        ? `Last sync ${new Date(state.lastSyncAt).toLocaleTimeString()}`
        : 'Idle';

  state.tray.setToolTip(`Claude Sync — ${status}`);
  state.tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: 'separator' },
    { label: 'Open window', click: () => showWindow() },
    { label: 'Sync now', enabled: state.running && !state.syncing, click: () => { void syncOnce(); } },
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
  if (state.syncing || !state.running || state.paused) return;
  state.syncing = true;
  state.lastError = null;
  updateTrayMenu();
  broadcast('sync-state', { syncing: true });
  try {
    await cliPull();
    await cliPush();
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
  state.running = true;
  if (state.syncTimer) return;
  state.syncTimer = setInterval(() => { void syncOnce(); }, syncIntervalMs);
  void syncOnce();  // immediate first sync
}

function stopSyncLoop(): void {
  if (state.syncTimer) { clearInterval(state.syncTimer); state.syncTimer = null; }
  state.running = false;
  updateTrayMenu();
}

// Ensure this machine is registered as a device, then start syncing. Called after
// login/signup and on startup when a session already exists.
async function ensureDeviceAndSync(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.session) return;
  if (!cfg.deviceId) {
    const dev = await new Api(cfg).createDevice(hostname());
    const cfg2 = await loadConfig();
    cfg2.deviceId = dev.device.id;
    await saveConfig(cfg2);
  }
  startSyncLoop();
  updateTrayMenu();
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
    running: state.running,
    syncing: state.syncing,
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError,
    canRememberSecrets: safeStorage.isEncryptionAvailable(),
    paused: state.paused,
    syncIntervalMs,
  };
});

ipcMain.handle('auth:signup', async (_e, args: { email: string; password: string }) => {
  const cfg = await loadConfig();
  const a = new Api(cfg);
  const { user, sessionCookie } = await a.signup(args.email, args.password);
  cfg.session = sessionCookie;
  cfg.userId = user.id;
  await saveConfig(cfg);
  await ensureDeviceAndSync();
  return { user };
});

ipcMain.handle('auth:login', async (_e, args: { email: string; password: string }) => {
  const cfg = await loadConfig();
  const a = new Api(cfg);
  const { user, sessionCookie } = await a.login(args.email, args.password);
  cfg.session = sessionCookie;
  cfg.userId = user.id;
  await saveConfig(cfg);
  await ensureDeviceAndSync();
  return { user };
});

ipcMain.handle('auth:logout', async () => {
  const cfg = await loadConfig();
  try { await new Api(cfg).logout(); } catch { /* ignore */ }
  delete cfg.session;
  delete cfg.deviceId;
  await saveConfig(cfg);
  stopSyncLoop();
  return { ok: true };
});

ipcMain.handle('device:register', async (_e, args: { name: string }) => {
  const cfg = await loadConfig();
  const a = new Api(cfg);
  const { device } = await a.createDevice(args.name);
  cfg.deviceId = device.id;
  await saveConfig(cfg);
  startSyncLoop();
  updateTrayMenu();
  return { device };
});

ipcMain.handle('sync:now', async () => {
  if (!state.running) throw new Error('not syncing (log in first)');
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
    paused: state.paused,
    syncIntervalMs,
  };
});

ipcMain.handle('settings:set', async (_e, args: { syncRoot?: string; includePrefixes?: string[]; excludePrefixes?: string[]; serverUrl?: string }) => {
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
  const res = await fetch(`${cfg.serverUrl}/api/files`, {
    headers: { 'cookie': `__Host-session=${cfg.session}`, 'x-requested-with': 'claude-sync' },
  });
  if (!res.ok) throw new Error(`list failed: HTTP ${res.status}`);
  return res.json() as Promise<{ files: Array<{ file_id: string; path: string | null; latest_seq: number; size_bytes: number; deleted: boolean }> }>;
});

ipcMain.handle('devices:list', async () => {
  const cfg = await loadConfig();
  if (!cfg.session) throw new Error('not logged in');
  const res = await fetch(`${cfg.serverUrl}/api/devices`, {
    headers: { cookie: `__Host-session=${cfg.session}`, 'x-requested-with': 'claude-sync' },
  });
  if (!res.ok) throw new Error(`devices/list failed: ${res.status}`);
  return res.json() as Promise<{ devices: Array<{ id: string; name: string; created_at: string; last_seen_at: string | null }> }>;
});

ipcMain.handle('devices:rename', async (_e, args: { id: string; name: string }) => {
  const cfg = await loadConfig();
  if (!cfg.session) throw new Error('not logged in');
  const res = await fetch(`${cfg.serverUrl}/api/devices/${args.id}`, {
    method: 'PATCH',
    headers: { cookie: `__Host-session=${cfg.session}`, 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
    body: JSON.stringify({ name: args.name }),
  });
  if (!res.ok) throw new Error(`devices/rename failed: ${res.status}`);
  return res.json();
});

ipcMain.handle('devices:revoke', async (_e, args: { id: string }) => {
  const cfg = await loadConfig();
  if (!cfg.session) throw new Error('not logged in');
  const res = await fetch(`${cfg.serverUrl}/api/devices/${args.id}`, {
    method: 'DELETE',
    headers: { cookie: `__Host-session=${cfg.session}`, 'x-requested-with': 'claude-sync' },
  });
  if (!res.ok) throw new Error(`devices/revoke failed: ${res.status}`);
  // If revoking the current device, also nuke local session.
  if (cfg.deviceId === args.id) {
    delete cfg.session; delete cfg.deviceId;
    await saveConfig(cfg);
    stopSyncLoop();
  }
  return { ok: true };
});

ipcMain.handle('activity:recent', async (_e, args: { limit?: number } = {}) => {
  const cfg = await loadConfig();
  if (!cfg.session) throw new Error('not logged in');
  const limit = args.limit ?? 50;
  const res = await fetch(`${cfg.serverUrl}/api/sync?since=0&limit=500`, {
    headers: { cookie: `__Host-session=${cfg.session}`, 'x-requested-with': 'claude-sync' },
  });
  if (!res.ok) throw new Error(`activity failed: ${res.status}`);
  const body = await res.json() as { changes: Array<{ file_id: string; version_id: string; seq: number; size_bytes: number; deleted: boolean; path: string | null }> };
  const tail = body.changes.slice(-limit).reverse();
  return { changes: tail };
});

ipcMain.handle('files:versions', async (_e, args: { fileId: string }) => {
  const cfg = await loadConfig();
  if (!cfg.session) throw new Error('not logged in');
  const res = await fetch(`${cfg.serverUrl}/api/files/${args.fileId}/versions`, {
    headers: { cookie: `__Host-session=${cfg.session}`, 'x-requested-with': 'claude-sync' },
  });
  if (!res.ok) throw new Error(`versions failed: ${res.status}`);
  return res.json();
});

ipcMain.handle('files:restore', async (_e, args: { fileId: string; versionId: string }) => {
  // Restore = fetch that version's content and re-upload it as a NEW version.
  const cfg = await loadConfig();
  if (!cfg.session || !cfg.deviceId) throw new Error('not ready');
  const { randomUUID } = await import('node:crypto');

  const verRes = await fetch(`${cfg.serverUrl}/api/files/${args.fileId}/versions/${args.versionId}`, {
    headers: { cookie: `__Host-session=${cfg.session}`, 'x-requested-with': 'claude-sync' },
  });
  if (!verRes.ok) throw new Error(`restore: get version failed ${verRes.status}`);
  if (verRes.headers.get('x-deleted') === 'true') throw new Error('cannot restore a tombstone');
  const content = Buffer.from(await verRes.arrayBuffer());

  const newVersionId = randomUUID();
  const putRes = await fetch(`${cfg.serverUrl}/api/files/${args.fileId}/versions/${newVersionId}`, {
    method: 'PUT',
    headers: {
      cookie: `__Host-session=${cfg.session}`,
      'x-requested-with': 'claude-sync',
      'content-type': 'application/octet-stream',
    },
    body: content as unknown as undefined,
  });
  if (!putRes.ok) throw new Error(`restore: put failed ${putRes.status}`);
  return putRes.json();
});

ipcMain.handle('sync:pause', async (_e, args: { paused: boolean }) => {
  state.paused = args.paused;
  updateTrayMenu();
  broadcast('sync-state', { syncing: state.syncing, lastSyncAt: state.lastSyncAt, lastError: state.lastError, paused: state.paused });
  return { ok: true };
});

ipcMain.handle('sync:setInterval', async (_e, args: { seconds: number }) => {
  const n = Math.max(5, Math.min(3600, Math.floor(args.seconds)));
  syncIntervalMs = n * 1000;
  if (state.syncTimer) { clearInterval(state.syncTimer); state.syncTimer = null; }
  if (state.running) startSyncLoop();
  return { ok: true, intervalMs: syncIntervalMs };
});

// === Lifecycle ===

app.whenReady().then(async () => {
  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 60 * 60 * 1000);
  }
  // Build a 16x16 template icon: a simple black filled circle. macOS uses it as a
  // template (auto-inverts for light/dark menu bars); Windows shows it as a flat icon.
  const SIZE = 16;
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const cx = (SIZE - 1) / 2;
  const cy = (SIZE - 1) / 2;
  const r = 6.5;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const i = (y * SIZE + x) * 4;
      const inside = d <= r;
      rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0;
      rgba[i + 3] = inside ? 255 : 0;
    }
  }
  const icon = nativeImage.createFromBuffer(rgba, { width: SIZE, height: SIZE });
  icon.setTemplateImage(true);
  state.tray = new Tray(icon);
  state.tray.setToolTip('Claude Sync');
  updateTrayMenu();
  state.tray.on('click', () => showWindow());

  // Resume syncing automatically if a session already exists.
  try {
    const cfg = await loadConfig();
    if (cfg.session && cfg.deviceId) {
      startSyncLoop();
      updateTrayMenu();
      new Notification({ title: 'Claude Sync', body: 'Sync running in the background.' }).show();
    }
  } catch (e) {
    state.lastError = (e as Error).message;
  }

  showWindow();
});

// Stay alive in the tray after all windows close (do not call app.quit()).
app.on('window-all-closed', () => { /* no-op: tray keeps us alive */ });
