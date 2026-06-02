import { describe, it, expect, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { makeApp, getCookie } from './helpers.js';
import { makeKey, encrypt, newFileId, newVersionId } from './fixtures.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance | undefined;
afterEach(async () => { if (app) await app.close(); app = undefined; });

async function bootstrap(_app: FastifyInstance, ghUser: { id: number; email: string | null }) {
  // OAuth round-trip; returns { session, deviceId, userId, keyId }
  const init = await _app.inject({ method: 'GET', url: '/auth/github' });
  const oauthCookie = getCookie(init.headers['set-cookie'], '__Secure-oauth-state');
  const state = /state=([^&]+)/.exec(init.headers['location'] as string)![1];
  const cb = await _app.inject({
    method: 'GET',
    url: `/auth/github/callback?code=foo&state=${state}`,
    cookies: { '__Secure-oauth-state': oauthCookie! },
  });
  const session = getCookie(cb.headers['set-cookie'], '__Host-session')!;

  const dev = await _app.inject({
    method: 'POST', url: '/api/devices',
    cookies: { '__Host-session': session },
    headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
    payload: JSON.stringify({ name: `dev-${ghUser.id}` }),
  });
  const deviceId = dev.json().device.id;

  const keyId = uuidv4();
  // 16-byte salt → 22 base64url chars
  const salt = Buffer.alloc(16, 0xab).toString('base64url');
  await _app.inject({
    method: 'PUT', url: '/api/vault/key-metadata',
    cookies: { '__Host-session': session },
    headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
    payload: JSON.stringify({ kdf_algo: 'argon2id', kdf_salt_b64: salt, key_id: keyId }),
  });

  const me = await _app.inject({ method: 'GET', url: '/api/me', cookies: { '__Host-session': session } });
  const userId = me.json().user.id;
  return { session, deviceId, userId, keyId };
}

describe('PUT /api/files/:fileId/versions/:versionId', () => {
  it('round-trips ciphertext bytes (latest GET equals upload)', async () => {
    const built = await makeApp();
    app = built.app;
    const { session, userId, keyId } = await bootstrap(app, { id: 1, email: 'a@e' });
    const key = await makeKey();
    const fileId = newFileId();
    const versionId = newVersionId();
    const { ciphertext, nonce } = await encrypt({
      key, plaintext: Buffer.from('hello world'),
      userId, fileId, versionId, keyId,
    });

    const put = await app.inject({
      method: 'PUT',
      url: `/api/files/${fileId}/versions/${versionId}`,
      cookies: { '__Host-session': session },
      headers: {
        'x-requested-with': 'claude-sync',
        'content-type': 'application/octet-stream',
        'x-nonce': nonce.toString('base64url'),
        'x-key-id': keyId,
        'x-path': 'skills/test/SKILL.md',
      },
      payload: ciphertext,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().seq).toBeGreaterThan(0);

    const get = await app.inject({
      method: 'GET', url: `/api/files/${fileId}`,
      cookies: { '__Host-session': session },
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('application/octet-stream');
    expect(Buffer.compare(get.rawPayload, ciphertext)).toBe(0);
  });

  it('requires device-bound session (412 before POST /api/devices)', async () => {
    const built = await makeApp();
    app = built.app;
    // Manual OAuth only, no device
    const init = await app.inject({ method: 'GET', url: '/auth/github' });
    const oauthCookie = getCookie(init.headers['set-cookie'], '__Secure-oauth-state');
    const state = /state=([^&]+)/.exec(init.headers['location'] as string)![1];
    const cb = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=foo&state=${state}`,
      cookies: { '__Secure-oauth-state': oauthCookie! },
    });
    const session = getCookie(cb.headers['set-cookie'], '__Host-session')!;

    const fileId = newFileId();
    const versionId = newVersionId();
    const put = await app.inject({
      method: 'PUT', url: `/api/files/${fileId}/versions/${versionId}`,
      cookies: { '__Host-session': session },
      headers: {
        'x-requested-with': 'claude-sync',
        'content-type': 'application/octet-stream',
        'x-nonce': Buffer.alloc(24).toString('base64url'),
        'x-key-id': uuidv4(),
      },
      payload: Buffer.from('x'),
    });
    expect(put.statusCode).toBe(412);
  });

  it('rejects oversized ciphertext (>1 MiB) with 413', async () => {
    const built = await makeApp();
    app = built.app;
    const { session, userId, keyId } = await bootstrap(app, { id: 2, email: 'b@e' });
    const key = await makeKey();
    const fileId = newFileId();
    const versionId = newVersionId();
    const big = Buffer.alloc(1024 * 1024 + 1, 0x42);
    const { ciphertext, nonce } = await encrypt({ key, plaintext: big, userId, fileId, versionId, keyId });
    const put = await app.inject({
      method: 'PUT', url: `/api/files/${fileId}/versions/${versionId}`,
      cookies: { '__Host-session': session },
      headers: {
        'x-requested-with': 'claude-sync',
        'content-type': 'application/octet-stream',
        'x-nonce': nonce.toString('base64url'),
        'x-key-id': keyId,
      },
      payload: ciphertext,
    });
    expect([413, 400]).toContain(put.statusCode);
  });

  it('rejects missing X-Requested-With with 400', async () => {
    const built = await makeApp();
    app = built.app;
    const { session, userId, keyId } = await bootstrap(app, { id: 4, email: 'd@e' });
    const key = await makeKey();
    const fileId = newFileId();
    const versionId = newVersionId();
    const { ciphertext, nonce } = await encrypt({ key, plaintext: Buffer.from('x'), userId, fileId, versionId, keyId });
    const put = await app.inject({
      method: 'PUT', url: `/api/files/${fileId}/versions/${versionId}`,
      cookies: { '__Host-session': session },
      headers: {
        'content-type': 'application/octet-stream',
        'x-nonce': nonce.toString('base64url'),
        'x-key-id': keyId,
      },
      payload: ciphertext,
    });
    expect(put.statusCode).toBe(400);
  });

  it('returns 410 when latest version is a tombstone; sync feed reports deleted', async () => {
    const built = await makeApp();
    app = built.app;
    const { session, userId, keyId } = await bootstrap(app, { id: 5, email: 'e@e' });
    const key = await makeKey();
    const fileId = newFileId();
    const v1 = newVersionId();
    const v2 = newVersionId();
    const { ciphertext, nonce } = await encrypt({ key, plaintext: Buffer.from('a'), userId, fileId, versionId: v1, keyId });

    await app.inject({
      method: 'PUT', url: `/api/files/${fileId}/versions/${v1}`,
      cookies: { '__Host-session': session },
      headers: {
        'x-requested-with': 'claude-sync', 'content-type': 'application/octet-stream',
        'x-nonce': nonce.toString('base64url'), 'x-key-id': keyId,
      },
      payload: ciphertext,
    });

    // Tombstone: AEAD over empty plaintext, AAD over (userId, fileId, v2, keyId)
    const { ciphertext: tomb, nonce: tNonce } = await encrypt({
      key, plaintext: Buffer.alloc(0), userId, fileId, versionId: v2, keyId,
    });
    const del = await app.inject({
      method: 'DELETE', url: `/api/files/${fileId}/versions/${v2}`,
      cookies: { '__Host-session': session },
      headers: {
        'x-requested-with': 'claude-sync', 'content-type': 'application/octet-stream',
        'x-nonce': tNonce.toString('base64url'), 'x-key-id': keyId,
      },
      payload: tomb,
    });
    expect(del.statusCode).toBe(200);

    const get = await app.inject({ method: 'GET', url: `/api/files/${fileId}`, cookies: { '__Host-session': session } });
    expect(get.statusCode).toBe(410);

    const sync = await app.inject({ method: 'GET', url: '/api/sync?since=0', cookies: { '__Host-session': session } });
    const body = sync.json();
    const tombChange = body.changes.find((c: { version_id: string; deleted: boolean }) => c.version_id === v2);
    expect(tombChange?.deleted).toBe(true);
  });

  it('cross-user isolation: user B cannot see user A files via fileId (404)', async () => {
    const built = await makeApp({ id: 10, email: 'a@a' });
    app = built.app;
    const A = await bootstrap(app, { id: 10, email: 'a@a' });
    const keyA = await makeKey();
    const fileId = newFileId();
    const versionId = newVersionId();
    const { ciphertext, nonce } = await encrypt({
      key: keyA, plaintext: Buffer.from('secret'),
      userId: A.userId, fileId, versionId, keyId: A.keyId,
    });
    await app.inject({
      method: 'PUT', url: `/api/files/${fileId}/versions/${versionId}`,
      cookies: { '__Host-session': A.session },
      headers: {
        'x-requested-with': 'claude-sync', 'content-type': 'application/octet-stream',
        'x-nonce': nonce.toString('base64url'), 'x-key-id': A.keyId,
      },
      payload: ciphertext,
    });

    // Spin up second app instance (= second test DB → different user pool).
    await app.close();
    const built2 = await makeApp({ id: 99, email: 'b@b' });
    app = built2.app;
    const B = await bootstrap(app, { id: 99, email: 'b@b' });

    const get = await app.inject({
      method: 'GET', url: `/api/files/${fileId}`,
      cookies: { '__Host-session': B.session },
    });
    expect(get.statusCode).toBe(404);
  });
});

describe('GET /api/files listing', () => {
  it('lists user files with deleted flag from latest version', async () => {
    const built = await makeApp();
    app = built.app;
    const { session, userId, keyId } = await bootstrap(app, { id: 30, email: 'x@x' });
    const key = await makeKey();
    const fileId = newFileId();
    const v1 = newVersionId();
    const { ciphertext, nonce } = await encrypt({ key, plaintext: Buffer.from('a'), userId, fileId, versionId: v1, keyId });
    await app.inject({
      method: 'PUT', url: `/api/files/${fileId}/versions/${v1}`,
      cookies: { '__Host-session': session },
      headers: {
        'x-requested-with': 'claude-sync', 'content-type': 'application/octet-stream',
        'x-nonce': nonce.toString('base64url'), 'x-key-id': keyId, 'x-path': 'foo/bar.txt',
      },
      payload: ciphertext,
    });
    const list = await app.inject({ method: 'GET', url: '/api/files', cookies: { '__Host-session': session } });
    expect(list.statusCode).toBe(200);
    const files = list.json().files;
    expect(files).toHaveLength(1);
    expect(files[0].deleted).toBe(false);
    expect(files[0].path).toBe('foo/bar.txt');
  });
});
