import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep, posix } from 'node:path';
import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';
import { Api } from '../api.js';
import { loadConfig, saveConfig, loadManifest, saveManifest, type Manifest } from '../config.js';
import { aeadEncrypt, blake2b, deriveVaultKey } from '../crypto.js';
import { getPassphrase } from '../prompt.js';

// Stable namespace for deterministic versionId derivation: same (fileId, plaintextHash)
// always yields the same versionId, so a retried PUT after a lost response presents
// the same id and the server's PK constraint suppresses orphan duplicates.
const VERSION_ID_NAMESPACE = 'a9d3b1f4-7c1a-4b9e-8a13-1cf8d1a4d5b2';

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

export async function push(opts: { passphrase?: string } = {}): Promise<void> {
  const config = await loadConfig();
  if (!config.session) throw new Error('not logged in');
  if (!config.deviceId) throw new Error('no device registered');
  if (!config.keyId || !config.kdfSaltB64 || !config.userId) throw new Error('vault not initialized; run `vault-init`');
  const passphrase = opts.passphrase ?? await getPassphrase();
  const key = await deriveVaultKey(passphrase, config.kdfSaltB64);

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
    if (st.size > 1024 * 1024 - 32) {  // leave room for AEAD overhead under 1 MiB cap
      console.warn(`skip too-large: ${rel} (${st.size} bytes)`);
      skipped++;
      continue;
    }

    const plaintext = await readFile(abs);
    const hashB64 = (await blake2b(plaintext)).toString('base64url');
    const prev = manifest[rel];
    if (prev && prev.plaintextHashB64 === hashB64) { skipped++; continue; }

    const fileId = prev?.fileId ?? uuidv7();
    // Deterministic versionId: same (fileId, hash) -> same id, so a retry after a
    // lost response submits the same id and the server's PK constraint dedupes it.
    const versionId = uuidv5(`${fileId}|${hashB64}`, VERSION_ID_NAMESPACE);
    const { ciphertext, nonce } = await aeadEncrypt({
      key, plaintext, userId: config.userId, fileId, versionId, keyId: config.keyId,
    });

    try {
      const r = await api.putFileVersion(fileId, versionId, ciphertext, nonce.toString('base64url'), config.keyId, rel);
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