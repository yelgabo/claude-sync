import { describe, it, expect, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildApp } from '../src/index.js';
import { makeApp, getCookie, TEST_ENV } from './helpers.js';
import { newPGlite, newTestDb } from './setup.js';
import { makeKey, encrypt, newFileId, newVersionId } from './fixtures.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance | undefined;
let app2: FastifyInstance | undefined;
afterEach(async () => {
  if (app) await app.close(); app = undefined;
  if (app2) await app2.close(); app2 = undefined;
});

async function bootstrap(_app: FastifyInstance) {
  const init = await _app.inject({ method: 'GET', url: '/auth/github' });
  const oc = getCookie(init.headers['set-cookie'], '__Secure-oauth-state');
  const state = /state=([^&]+)/.exec(init.headers['location'] as string)![1];
  const cb = await _app.inject({
    method: 'GET', url: `/auth/github/callback?code=foo&state=${state}`,
    cookies: { '__Secure-oauth-state': oc! },
  });
  const session = getCookie(cb.headers['set-cookie'], '__Host-session')!;
  await _app.inject({
    method: 'POST', url: '/api/devices', cookies: { '__Host-session': session },
    headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'd' }),
  });
  const keyId = uuidv4();
  const salt = Buffer.alloc(16, 0xab).toString('base64url');
  await _app.inject({
    method: 'PUT', url: '/api/vault/key-metadata',
    cookies: { '__Host-session': session },
    headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
    payload: JSON.stringify({ kdf_algo: 'argon2id', kdf_salt_b64: salt, key_id: keyId }),
  });
  const me = await _app.inject({ method: 'GET', url: '/api/me', cookies: { '__Host-session': session } });
  return { session, userId: me.json().user.id, keyId };
}

describe('healthz', () => {
  it('returns { ok: true, db: "up" } shape', async () => {
    const built = await makeApp();
    app = built.app;
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, db: 'up' });
  });
});

describe('quota', () => {
  it('rejects PUT that exceeds quota with 507; seq does not advance', async () => {
    // Quota = 1000 bytes; each upload ciphertext = 100 + 16 (AEAD tag) = 116 bytes.
    // Eight uploads = 928 bytes, ninth (1044) exceeds 1000.
    const built = await makeApp({ id: 7, email: 'q@q' }, { STORAGE_QUOTA_BYTES: 1000 });
    app = built.app;
    const ctx = await bootstrap(app);
    const key = await makeKey();
    const plaintext = Buffer.alloc(100, 0x42);

    for (let i = 0; i < 8; i++) {
      const fid = newFileId();
      const vid = newVersionId();
      const enc = await encrypt({ key, plaintext, userId: ctx.userId, fileId: fid, versionId: vid, keyId: ctx.keyId });
      const ok = await app.inject({
        method: 'PUT', url: `/api/files/${fid}/versions/${vid}`,
        cookies: { '__Host-session': ctx.session },
        headers: {
          'x-requested-with': 'claude-sync', 'content-type': 'application/octet-stream',
          'x-nonce': enc.nonce.toString('base64url'), 'x-key-id': ctx.keyId,
        },
        payload: enc.ciphertext,
      });
      expect(ok.statusCode).toBe(200);
    }

    // Ninth exceeds → 507
    const fid = newFileId();
    const vid = newVersionId();
    const enc = await encrypt({ key, plaintext, userId: ctx.userId, fileId: fid, versionId: vid, keyId: ctx.keyId });
    const r = await app.inject({
      method: 'PUT', url: `/api/files/${fid}/versions/${vid}`,
      cookies: { '__Host-session': ctx.session },
      headers: {
        'x-requested-with': 'claude-sync', 'content-type': 'application/octet-stream',
        'x-nonce': enc.nonce.toString('base64url'), 'x-key-id': ctx.keyId,
      },
      payload: enc.ciphertext,
    });
    expect(r.statusCode).toBe(507);

    // Sync feed: only 8 versions made it, seq strictly monotonic with no gap
    const sync = await app.inject({ method: 'GET', url: '/api/sync?since=0&limit=500', cookies: { '__Host-session': ctx.session } });
    const body = sync.json();
    expect(body.changes.length).toBe(8);
    for (let i = 0; i < body.changes.length - 1; i++) {
      expect(body.changes[i + 1].seq).toBe(body.changes[i].seq + 1);
    }
  });
});

