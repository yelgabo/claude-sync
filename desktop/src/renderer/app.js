/* global claudeSync */
const $ = (id) => document.getElementById(id);
const show = (el, on) => { if (el) el.hidden = !on; };

const authSection = $('auth-section');
const deviceSection = $('device-section');
const vaultSection = $('vault-section');
const appShell = $('app-shell');
const statusPill = $('status-pill');

let lastStatus = {};

function setStatus(text, kind) {
  statusPill.textContent = text;
  statusPill.className = `pill ${kind || ''}`;
}

// === Top-level refresh ===
async function refresh() {
  let st;
  try { st = await claudeSync.status(); }
  catch { setStatus('error', 'err'); return; }
  lastStatus = st;

  show(authSection, !st.loggedIn);
  show(deviceSection, st.loggedIn && !st.deviceId && !st.convenienceMode);
  show(vaultSection, st.loggedIn && st.deviceId && !st.unlocked && !st.convenienceMode);
  show(appShell, st.unlocked);

  if (!st.loggedIn) setStatus('signed out', '');
  else if (!st.deviceId) setStatus('register device', 'warn');
  else if (!st.vaultInitialized) setStatus('init vault', 'warn');
  else if (!st.unlocked) setStatus('locked', 'warn');
  else if (st.paused) setStatus('paused', 'warn');
  else if (st.syncing) setStatus('syncing', 'ok');
  else if (st.lastError) setStatus('sync error', 'err');
  else setStatus('synced', 'ok');

  if (st.loggedIn && st.deviceId && !st.convenienceMode) {
    if (!st.vaultInitialized) {
      $('vault-title').textContent = 'Initialize vault';
      $('vault-help').textContent = 'Choose a passphrase. End-to-end encrypts your files; the server never sees this passphrase or the derived key.';
      $('vault-btn').textContent = 'Create vault';
    } else {
      $('vault-title').textContent = 'Unlock vault';
      $('vault-help').textContent = 'Enter the passphrase you used to initialize the vault.';
      $('vault-btn').textContent = 'Unlock';
    }
  }

  if (st.unlocked) {
    updateSyncStatus(st);
    $('pause-btn').textContent = st.paused ? 'Resume' : 'Pause';
    // Refresh whichever tab is active
    const active = document.querySelector('.tab.active');
    if (active) await refreshTab(active.dataset.tab);
  }
}

function updateSyncStatus(st) {
  const line = $('sync-status');
  if (st.paused) line.textContent = 'Sync paused.';
  else if (st.syncing) line.textContent = 'Sync in progress…';
  else if (st.lastSyncAt) line.textContent = `Last synced at ${new Date(st.lastSyncAt).toLocaleTimeString()}`;
  else line.textContent = 'Idle.';
  const errEl = $('sync-err');
  if (st.lastError) { errEl.hidden = false; errEl.textContent = st.lastError; }
  else errEl.hidden = true;
}

// === Tabs ===
document.addEventListener('click', (ev) => {
  const tab = ev.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  document.querySelectorAll('.tab-pane').forEach((p) => { p.hidden = p.dataset.tabPane !== tab.dataset.tab; });
  refreshTab(tab.dataset.tab);
});

async function refreshTab(name) {
  if (name === 'files') await refreshFiles();
  if (name === 'activity') await refreshActivity();
  if (name === 'devices') await refreshDevices();
  if (name === 'settings') await refreshSettings();
}

// === Files ===
let allFiles = [];

async function refreshFiles() {
  const tree = $('file-tree');
  try {
    const data = await claudeSync.listFiles();
    allFiles = data.files || [];
    renderFiles();
  } catch (e) {
    tree.textContent = `Error: ${e.message}`;
  }
}

function renderFiles() {
  const tree = $('file-tree');
  const filter = ($('file-filter').value || '').toLowerCase();
  tree.innerHTML = '';
  const filtered = allFiles.filter((f) => {
    const p = (f.path ?? f.file_id).toLowerCase();
    return !filter || p.includes(filter);
  });
  $('file-count').textContent = `(${filtered.length}/${allFiles.length})`;
  if (filtered.length === 0) {
    tree.textContent = 'No files. Edit a file under ~/.claude/skills/ to trigger a push.';
    return;
  }
  filtered.sort((a, b) => (a.path ?? a.file_id).localeCompare(b.path ?? b.file_id));
  for (const f of filtered) {
    const el = document.createElement('div');
    el.className = 'row-file' + (f.deleted ? ' deleted' : '');
    el.title = 'Click for version history';
    const path = f.path ?? f.file_id;
    el.innerHTML = `<span class="path">${escapeHtml(path)}</span>` +
                   `<span class="meta">${f.size_bytes} B · seq ${f.latest_seq}</span>`;
    el.addEventListener('click', () => openVersionsDrawer(f));
    tree.appendChild(el);
  }
}

