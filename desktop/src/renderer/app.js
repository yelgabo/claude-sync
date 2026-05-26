/* global claudeSync */

const $ = (id) => document.getElementById(id);
const show = (el, on) => { if (el) el.hidden = !on; };

const authSection = $('auth-section');
const deviceSection = $('device-section');
const vaultSection = $('vault-section');
const syncSection = $('sync-section');
const settingsSection = $('settings-section');
const statusPill = $('status-pill');

function setStatus(text, kind) {
  statusPill.textContent = text;
  statusPill.className = `pill ${kind || ''}`;
}

async function refresh() {
  let st;
  try { st = await claudeSync.status(); }
  catch (e) { setStatus('error', 'err'); return; }

  show(authSection, !st.loggedIn);
  show(deviceSection, st.loggedIn && !st.deviceId);
  show(vaultSection, st.loggedIn && st.deviceId && !st.unlocked);
  show(syncSection, st.unlocked);
  show(settingsSection, st.unlocked);

  if (!st.loggedIn) setStatus('signed out', '');
  else if (!st.deviceId) setStatus('register device', 'warn');
  else if (!st.vaultInitialized) setStatus('init vault', 'warn');
  else if (!st.unlocked) setStatus('locked', 'warn');
  else if (st.syncing) setStatus('syncing', 'ok');
  else if (st.lastError) setStatus('sync error', 'err');
  else setStatus('synced', 'ok');

  // Vault title/help differs based on whether vault metadata exists
  if (st.loggedIn && st.deviceId) {
    if (!st.vaultInitialized) {
      $('vault-title').textContent = 'Initialize vault';
      $('vault-help').textContent = 'Choose a passphrase. This will encrypt your files end-to-end. The server never sees this passphrase or the derived key.';
      $('vault-btn').textContent = 'Create vault';
    } else {
      $('vault-title').textContent = 'Unlock vault';
      $('vault-help').textContent = 'Enter the passphrase you used to initialize the vault on any device.';
      $('vault-btn').textContent = 'Unlock';
    }
  }

  if (st.unlocked) {
    await refreshFiles();
    await refreshSettings();
    updateSyncStatus(st);
  }
}

async function refreshFiles() {
  const list = $('file-list');
  try {
    const data = await claudeSync.listFiles();
    renderFiles(data.files || []);
  } catch (e) {
    list.textContent = `Error listing files: ${e.message}`;
  }
}

function renderFiles(files) {
  const list = $('file-list');
  list.innerHTML = '';
  $('file-count').textContent = `(${files.length})`;
  if (files.length === 0) {
    list.textContent = 'No files synced yet. Edit a file under ~/.claude/skills/ to trigger a push.';
    return;
  }
  for (const f of files) {
    const el = document.createElement('div');
    el.className = 'file' + (f.deleted ? ' deleted' : '');
    const path = f.path ?? f.file_id;
    el.innerHTML = `<span class="path" title="${escapeHtml(path)}">${escapeHtml(path)}</span>` +
                   `<span class="meta">${f.size_bytes} B Â· seq ${f.latest_seq}</span>`;
    list.appendChild(el);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function refreshSettings() {
  const s = await claudeSync.getSettings();
  $('sync-root').textContent = s.syncRoot;
  $('server-url').textContent = s.serverUrl;
  $('include-prefixes').textContent = (s.includePrefixes || []).join(', ') || '(all)';
  $('exclude-prefixes').textContent = (s.excludePrefixes || []).join(', ') || '(none)';
}

function updateSyncStatus(st) {
  const line = $('sync-status');
  if (st.syncing) line.textContent = 'Sync in progressâ€¦';
  else if (st.lastSyncAt) line.textContent = `Last synced at ${new Date(st.lastSyncAt).toLocaleTimeString()}`;
  else line.textContent = 'Idle (next sync within 15s).';
  const errEl = $('sync-err');
  if (st.lastError) { errEl.hidden = false; errEl.textContent = st.lastError; }
  else errEl.hidden = true;
}

// === Form handlers ===

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-err').textContent = '';
  const email = $('email').value;
  const password = $('password').value;
  try {
    await claudeSync.login(email, password);
    await refresh();
  } catch (err) {
    $('auth-err').textContent = err.message;
  }
});

$('signup-btn').addEventListener('click', async () => {
  $('auth-err').textContent = '';
  const email = $('email').value;
  const password = $('password').value;
  if (!email || password.length < 12) {
    $('auth-err').textContent = 'Email + 12+ char password required.';
    return;
  }
  try {
    await claudeSync.signup(email, password);
    await refresh();
  } catch (err) {
    $('auth-err').textContent = err.message;
  }
});

$('device-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('device-err').textContent = '';
  try {
    await claudeSync.registerDevice($('device-name').value);
    await refresh();
  } catch (err) {
    $('device-err').textContent = err.message;
  }
});

// Prefill device name from OS
$('device-name').value = (navigator.userAgent.match(/Windows NT[^)]*/) || ['Windows'])[0];

$('vault-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('vault-err').textContent = '';
  const p = $('vault-passphrase').value;
  const remember = $('vault-remember').checked;
  try {
    const st = await claudeSync.status();
    if (!st.vaultInitialized) {
      await claudeSync.vaultInit(p);
      await claudeSync.vaultUnlock(p, remember);
    } else {
      await claudeSync.vaultUnlock(p, remember);
    }
    $('vault-passphrase').value = '';
    await refresh();
  } catch (err) {
    $('vault-err').textContent = err.message;
  }
});

$('sync-now-btn').addEventListener('click', async () => {
  $('sync-now-btn').disabled = true;
  try { await claudeSync.syncNow(); await refresh(); }
  catch (e) { $('sync-err').hidden = false; $('sync-err').textContent = e.message; }
  finally { $('sync-now-btn').disabled = false; }
});

$('vault-lock-btn').addEventListener('click', async () => {
  await claudeSync.vaultLock();
  await refresh();
});

$('logout-btn').addEventListener('click', async () => {
  await claudeSync.logout();
  await refresh();
});

claudeSync.onSyncState(() => refresh());

refresh();
setInterval(refresh, 5000);