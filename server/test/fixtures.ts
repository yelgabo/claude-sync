import { createRequire } from 'node:module';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { buildAad } from '../src/lib/aad.js';

// libsodium-wrappers @0.7.16 has a broken ESM build (imports a sibling .mjs
// that doesn't exist). Force CJS resolution via createRequire to bypass.
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

let ready = false;
async function ensure(): Promise<void> {
  if (!ready) { await sodium.ready; ready = true; }
}

export async function makeKey(): Promise<Buffer> {
  await ensure();
  return Buffer.from(sodium.crypto_aead_xchacha20poly1305_ietf_keygen());
}

export async function encrypt(args: {
  key: Buffer; plaintext: Buffer; userId: string; fileId: string; versionId: string; keyId: string;
}): Promise<{ ciphertext: Buffer; nonce: Buffer }> {
  await ensure();
  const nonce = sodium.randombytes_buf(24);
  const aad = buildAad({ userId: args.userId, fileId: args.fileId, versionId: args.versionId, keyId: args.keyId });
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(args.plaintext, aad, null, nonce, args.key);
  return { ciphertext: Buffer.from(ct), nonce: Buffer.from(nonce) };
}

export async function decrypt(args: {
  key: Buffer; ciphertext: Buffer; nonce: Buffer;
  userId: string; fileId: string; versionId: string; keyId: string;
}): Promise<Buffer> {
  await ensure();
  const aad = buildAad({ userId: args.userId, fileId: args.fileId, versionId: args.versionId, keyId: args.keyId });
  const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, args.ciphertext, aad, args.nonce, args.key);
  return Buffer.from(pt);
}

export const newFileId = () => uuidv7();
export const newVersionId = () => uuidv4();