$('file-filter').addEventListener('input', renderFiles);

// === Versions drawer ===
async function openVersionsDrawer(file) {
  const drawer = $('versions-drawer');
  drawer.hidden = false;
  $('versions-file').textContent = file.path ?? file.file_id;
  const list = $('versions-list');
  list.textContent = 'Loading…';
  try {
    const data = await claudeSync.listVersions(file.file_id);
    list.innerHTML = '';
    for (const v of data.versions) {
      const div = document.createElement('div');
      div.className = 'ver';
      const when = new Date(v.uploaded_at).toLocaleString();
      const tomb = v.deleted ? ' <span class="tombstone">(tombstone)</span>' : '';
      div.innerHTML = `<span class="label">seq ${v.seq} · ${v.size_bytes} B · ${when}${tomb}</span>`;
      if (!v.deleted) {
        const btn = document.createElement('button');
        btn.className = 'secondary small';
        btn.textContent = 'Restore';
        btn.addEventListener('click', async () => {
          if (!confirm(`Restore version ${v.seq}?`)) return;
          btn.disabled = true; btn.textContent = '…';
          try {
            await claudeSync.restoreVersion(file.file_id, v.id);
            alert('Restored — new version uploaded.');
            await refresh();
          } catch (e) { alert(`Restore failed: ${e.message}`); btn.disabled = false; btn.textContent = 'Restore'; }
        });
        div.appendChild(btn);
      }
      list.appendChild(div);
    }
  } catch (e) {
    list.textContent = `Error: ${e.message}`;
  }
}
$('versions-close').addEventListener('click', () => { $('versions-drawer').hidden = true; });

// === Activity ===
async function refreshActivity() {
  const list = $('activity-list');
  try {
    const data = await claudeSync.activity(50);
    list.innerHTML = '';
    if (!data.changes.length) {
      list.textContent = 'No activity yet.';
      return;
    }
    for (const c of data.changes) {
      const div = document.createElement('div');
      div.className = 'row-act';
      const arrow = c.deleted ? '✗' : '↑';
      div.innerHTML = `<span class="arrow ${c.deleted ? 'deleted' : ''}">${arrow}</span>` +
                      `<span class="path">${escapeHtml(c.path ?? c.file_id)}</span>` +
                      `<span class="size">seq ${c.seq}${c.deleted ? '' : ' · ' + c.size_bytes + ' B'}</span>`;
      list.appendChild(div);
    }
  } catch (e) {
    list.textContent = `Error: ${e.message}`;
  }
}

// === Devices ===
async function refreshDevices() {
  const list = $('device-list');
  try {
    const data = await claudeSync.listDevices();
    list.innerHTML = '';
    for (const d of data.devices) {
      const isCurrent = d.id === lastStatus.deviceId;
      const div = document.createElement('div');
      div.className = 'dev';
      const lastSeen = d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : 'never';
      div.innerHTML = `<span class="name">${escapeHtml(d.name)}</span>` +
                      (isCurrent ? '<span class="current">this device</span>' : '') +
                      `<span class="when">last seen ${lastSeen}</span>`;

      const renameBtn = document.createElement('button');
      renameBtn.className = 'secondary small';
      renameBtn.textContent = 'Rename';
      renameBtn.addEventListener('click', async () => {
        const newName = prompt('New device name:', d.name);
        if (!newName || newName === d.name) return;
        try { await claudeSync.renameDevice(d.id, newName); await refreshDevices(); }
        catch (e) { alert(`Rename failed: ${e.message}`); }
      });
      div.appendChild(renameBtn);

      const revokeBtn = document.createElement('button');
      revokeBtn.className = 'danger small';
      revokeBtn.textContent = isCurrent ? 'Revoke (this device)' : 'Revoke';
      revokeBtn.addEventListener('click', async () => {
        if (!confirm(`Revoke device "${d.name}"? Sessions bound to it will be invalidated.`)) return;
        try { await claudeSync.revokeDevice(d.id); await refresh(); }
        catch (e) { alert(`Revoke failed: ${e.message}`); }
      });
      div.appendChild(revokeBtn);

      list.appendChild(div);
    }
  } catch (e) {
    list.textContent = `Error: ${e.message}`;
  }
}

