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
  for (const seg of input.split('/')) {
    if (seg === '..' || seg === '.') throw new PathError('traversal segment');
    if (seg.length === 0) throw new PathError('empty segment');
  }
  const nfc = input.normalize('NFC');
  if (nfc !== input) throw new PathError('not NFC');
  return nfc;
}
