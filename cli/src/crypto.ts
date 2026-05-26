import { createRequire } from 'node:module';
import { parse as uuidParse } from 'uuid';

// libsodium-wrappers ESM build is broken at 0.7.16; use CJS via createRequire.
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers-sumo') as typeof import('libsodium-wrappers-sumo');

let ready = false;
async function ensureReady(): Promise<void> {
  if (!ready) { await sodium.ready; ready = true; }
}

// AAD construction MUST match server/src/lib/aad.ts.
//   AAD = 0x01 || user_id(16) || file_id(16) || version_id(16) || key_id(16)  -> 65 bytes
export const AAD_VERSION = 0x01;
export function buildAad(args: { userId: string; fileId: string; versionId: string; keyId: string }): Buffer {
  const out = Buffer.alloc(65);
  out[0] = AAD_VERSION;
  Buffer.from(uuidParse(args.userId)).copy(out, 1);
  Buffer.from(uuidParse(args.fileId)).copy(out, 17);
  Buffer.from(uuidParse(args.versionId)).copy(out, 33);
  Buffer.from(uuidParse(args.keyId)).copy(out, 49);
  return out;
}

// Derive vault key from passphrase + salt using Argon2id (libsodium's crypto_pwhash).
// Same algorithm ID the server records (kdf_algo='argon2id'); parameters chosen for an MVP CLI.
export async function deriveVaultKey(passphrase: string, saltB64: string): Promise<Buffer> {
  await ensureReady();
  const salt = Buffer.from(saltB64, 'base64url');
  if (salt.length < 16) throw new Error('kdf_salt too short');
  // Use exactly 16 bytes of salt for libsodium pwhash (it requires SALTBYTES = 16).
  const salt16 = salt.subarray(0, 16);
  const key = sodium.crypto_pwhash(
    32,                                  // key length
    passphrase,
    salt16,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  return Buffer.from(key);
}

export async function newSalt16(): Promise<Buffer> {
  await ensureReady();
  return Buffer.from(sodium.randombytes_buf(16));
}

export async function aeadEncrypt(args: {
  key: Buffer; plaintext: Buffer; userId: string; fileId: string; versionId: string; keyId: string;
}): Promise<{ ciphertext: Buffer; nonce: Buffer }> {
  await ensureReady();
  const nonce = sodium.randombytes_buf(24);
  const aad = buildAad(args);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(args.plaintext, aad, null, nonce, args.key);
  return { ciphertext: Buffer.from(ct), nonce: Buffer.from(nonce) };
}

export async function aeadDecrypt(args: {
  key: Buffer; ciphertext: Buffer; nonce: Buffer; userId: string; fileId: string; versionId: string; keyId: string;
}): Promise<Buffer> {
  await ensureReady();
  const aad = buildAad(args);
  const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, args.ciphertext, aad, args.nonce, args.key);
  return Buffer.from(pt);
}

export async function blake2b(data: Buffer): Promise<Buffer> {
  await ensureReady();
  return Buffer.from(sodium.crypto_generichash(32, data));
}