// === Settings ===
async function refreshSettings() {
  const s = await claudeSync.getSettings();
  $('sync-root').textContent = s.syncRoot;
  $('server-url').textContent = s.serverUrl;
  $('convenience-mode').checked = !!s.convenienceMode;
  $('sync-interval').value = Math.round((lastStatus.syncIntervalMs ?? 15000) / 1000);
  renderChipList('includes-list', s.includePrefixes || [], 'includePrefixes');
  renderChipList('excludes-list', s.excludePrefixes || [], 'excludePrefixes');
}

function renderChipList(containerId, items, settingKey) {
  const c = $(containerId);
  c.innerHTML = '';
  for (const it of items) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${escapeHtml(it)} <button title="remove">×</button>`;
    chip.querySelector('button').addEventListener('click', async () => {
      const cur = (await claudeSync.getSettings())[settingKey] || [];
      const next = cur.filter((x) => x !== it);
      await claudeSync.setSettings({ [settingKey]: next });
      await refreshSettings();
    });
    c.appendChild(chip);
  }
}

async function addPrefix(inputId, settingKey) {
  const input = $(inputId);
  const v = input.value.trim();
  if (!v) return;
  const cur = (await claudeSync.getSettings())[settingKey] || [];
  if (cur.includes(v)) { input.value = ''; return; }
  await claudeSync.setSettings({ [settingKey]: [...cur, v] });
  input.value = '';
  await refreshSettings();
}
$('includes-add-btn').addEventListener('click', () => addPrefix('includes-add', 'includePrefixes'));
$('excludes-add-btn').addEventListener('click', () => addPrefix('excludes-add', 'excludePrefixes'));

document.addEventListener('change', async (ev) => {
  if (ev.target.id === 'convenience-mode') {
    await claudeSync.setSettings({ convenienceMode: ev.target.checked });
    await refresh();
  }
  if (ev.target.id === 'sync-interval') {
    const sec = Number(ev.target.value);
    if (sec >= 5 && sec <= 3600) {
      await claudeSync.syncSetInterval(sec);
    }
  }
});

// === Auth + actions ===
$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-err').textContent = '';
  try { await claudeSync.login($('email').value, $('password').value); await refresh(); }
  catch (err) { $('auth-err').textContent = err.message; }
});

$('signup-btn').addEventListener('click', async () => {
  $('auth-err').textContent = '';
  const email = $('email').value, password = $('password').value;
  if (!email || password.length < 12) { $('auth-err').textContent = 'Email + 12+ char password required.'; return; }
  try { await claudeSync.signup(email, password); await refresh(); }
  catch (err) { $('auth-err').textContent = err.message; }
});

$('device-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('device-err').textContent = '';
  try { await claudeSync.registerDevice($('device-name').value); await refresh(); }
  catch (err) { $('device-err').textContent = err.message; }
});
$('device-name').value = (navigator.userAgent.match(/Windows NT[^)]*/) || ['Windows'])[0];

$('vault-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('vault-err').textContent = '';
  const p = $('vault-passphrase').value, remember = $('vault-remember').checked;
  try {
    const st = await claudeSync.status();
    if (!st.vaultInitialized) { await claudeSync.vaultInit(p); await claudeSync.vaultUnlock(p, remember); }
    else { await claudeSync.vaultUnlock(p, remember); }
    $('vault-passphrase').value = '';
    await refresh();
  } catch (err) { $('vault-err').textContent = err.message; }
});

$('sync-now-btn').addEventListener('click', async () => {
  $('sync-now-btn').disabled = true;
  try { await claudeSync.syncNow(); await refresh(); }
  catch (e) { $('sync-err').hidden = false; $('sync-err').textContent = e.message; }
  finally { $('sync-now-btn').disabled = false; }
});

$('pause-btn').addEventListener('click', async () => {
  await claudeSync.syncPause(!lastStatus.paused);
  await refresh();
});

$('logout-btn').addEventListener('click', async () => {
  if (!confirm('Log out and clear local session?')) return;
  await claudeSync.logout(); await refresh();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

claudeSync.onSyncState(() => refresh());
refresh();
setInterval(refresh, 5000);