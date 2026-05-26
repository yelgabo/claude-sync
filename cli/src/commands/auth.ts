import { Api } from '../api.js';
import { loadConfig, saveConfig } from '../config.js';
import { promptLine, promptSecret, getPassword } from '../prompt.js';

export async function signup(email?: string): Promise<void> {
  const config = await loadConfig();
  const api = new Api(config);
  const e = email ?? await promptLine('Email: ');
  const p1 = await getPassword();
  const p2 = process.env['CLAUDE_SYNC_PASSWORD'] ? p1 : await promptSecret('Confirm: ');
  if (p1 !== p2) throw new Error('passwords do not match');
  const { user, sessionCookie } = await api.signup(e, p1);
  config.session = sessionCookie;
  config.userId = user.id;
  await saveConfig(config);
  console.log(`Signed up: ${user.email} (id=${user.id}). Session stored at ~/.claude-sync/config.json.`);
}

export async function login(email?: string): Promise<void> {
  const config = await loadConfig();
  const api = new Api(config);
  const e = email ?? await promptLine('Email: ');
  const p = await getPassword();
  const { user, sessionCookie } = await api.login(e, p);
  config.session = sessionCookie;
  config.userId = user.id;
  await saveConfig(config);
  console.log(`Logged in as ${user.email}.`);
}

export async function logout(): Promise<void> {
  const config = await loadConfig();
  const api = new Api(config);
  try { await api.logout(); } catch { /* ignore */ }
  delete config.session;
  delete config.deviceId;
  delete config.userId;
  await saveConfig(config);
  console.log('Logged out.');
}

export async function status(): Promise<void> {
  const config = await loadConfig();
  console.log(JSON.stringify({
    serverUrl: config.serverUrl,
    syncRoot: config.syncRoot,
    includePrefixes: config.includePrefixes,
    excludePrefixes: config.excludePrefixes,
    cursor: config.cursor,
    loggedIn: !!config.session,
    userId: config.userId ?? null,
    deviceId: config.deviceId ?? null,
    vaultInitialized: !!config.keyId,
    keyId: config.keyId ?? null,
  }, null, 2));
}