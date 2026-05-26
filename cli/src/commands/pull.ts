import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Api } from '../api.js';
import { loadConfig, saveConfig, loadManifest, saveManifest } from '../config.js';
import { aeadDecrypt, blake2b, deriveVaultKey } from '../crypto.js';
import { getPassphrase } from '../prompt.js';

export async function pull(opts: { passphrase?: string } = {}): Promise<void> {
  const config = await loadConfig();
  if (!config.session) throw new Error('not logged in');
  if (!config.keyId || !config.kdfSaltB64 || !config.userId) throw new Error('vault not initialized');
  const passphrase = opts.passphrase ?? await getPassphrase();
  const key = await deriveVaultKey(passphrase, config.kdfSaltB64);

  const api = new Api(config);
  const manifest = await loadManifest();

  let cursor = config.cursor;
  let downloaded = 0;
  let deleted = 0;

  while (true) {
    const { changes, next_seq, has_more } = await api.sync(cursor, 200);
    if (changes.length === 0) break;

    // Process only the latest change per file_id in this batch
    const latestByFile = new Map<string, typeof changes[number]>();
    for (const c of changes) latestByFile.set(c.file_id, c);

    for (const c of latestByFile.values()) {
      if (!c.path) continue;  // M1 server sends path; if missing, can't materialize
      const abs = join(config.syncRoot, c.path);

      if (c.deleted) {
        try { await unlink(abs); deleted++; console.log(`- ${c.path}`); }
        catch { /* already gone */ }
        delete manifest[c.path];
        continue;
      }

      // Fetch the latest blob (could be older than this seq if newer versions arrived in same batch;
      // since we use latestByFile we already pick the newest).
      const got = await api.getLatest(c.file_id);
      if ('gone' in got) continue;
      const plaintext = await aeadDecrypt({
        key, ciphertext: got.ciphertext, nonce: Buffer.from(got.nonceB64, 'base64url'),
        userId: config.userId, fileId: c.file_id, versionId: got.versionId, keyId: got.keyId,
      });
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, plaintext);
      const h = (await blake2b(plaintext)).toString('base64url');
      manifest[c.path] = { fileId: c.file_id, lastSeq: c.seq, plaintextHashB64: h };
      downloaded++;
      console.log(`> ${c.path}  seq=${c.seq}`);
    }

    cursor = next_seq;
    if (!has_more) break;
  }

  config.cursor = cursor;
  await saveConfig(config);
  await saveManifest(manifest);
  console.log(`downloaded ${downloaded}, deleted ${deleted}, cursor=${config.cursor}`);
}