import { createRequire } from 'node:module';

// libsodium-wrappers ESM build is broken at 0.7.16; use CJS via createRequire.
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers-sumo') as typeof import('libsodium-wrappers-sumo');

let ready = false;
async function ensureReady(): Promise<void> {
  if (!ready) { await sodium.ready; ready = true; }
}

// Content hash used to skip unchanged files on push. Client-only; never sent to the server.
export async function blake2b(data: Buffer): Promise<Buffer> {
  await ensureReady();
  return Buffer.from(sodium.crypto_generichash(32, data));
}
