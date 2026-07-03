import { resolve, sep } from 'node:path';

// Client-side port of server/src/lib/path-canon.ts. The server canonicalizes paths on
// upload, but the pull path is server-controlled and the path is NOT bound by any
// integrity check, so a malicious/compromised server could hand back a `path` like
// `../../../.ssh/authorized_keys`. We MUST re-validate every path here before joining
// it onto syncRoot, and additionally verify the resolved path stays inside syncRoot.

export class PathError extends Error {
  constructor(public reason: string) { super(`invalid path: ${reason}`); this.name = 'PathError'; }
}

const MAX_LEN = 1024;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/;

export function canonicalizePath(input: string): string {
  if (typeof input !== 'string') throw new PathError('not a string');
  if (input.length === 0) throw new PathError('empty');
  if (input.length > MAX_LEN) throw new PathError('too long');
  if (CONTROL_RE.test(input)) throw new PathError('control char');
  if (input.includes('\\')) throw new PathError('backslash');
  if (input.startsWith('/')) throw new PathError('absolute');
  for (const segment of input.split('/')) {
    if (segment === '..' || segment === '.') throw new PathError('traversal segment');
    if (segment.length === 0) throw new PathError('empty segment');
  }
  const nfc = input.normalize('NFC');
  if (nfc !== input) throw new PathError('not NFC');
  return nfc;
}

// Canonicalize `relPath`, join it under `syncRoot`, and confirm the fully-resolved
// absolute path is contained within the resolved syncRoot. Returns the safe absolute
// path or throws PathError. This is defense-in-depth on top of canonicalizePath:
// even if the segment checks were somehow bypassed, the prefix check below catches
// any escape outside the root.
export function resolveWithinRoot(syncRoot: string, relPath: string): string {
  const canon = canonicalizePath(relPath);
  const rootResolved = resolve(syncRoot);
  const abs = resolve(rootResolved, canon);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
    throw new PathError('escapes syncRoot');
  }
  return abs;
}
