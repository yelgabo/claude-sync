import { writeFile, mkdir, unlink, readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
  let conflicts = 0;

  while (true) {
    const { changes, next_seq, has_more } = await api.sync(cursor, 200);
    if (changes.length === 0) break;

    const latestByFile = new Map<string, typeof changes[number]>();
    for (const c of changes) latestByFile.set(c.file_id, c);

    for (const c of latestByFile.values()) {
      if (!c.path) continue;
      const abs = join(config.syncRoot, c.path);

      if (c.deleted) {
        let applied = true;
        if (existsSync(abs)) {
          try {
            const local = await readFile(abs);
            const localHash = (await blake2b(local)).toString('base64url');
            const prev = manifest[c.path];
            if (prev && prev.plaintextHashB64 !== localHash) {
              const conflictPath = await makeConflictPath(abs);
              await rename(abs, conflictPath);
              conflicts++;
              console.log(`! conflict-on-delete: ${c.path} kept as ${conflictPath.replace(config.syncRoot, '~/.claude')}`);
            } else {
              await unlink(abs);
            }
          } catch (err) {
            if ((err as { code?: string }).code !== 'ENOENT') {
              applied = false;
              console.error(`! delete failed for ${c.path}: ${(err as Error).message}`);
            }
          }
        }
        if (applied) {
          delete manifest[c.path];
          deleted++;
          console.log(`- ${c.path}`);
          // Persist after each applied change — a crash mid-batch would otherwise leave
          // the cursor advanced in memory while disk state still reflects the prior version.
          config.cursor = c.seq;
          await saveManifest(manifest);
          await saveConfig(config);
        }
        continue;
      }

      const got = await api.getLatest(c.file_id);
      if ('gone' in got) continue;
      const plaintext = await aeadDecrypt({
        key, ciphertext: got.ciphertext, nonce: Buffer.from(got.nonceB64, 'base64url'),
        userId: config.userId, fileId: c.file_id, versionId: got.versionId, keyId: got.keyId,
      });

      if (existsSync(abs)) {
        const local = await readFile(abs);
        const localHash = (await blake2b(local)).toString('base64url');
        const prev = manifest[c.path];
        const remoteHash = (await blake2b(plaintext)).toString('base64url');
        if (prev && prev.plaintextHashB64 !== localHash && localHash !== remoteHash) {
          const conflictPath = await makeConflictPath(abs);
          await rename(abs, conflictPath);
          conflicts++;
          console.log(`! conflict: ${c.path}  local-edit saved as ${conflictPath.replace(config.syncRoot, '~/.claude')}`);
        }
      }

      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, plaintext);
      const h = (await blake2b(plaintext)).toString('base64url');
      manifest[c.path] = { fileId: c.file_id, lastSeq: c.seq, plaintextHashB64: h };
      downloaded++;
      console.log(`> ${c.path}  seq=${c.seq}`);
      config.cursor = c.seq;
      await saveManifest(manifest);
      await saveConfig(config);
    }

    cursor = next_seq;
    config.cursor = cursor;
    await saveConfig(config);
    if (!has_more) break;
  }

  console.log(`downloaded ${downloaded}, deleted ${deleted}, conflicts ${conflicts}, cursor=${config.cursor}`);
}

// Pick a path of the form `<path>.conflict-<YYYYMMDD-HHmmss>[-<n>].<ext>` that doesn't exist yet.
async function makeConflictPath(originalAbs: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\.\d+Z$/, '').slice(0, 19);
  const base = `${originalAbs}.conflict-${stamp}`;
  if (!existsSync(base)) return base;
  for (let i = 2; i < 100; i++) {
    const p = `${base}-${i}`;
    if (!existsSync(p)) return p;
  }
  return `${base}-${Date.now()}`;
}