describe('revoked session is rejected', () => {
  it('revoked session id cannot be reused', async () => {
    const built = await makeApp({ id: 8, email: 'r@r' });
    app = built.app;
    const ctx = await bootstrap(app);

    // Revoke via logout
    await app.inject({
      method: 'POST', url: '/auth/logout',
      cookies: { '__Host-session': ctx.session },
      headers: { 'x-requested-with': 'claude-sync' },
    });

    // Attempt to reuse same session id
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { '__Host-session': ctx.session } });
    expect(me.statusCode).toBe(401);
  });
});

describe('versions list endpoint', () => {
  it('returns versions ordered by seq DESC', async () => {
    const built = await makeApp({ id: 9, email: 'v@v' });
    app = built.app;
    const ctx = await bootstrap(app);
    const key = await makeKey();
    const fileId = newFileId();
    const v1 = newVersionId(), v2 = newVersionId();
    for (const vid of [v1, v2]) {
      const e = await encrypt({ key, plaintext: Buffer.from('x'), userId: ctx.userId, fileId, versionId: vid, keyId: ctx.keyId });
      await app.inject({
        method: 'PUT', url: `/api/files/${fileId}/versions/${vid}`,
        cookies: { '__Host-session': ctx.session },
        headers: {
          'x-requested-with': 'claude-sync', 'content-type': 'application/octet-stream',
          'x-nonce': e.nonce.toString('base64url'), 'x-key-id': ctx.keyId,
        },
        payload: e.ciphertext,
      });
    }
    const r = await app.inject({ method: 'GET', url: `/api/files/${fileId}/versions`, cookies: { '__Host-session': ctx.session } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0].seq).toBeGreaterThan(body.versions[1].seq);
  });
});

describe('cross-user isolation (same DB)', () => {
  it('user B cannot read user A files via fileId or version_id (uniform 404)', async () => {
    // One pglite, two app instances, two GitHub users
    const pg = await newPGlite();
    const db1 = await newTestDb(pg);
    const db2 = await newTestDb(pg);

    const built1 = await buildApp({
      env: TEST_ENV, db: db1, skipMigrations: true, disableRateLimit: true,
      githubDeps: {
        exchangeCodeForToken: async () => 'token',
        fetchGitHubUser: async () => ({ id: 1001, email: 'a@a' }),
      },
    });
    const built2 = await buildApp({
      env: TEST_ENV, db: db2, skipMigrations: true, disableRateLimit: true,
      githubDeps: {
        exchangeCodeForToken: async () => 'token',
        fetchGitHubUser: async () => ({ id: 2002, email: 'b@b' }),
      },
    });
    app = built1.app; app2 = built2.app;

    const A = await bootstrap(app);
    const B = await bootstrap(app2);
    expect(A.userId).not.toBe(B.userId);

    const keyA = await makeKey();
    const fileId = newFileId();
    const versionId = newVersionId();
    const eA = await encrypt({ key: keyA, plaintext: Buffer.from('secret'), userId: A.userId, fileId, versionId, keyId: A.keyId });
    const putA = await app.inject({
      method: 'PUT', url: `/api/files/${fileId}/versions/${versionId}`,
      cookies: { '__Host-session': A.session },
      headers: {
        'x-requested-with': 'claude-sync', 'content-type': 'application/octet-stream',
        'x-nonce': eA.nonce.toString('base64url'), 'x-key-id': A.keyId,
      },
      payload: eA.ciphertext,
    });
    expect(putA.statusCode).toBe(200);

    // B (sharing the same DB) tries to read A's file_id and version_id directly — uniform 404
    const getB = await app2.inject({
      method: 'GET', url: `/api/files/${fileId}`,
      cookies: { '__Host-session': B.session },
    });
    expect(getB.statusCode).toBe(404);

    const verB = await app2.inject({
      method: 'GET', url: `/api/files/${fileId}/versions/${versionId}`,
      cookies: { '__Host-session': B.session },
    });
    expect(verB.statusCode).toBe(404);

    // B tries to overwrite A's file_id via PUT — also uniform 404
    const eB = await encrypt({ key: await makeKey(), plaintext: Buffer.from('attack'), userId: B.userId, fileId, versionId: newVersionId(), keyId: B.keyId });
    const putB = await app2.inject({
      method: 'PUT', url: `/api/files/${fileId}/versions/${newVersionId()}`,
      cookies: { '__Host-session': B.session },
      headers: {
        'x-requested-with': 'claude-sync', 'content-type': 'application/octet-stream',
        'x-nonce': eB.nonce.toString('base64url'), 'x-key-id': B.keyId,
      },
      payload: eB.ciphertext,
    });
    expect(putB.statusCode).toBe(404);

    // Sync feed for B sees nothing
    const syncB = await app2.inject({ method: 'GET', url: '/api/sync?since=0', cookies: { '__Host-session': B.session } });
    expect(syncB.json().changes).toHaveLength(0);

    // Cleanup: buildApp skips db.end() when db is injected (see index.ts onClose), so
    // neither app.close() will close pglite. Close it explicitly here.
    await app2.close(); app2 = undefined;
    await app.close(); app = undefined;
    await pg.close();
  });
});

