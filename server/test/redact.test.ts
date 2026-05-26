import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { REDACT_PATHS } from '../src/lib/redact.js';

describe('redactor', () => {
  it('redacts ciphertext, nonce, cookie, authorization, X-Path from logs', () => {
    const lines: string[] = [];
    const stream = { write: (chunk: string) => { lines.push(chunk); return true; } };
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, stream as never);

    log.info({
      req: {
        headers: {
          cookie: 'session=BIG_SECRET_COOKIE',
          authorization: 'Bearer BIG_SECRET_BEARER_TOKEN',
          'x-nonce': 'BIG_SECRET_NONCE',
          'x-path': 'skills/secret/SKILL.md',
        },
      },
      ciphertext: 'BIG_SECRET_BLOB',
      nonce: 'BIG_SECRET_NONCE_2',
    }, 'test');

    const all = lines.join('\n');
    expect(all).not.toContain('BIG_SECRET');
    expect(all).not.toContain('Bearer ');
    expect(all).not.toContain('skills/secret');
    expect(all).toContain('[redacted]');
  });
});
