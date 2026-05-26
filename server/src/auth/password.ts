import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer, salt: string | Buffer, keylen: number, options?: { N?: number; r?: number; p?: number; maxmem?: number }
) => Promise<Buffer>;

// OWASP 2025: scrypt N=2^17, r=8, p=1 is interactive-acceptable on a modern server.
const N = 1 << 17;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MIN_PASSWORD_LEN = 12;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LEN) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parts = hash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  try {
    const got = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: 256 * 1024 * 1024 });
    if (got.length !== expected.length) return false;
    return timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

export const MIN_PASSWORD_LENGTH = MIN_PASSWORD_LEN;
