import { v4 as uuidv4 } from 'uuid';
import { Api } from '../api.js';
import { loadConfig, saveConfig } from '../config.js';
import { newSalt16 } from '../crypto.js';
import { promptSecret, getPassphrase } from '../prompt.js';

export async function vaultInit(): Promise<void> {
  const config = await loadConfig();
  if (!config.session) throw new Error('not logged in');
  if (!config.deviceId) throw new Error('no device registered (`claude-sync device`)');
  const api = new Api(config);

  const existing = await api.getVaultMeta();
  if (existing) {
    // Adopt existing salt+key_id; don't overwrite (server will 409 if any file_versions exist).
    config.kdfAlgo = existing.kdf_algo;
    config.kdfSaltB64 = existing.kdf_salt_b64;
    config.keyId = existing.key_id;
    await saveConfig(config);
    console.log(`Adopted existing vault key (key_id=${existing.key_id}).`);
    console.log('To USE the vault, you must remember the original passphrase used to initialize it.');
    return;
  }

  const p1 = await getPassphrase();
  const p2 = process.env['CLAUDE_SYNC_PASSPHRASE'] ? p1 : await promptSecret('Confirm: ');
  if (p1 !== p2) throw new Error('passphrases do not match');
  if (p1.length < 12) throw new Error('passphrase too short');

  const salt = await newSalt16();
  const keyId = uuidv4();
  const meta = {
    kdf_algo: 'argon2id' as const,
    kdf_salt_b64: salt.toString('base64url'),
    key_id: keyId,
  };
  await api.putVaultMeta(meta);
  config.kdfAlgo = 'argon2id';
  config.kdfSaltB64 = meta.kdf_salt_b64;
  config.keyId = keyId;
  await saveConfig(config);
  console.log(`Vault initialized (key_id=${keyId}). Remember your passphrase â€” it is the only way to decrypt your files.`);
}

export async function vaultAdopt(): Promise<void> {
  const config = await loadConfig();
  if (!config.session) throw new Error('not logged in');
  const api = new Api(config);
  const existing = await api.getVaultMeta();
  if (!existing) throw new Error('no vault metadata on server; run `vault-init`');
  config.kdfAlgo = existing.kdf_algo;
  config.kdfSaltB64 = existing.kdf_salt_b64;
  config.keyId = existing.key_id;
  await saveConfig(config);
  console.log(`Adopted existing vault metadata (key_id=${existing.key_id}).`);
}