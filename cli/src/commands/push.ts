import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep, posix } from 'node:path';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { Api } from '../api.js';
import { loadConfig, saveConfig, loadManifest, saveManifest, type Manifest } from '../config.js';
import { blake2b } from '../crypto.js';

function toPosix(p: string): string { return p.split(sep).join(posix.sep); }

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string): Promise<void> {
    let ents;
    try { ents = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile()) out.push(p);
    }
  }
  await rec(root);
  return out;
}

function shouldSync(relPosix: string, includes: string[], excludes: string[]): boolean {
  for (const ex of excludes) {
    // Trailing-slash entries match a directory prefix; otherwise match the exact file or a prefix.
    if (ex.endsWith('/') ? relPosix.startsWith(ex) : (relPosix === ex || relPosix.startsWith(ex + '/'))) return false;
  }
  if (includes.length === 0) return true;
  return includes.some((inc) => ex_is_match(relPosix, inc));
}
function ex_is_match(p: string, pattern: string): boolean {
  if (pattern.endsWith('/')) return p.startsWith(pattern);
  return p === pattern || p.startsWith(pattern + '/');
}

export async function push(): Promise<void> {
  const config = await loadConfig();
  if (!config.session) throw new Error('not logged in');
  if (!config.deviceId) throw new Error('no device registered');

  const api = new Api(config);
  const manifest = await loadManifest();
  const root = config.syncRoot;

  const absPaths = await walk(root);
  let pushed = 0;
  let skipped = 0;
  let lastSeq = config.cursor;
  const failures: { rel: string; error: Error }[] = [];

  for (const abs of absPaths) {
    const rel = toPosix(relative(root, abs));
    if (!shouldSync(rel, config.includePrefixes, config.excludePrefixes)) continue;

    const st = await stat(abs);
    if (st.size > 1024 * 1024) {  // 1 MiB server cap
      console.warn(`skip too-large: ${rel} (${st.size} bytes)`);
      skipped++;
      continue;
    }

    const content = await readFile(abs);
    const hashB64 = (await blake2b(content)).toString('base64url');
    const prev = manifest[rel];
    if (prev && prev.plaintextHashB64 === hashB64) { skipped++; continue; }

    const fileId = prev?.fileId ?? uuidv7();
    // versionId must be a v4 UUID (server requires it). A lost-response retry generates
    // a fresh id, so it may create a duplicate version of identical content — harmless;
    // the manifest's per-path hash skips already-pushed files on the next run.
    const versionId = uuidv4();

    try {
      const r = await api.putFileVersion(fileId, versionId, content, rel);
      manifest[rel] = { fileId, lastSeq: r.seq, plaintextHashB64: hashB64 };
      lastSeq = Math.max(lastSeq, r.seq);
      pushed++;
      console.log(`+ ${rel}  seq=${r.seq}`);
      // Persist incrementally so a crash mid-batch doesn't lose the manifest entries
      // for files we already uploaded to the server.
      config.cursor = lastSeq;
      await saveManifest(manifest);
      await saveConfig(config);
    } catch (e) {
      const err = e as Error;
      failures.push({ rel, error: err });
      console.error(`! ${rel}: ${err.message}`);
    }
  }

  config.cursor = lastSeq;
  await saveConfig(config);
  await saveManifest(manifest);
  console.log(`pushed ${pushed}, skipped ${skipped}, failed ${failures.length}, cursor=${config.cursor}`);
  if (failures.length > 0) {
    // Surface failures so the caller (watch loop, syncOnce in the desktop) can back
    // off and surface an error to the user — silently dropping them would mask data
    // loss across an entire batch.
    const first = failures[0]!;
    throw new Error(`push: ${failures.length} file(s) failed; first: ${first.rel}: ${first.error.message}`);
  }
}