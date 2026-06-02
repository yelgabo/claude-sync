// Browser-side helpers. File content is plaintext; no decryption needed.

export function bytesToBlob(b: Uint8Array, mime = 'application/octet-stream'): Blob {
  return new Blob([b as BlobPart], { type: mime });
}
