import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep, posix } from 'node:path';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { Api } from '../api.js';
import { loadConfig, saveConfig, loadManifest, saveManifest, type Manifest } from '../config.js';
import { aeadEncrypt, blake2b, deriveVaultKey } from '../crypto.js';
import { getPassphrase } from '../prompt.js';

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
  for (const ex of excludes) if (relPosix.startsWith(ex)) return false;
  if (includes.length === 0) return true;
  return includes.some((inc) => relPosix.startsWith(inc));
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
    const versionId = uuidv4();
    const { ciphertext, nonce } = await aeadEncrypt({
      key, plaintext, userId: config.userId, fileId, versionId, keyId: config.keyId,
    });

    try {
      const r = await api.putFileVersion(fileId, versionId, ciphertext, nonce.toString('base64url'), config.keyId, rel);
      manifest[rel] = { fileId, lastSeq: r.seq, plaintextHashB64: hashB64 };
      lastSeq = Math.max(lastSeq, r.seq);
      pushed++;
      console.log(`+ ${rel}  seq=${r.seq}`);
    } catch (e) {
      console.error(`! ${rel}: ${(e as Error).message}`);
    }
  }

  config.cursor = lastSeq;
  await saveConfig(config);
  await saveManifest(manifest);
  console.log(`pushed ${pushed}, skipped ${skipped}, cursor=${config.cursor}`);
}