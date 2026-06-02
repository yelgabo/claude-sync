import * as api from './api.js';
import { diffLines } from 'diff';
import { bytesToBlob } from './crypto.js';

interface State {
  userId: string | null;
  email: string | null;
  files: api.FileEntry[];
  selectedFile: api.FileEntry | null;
}

const state: State = {
  userId: null, email: null, files: [], selectedFile: null,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

function show(el: HTMLElement | null, on: boolean): void { if (el) el.hidden = !on; }

function setStatus(text: string, kind: '' | 'ok' | 'warn' | 'err' = ''): void {
  const pill = $('status-pill');
  pill.textContent = text;
  pill.className = `pill ${kind}`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

// === Bootstrap ===
async function boot(): Promise<void> {
  setStatus('checking session...');
  try {
    const me = await api.me();
    state.userId = me.user.id;
    state.email = me.user.email;
    showAppShell();
  } catch {
    showAuth();
  }
}

function showAuth(): void {
  setStatus('signed out');
  show($('auth'), true);
  show($('app-shell'), false);
}

function showAppShell(): void {
  show($('auth'), false);
  show($('app-shell'), true);
  $('who').textContent = state.email ?? '';
  setStatus('signed in', 'ok');
  refreshActiveTab();
}

// === Login flow ===
$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-err').textContent = '';
  const email = ($('email') as HTMLInputElement).value;
  const pwInput = $<HTMLInputElement>('password');
  const password = pwInput.value;
  // Wipe before any network call so the input never holds the password longer than needed.
  pwInput.value = '';
  try {
    setStatus('signing in...', 'warn');
    const r = await api.login(email, password);
    state.userId = r.user.id;
    state.email = r.user.email;
    showAppShell();
  } catch (err) {
    $('auth-err').textContent = (err as Error).message;
    setStatus('signed out');
  }
});

// === Tab switching ===
document.addEventListener('click', (ev) => {
  const t = (ev.target as HTMLElement).closest('.tab') as HTMLElement | null;
  if (!t) return;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('.tab-pane').forEach((p) => {
    (p as HTMLElement).hidden = (p as HTMLElement).dataset['tabPane'] !== t.dataset['tab'];
  });
  refreshActiveTab();
});

async function refreshActiveTab(): Promise<void> {
  const active = document.querySelector('.tab.active') as HTMLElement;
  if (!active) return;
  if (active.dataset['tab'] === 'files') await refreshFiles();
  if (active.dataset['tab'] === 'activity') await refreshActivity();
  if (active.dataset['tab'] === 'devices') await refreshDevices();
}

// === FILES ===
async function refreshFiles(): Promise<void> {
  const list = $('file-list');
  try {
    const { files } = await api.listFiles();
    state.files = files;
    renderFiles();
  } catch (e) {
    list.textContent = `Error: ${(e as Error).message}`;
  }
}

function renderFiles(): void {
  const list = $('file-list');
  const filter = (($('file-filter') as HTMLInputElement).value || '').toLowerCase();
  list.innerHTML = '';
  const filtered = state.files.filter((f) => {
    const p = (f.path ?? f.file_id).toLowerCase();
    return !filter || p.includes(filter);
  });
  $('file-count').textContent = `(${filtered.length}/${state.files.length})`;
  if (filtered.length === 0) {
    list.textContent = 'No files synced yet.';
    return;
  }
  filtered.sort((a, b) => (a.path ?? a.file_id).localeCompare(b.path ?? b.file_id));
  for (const f of filtered) {
    const el = document.createElement('div');
    el.className = 'row-file' + (f.deleted ? ' deleted' : '');
    el.title = 'Click for version history';
    const path = f.path ?? f.file_id;
    el.innerHTML = `<span class="path">${esc(path)}</span><span class="meta">${f.size_bytes} B ·  seq ${f.latest_seq}</span>`;
    el.addEventListener('click', () => openVersionsDrawer(f));
    list.appendChild(el);
  }
}
$('file-filter').addEventListener('input', renderFiles);