describe('tombstone clears files.path', () => {
  it('DELETE then PUT of different file_id with same path succeeds (path slot freed)', async () => {
    const built = await makeApp({ id: 20, email: 't@t' });
    app = built.app;
    const ctx = await bootstrap(app);
    const key = await makeKey();
    const fileA = newFileId(); const verA = newVersionId();
    const eA = await encrypt({ key, plaintext: Buffer.from('a'), userId: ctx.userId, fileId: fileA, versionId: verA, keyId: ctx.keyId });
    await app.inject({
      method: 'PUT', url: `/api/files/${fileA}/versions/${verA}`,
      cookies: { '__Host-session': ctx.session },
      headers: {
        'x-requested-with': 'claude-sync', 'content-type': 'application/octet-stream',
        'x-nonce': eA.nonce.toString('base64url'), 'x-key-id': ctx.keyId, 'x-path': 'foo/bar.txt',
      },
      payload: eA.ciphertext,
    });

    // Tombstone fileA
    const tombVer = newVersionId();
    const tomb = await encrypt({ key, plaintext: Buffer.alloc(0), userId: ctx.userId, fileId: fileA, versionId: tombVer, keyId: ctx.keyId });
    const del = await app.inject({
      method: 'DELETE', url: `/api/files/${fileA}/versions/${tombVer}`,
      cookies: { '__Host-session': ctx.session },
      headers: {
        'x-requested-with': 'claude-sync', 'content-type': 'application/octet-stream',
        'x-nonce': tomb.nonce.toString('base64url'), 'x-key-id': ctx.keyId,
      },
      payload: tomb.ciphertext,
    });
    expect(del.statusCode).toBe(200);

    // Create a new file_id with the same path — should succeed
    const fileB = newFileId(); const verB = newVersionId();
    const eB = await encrypt({ key, plaintext: Buffer.from('b'), userId: ctx.userId, fileId: fileB, versionId: verB, keyId: ctx.keyId });
    const putB = await app.inject({
      method: 'PUT', url: `/api/files/${fileB}/versions/${verB}`,
      cookies: { '__Host-session': ctx.session },
      headers: {
        'x-requested-with': 'claude-sync', 'content-type': 'application/octet-stream',
        'x-nonce': eB.nonce.toString('base64url'), 'x-key-id': ctx.keyId, 'x-path': 'foo/bar.txt',
      },
      payload: eB.ciphertext,
    });
    expect(putB.statusCode).toBe(200);
  });
});


