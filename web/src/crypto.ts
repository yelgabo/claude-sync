// Browser-side crypto using @noble/* (pure TS, no WASM resolution issues).
// AAD construction MUST match server/src/lib/aad.ts byte-for-byte.

import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { argon2id } from '@noble/hashes/argon2';
import { parse as uuidParse } from 'uuid';

export const AAD_VERSION = 0x01;

export function buildAad(args: { userId: string; fileId: string; versionId: string; keyId: string }): Uint8Array {
  const out = new Uint8Array(65);
  out[0] = AAD_VERSION;
  out.set(uuidParse(args.userId), 1);
  out.set(uuidParse(args.fileId), 17);
  out.set(uuidParse(args.versionId), 33);
  out.set(uuidParse(args.keyId), 49);
  return out;
}

// libsodium's `crypto_pwhash_OPSLIMIT_INTERACTIVE` = 2 ops; MEMLIMIT_INTERACTIVE = 64 MiB.
// MUST match the server/CLI parameters so the same passphrase derives the same key.
export function deriveVaultKey(passphrase: string, saltB64: string): Uint8Array {
  const salt = b64urlToBytes(saltB64).slice(0, 16);
  if (salt.length < 16) throw new Error('kdf_salt too short');
  return argon2id(passphrase, salt, { t: 2, m: 65536, p: 1, dkLen: 32, version: 0x13 });
}

export function aeadDecrypt(args: {
  key: Uint8Array; ciphertext: Uint8Array; nonce: Uint8Array;
  userId: string; fileId: string; versionId: string; keyId: string;
}): Uint8Array {
  const aad = buildAad(args);
  return xchacha20poly1305(args.key, args.nonce, aad).decrypt(args.ciphertext);
}

export function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBlob(b: Uint8Array, mime = 'application/octet-stream'): Blob {
  return new Blob([b as BlobPart], { type: mime });
}