async function openVersionsDrawer(file: api.FileEntry): Promise<void> {
  state.selectedFile = file;
  const drawer = $('versions-drawer');
  drawer.hidden = false;
  $('versions-file').textContent = file.path ?? file.file_id;
  const list = $('versions-list');
  list.textContent = 'Loading...';
  try {
    const { versions } = await api.listVersions(file.file_id);
    list.innerHTML = '';
    for (const v of versions) {
      const div = document.createElement('div');
      div.className = 'ver';
      const when = new Date(v.uploaded_at).toLocaleString();
      const label = document.createElement('span');
      label.innerHTML = `seq ${v.seq} ·  ${v.size_bytes} B ·  ${esc(when)}${v.deleted ? ' <em>(tombstone)</em>' : ''}`;
      div.appendChild(label);
      if (!v.deleted) {
        // Compare with latest (only meaningful for non-latest versions)
        if (v.id !== file.latest_version_id) {
          const cmp = document.createElement('button');
          cmp.className = 'secondary small';
          cmp.textContent = 'Compare';
          cmp.addEventListener('click', () => openDiff(file, v).catch((e) => alert((e as Error).message)));
          div.appendChild(cmp);
        }
        const btn = document.createElement('button');
        btn.className = 'secondary small';
        btn.textContent = 'Download';
        btn.addEventListener('click', () => downloadVersion(file, v).catch((e) => alert((e as Error).message)));
        div.appendChild(btn);
      }
      list.appendChild(div);
    }
  } catch (e) {
    list.textContent = `Error: ${(e as Error).message}`;
  }
}
$('versions-close').addEventListener('click', () => { $('versions-drawer').hidden = true; });

async function downloadVersion(file: api.FileEntry, ver: api.VersionEntry): Promise<void> {
  const v = await api.fetchVersion(file.file_id, ver.id);
  const filename = (file.path ?? file.file_id).split('/').pop() ?? 'file';
  const url = URL.createObjectURL(bytesToBlob(v.content));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// === ACTIVITY ===
async function refreshActivity(): Promise<void> {
  const list = $('activity-list');
  try {
    const r = await api.sync(0, 500);
    list.innerHTML = '';
    const tail = r.changes.slice(-50).reverse();
    if (!tail.length) { list.textContent = 'No activity yet.'; return; }
    for (const c of tail) {
      const div = document.createElement('div');
      div.className = 'row-act';
      const arrow = c.deleted ? 'x' : 'up';
      div.innerHTML = `<span class="arrow ${c.deleted ? 'deleted' : ''}">${arrow}</span><span class="path">${esc(c.path ?? c.file_id)}</span><span class="size">seq ${c.seq}${c.deleted ? '' : ' ·  ' + c.size_bytes + ' B'}</span>`;
      list.appendChild(div);
    }
  } catch (e) { list.textContent = `Error: ${(e as Error).message}`; }
}

// === DEVICES ===
async function refreshDevices(): Promise<void> {
  const list = $('device-list');
  try {
    const { devices } = await api.listDevices();
    list.innerHTML = '';
    for (const d of devices) {
      const div = document.createElement('div');
      div.className = 'dev';
      const last = d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : 'never';
      div.innerHTML = `<span class="name">${esc(d.name)}</span><span class="when">last seen ${esc(last)}</span>`;
      list.appendChild(div);
    }
    if (devices.length === 0) list.textContent = 'No devices linked.';
  } catch (e) { list.textContent = `Error: ${(e as Error).message}`; }
}

// === Logout ===
$('logout-btn').addEventListener('click', async () => {
  if (!confirm('Log out?')) return;
  try { await api.logout(); } catch {}
  state.userId = null; state.email = null;
  showAuth();
});

boot();
// === DIFF VIEW (web app) ===
async function openDiff(file: api.FileEntry, older: api.VersionEntry): Promise<void> {
  const drawer = $('diff-view');
  drawer.hidden = false;
  $('diff-label').textContent = `seq ${older.seq} vs latest (seq ${file.latest_seq})`;
  const content = $('diff-content');
  content.innerHTML = 'Loading both versions...';

  try {
    const [olderV, latestV] = await Promise.all([
      api.fetchVersion(file.file_id, older.id),
      api.fetchVersion(file.file_id, file.latest_version_id),
    ]);
    const olderText = decoderText(olderV.content);
    const latestText = decoderText(latestV.content);
    renderDiff(content, olderText, latestText);
  } catch (e) {
    content.textContent = `Cannot diff: ${(e as Error).message} (binary file?)`;
  }
}

const td = new TextDecoder('utf-8', { fatal: true });
function decoderText(bytes: Uint8Array): string {
  return td.decode(bytes);
}

function renderDiff(container: HTMLElement, older: string, latest: string): void {
  container.innerHTML = '';
  const parts = diffLines(older, latest);
  for (const p of parts) {
    const lines = p.value.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) {
      const div = document.createElement('div');
      const cls = p.added ? 'add' : p.removed ? 'del' : 'same';
      div.className = `diff-line ${cls}`;
      const m = p.added ? '+' : p.removed ? '−' : ' ';
      div.innerHTML = `<span class="marker">${m}</span><span>${esc(line)}</span>`;
      container.appendChild(div);
    }
  }
  if (!container.children.length) {
    container.textContent = '(no textual differences)';
  }
}
$('diff-close').addEventListener('click', () => { $('diff-view').hidden = true; });