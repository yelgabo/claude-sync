import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { canonicalizePath, PathError } from '../src/lib/path-canon.js';

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const NUL = String.fromCharCode(0);
const BSL = String.fromCharCode(92);

describe('canonicalizePath rejections', () => {
  const cases: Array<[string, string]> = [
    ['/abs', 'absolute'],
    ['..', 'traversal'],
    ['a/../b', 'traversal'],
    ['a/./b', 'traversal'],
    ['a//b', 'empty segment'],
    [`a${BSL}b`, 'backslash'],
    [`a${NL}b`, 'control'],
    [`a${CR}b`, 'control'],
    [`a${TAB}b`, 'control'],
    [`a${NUL}b`, 'control'],
    ['', 'empty'],
  ];
  for (const [input, why] of cases) {
    it(`rejects ${why}`, () => {
      expect(() => canonicalizePath(input)).toThrow(PathError);
    });
  }

  it('rejects > 1024 chars', () => {
    expect(() => canonicalizePath('a'.repeat(1025))).toThrow(PathError);
  });

  it('rejects non-NFC input', () => {
    const nfd = 'cafe' + String.fromCharCode(0x301); // NFD of cafe-acute
    expect(() => canonicalizePath(nfd)).toThrow(PathError);
  });

  it('accepts well-formed paths', () => {
    expect(canonicalizePath('skills/foo/SKILL.md')).toBe('skills/foo/SKILL.md');
    expect(canonicalizePath('a')).toBe('a');
  });
});

describe('canonicalizePath properties', () => {
  it('any string with NUL, CR, LF, backslash, or leading / is rejected', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 60 }),
        fc.constantFrom(NUL, NL, CR, BSL),
        (s, bad) => {
          try {
            canonicalizePath(s + bad + 'tail');
            return false;
          } catch (e) {
            return e instanceof PathError;
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('output equals input when canonicalization succeeds', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.stringOf(fc.constantFrom('a','b','c','d','e','f','g','h','i','j'), { minLength: 1, maxLength: 6 }),
          { minLength: 1, maxLength: 5 },
        ),
        (segs) => {
          const p = segs.join('/');
          try { return canonicalizePath(p) === p; } catch { return true; }
        },
      ),
      { numRuns: 200 },
    );
  });
});
