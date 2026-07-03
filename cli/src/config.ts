import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';

// The config file holds the session cookie; the manifest holds sync metadata.
// Both live under ~/.claude-sync, which must not be world-readable.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Write a file with restrictive permissions. `mkdir`/`writeFile` mode options only
// apply on creation, so we chmod afterwards to also tighten a pre-existing dir/file
// that may have been created world-readable by an older build.
async function writeSecure(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  try { await chmod(dir, DIR_MODE); } catch { /* best-effort on platforms without POSIX perms */ }
  await writeFile(path, data, { encoding: 'utf8', mode: FILE_MODE });
  try { await chmod(path, FILE_MODE); } catch { /* best-effort */ }
}

export interface Config {
  serverUrl: string;
  session?: string;          // __Host-session cookie value
  userId?: string;
  deviceId?: string;
  // Local sync root (default ~/.claude); files under here are mirrored.
  syncRoot: string;
  // Sub-paths under syncRoot to include (empty = all). Excludes use prefix match.
  includePrefixes: string[];
  excludePrefixes: string[];
  cursor: number;           // last seen seq from /api/sync
}

export const CONFIG_DIR = join(homedir(), '.claude-sync');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const MANIFEST_PATH = join(CONFIG_DIR, 'manifest.json');

const DEFAULT: Config = {
  serverUrl: process.env['CLAUDE_SYNC_SERVER'] ?? 'https://claude-sync-production.up.railway.app',
  syncRoot: join(homedir(), '.claude'),
  includePrefixes: [
    'skills/', 'commands/', 'agents/', 'memory/', 'settings.json',
    // Plugins: only the small metadata files (which plugins are installed, which
    // marketplaces are configured, plugin-specific data). The actual plugin bodies
    // and marketplace clones live in plugins/cache and plugins/marketplaces — those
    // rebuild from URLs on demand on each machine.
    'plugins/installed_plugins.json', 'plugins/known_marketplaces.json', 'plugins/data/',
  ],
  excludePrefixes: [
    'projects/', 'sessions/', 'session-data/', 'cache/', 'shell-snapshots/',
    'paste-cache/', 'file-history/', 'backups/', 'telemetry/', 'metrics/',
    'ide/', 'downloads/', 'tasks/', 'session-env/',
    'plugins/cache/', 'plugins/marketplaces/', 'plugins/plugin-catalog-cache.json',
    'settings.local.json', '.credentials.json',
    'bash-commands.log', 'cost-tracker.log', 'history.jsonl',
    'mcp-health-cache.json', '.last-cleanup',
  ],
  cursor: 0,
};

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    return { ...DEFAULT, ...JSON.parse(raw) };
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return DEFAULT;
    throw e;
  }
}

export async function saveConfig(c: Config): Promise<void> {
  await writeSecure(CONFIG_PATH, JSON.stringify(c, null, 2));
}

export interface ManifestEntry {
  fileId: string;
  lastSeq: number;
  // Hash of the *plaintext* bytes we last pushed for this path; lets `push` skip unchanged files.
  // BLAKE2b-256 of plaintext, stored client-only (never sent to server).
  plaintextHashB64: string;
}

export type Manifest = Record<string, ManifestEntry>;  // key = path relative to syncRoot

export async function loadManifest(): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return {};
    throw e;
  }
}

export async function saveManifest(m: Manifest): Promise<void> {
  await writeSecure(MANIFEST_PATH, JSON.stringify(m, null, 2));
}