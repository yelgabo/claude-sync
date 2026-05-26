import { describe, it, expect } from 'vitest';
import { buildAad, AAD_VERSION, AAD_LENGTH } from '../src/lib/aad.js';

describe('buildAad', () => {
  const base = {
    userId: '00000000-0000-4000-8000-000000000001',
    fileId: '00000000-0000-7000-8000-000000000002',
    versionId: '00000000-0000-4000-8000-000000000003',
    keyId: '00000000-0000-4000-8000-000000000004',
  };

  it('produces exactly 65 bytes', () => {
    const aad = buildAad(base);
    expect(aad.length).toBe(AAD_LENGTH);
    expect(aad.length).toBe(65);
  });

  it('first byte is the version constant 0x01', () => {
    const aad = buildAad(base);
    expect(aad[0]).toBe(AAD_VERSION);
    expect(aad[0]).toBe(0x01);
  });

  it('byte-for-byte fixture: known UUIDs map to known AAD', () => {
    const aad = buildAad({
      userId:    '12345678-90ab-4cde-8f01-234567890abc',
      fileId:    'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
      versionId: '11111111-2222-4333-8444-555555555555',
      keyId:     '99999999-8888-4777-8666-555555555555',
    });
    expect(aad[0]).toBe(1);
    expect(aad.subarray(1, 17).toString('hex')).toBe('1234567890ab4cde8f01234567890abc');
    expect(aad.subarray(17, 33).toString('hex')).toBe('aaaaaaaabbbb7ccc8dddeeeeeeeeeeee');
    expect(aad.subarray(33, 49).toString('hex')).toBe('11111111222243338444555555555555');
    expect(aad.subarray(49, 65).toString('hex')).toBe('99999999888847778666555555555555');
  });

  it('changing any field changes the AAD', () => {
    const a = buildAad(base).toString('hex');
    expect(buildAad({ ...base, userId: '00000000-0000-4000-8000-000000000009' }).toString('hex')).not.toBe(a);
    expect(buildAad({ ...base, fileId: '00000000-0000-7000-8000-00000000000a' }).toString('hex')).not.toBe(a);
    expect(buildAad({ ...base, versionId: '00000000-0000-4000-8000-00000000000b' }).toString('hex')).not.toBe(a);
    expect(buildAad({ ...base, keyId: '00000000-0000-4000-8000-00000000000c' }).toString('hex')).not.toBe(a);
  });
});
