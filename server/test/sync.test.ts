import { describe, it, expect, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { makeApp, getCookie } from './helpers.js';
import { makeKey, encrypt, newFileId, newVersionId } from './fixtures.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance | undefined;
afterEach(async () => { if (app) await app.close(); app = undefined; });

async function bootstrap(_app: FastifyInstance) {
  const init = await _app.inject({ method: 'GET', url: '/auth/github' });
  const oc = getCookie(init.headers['set-cookie'], '__Secure-oauth-state');
  const state = /state=([^&]+)/.exec(init.headers['location'] as string)![1];
  const cb = await _app.inject({
    method: 'GET', url: `/auth/github/callback?code=foo&state=${state}`,
    cookies: { '__Secure-oauth-state': oc! },
  });
  const session = getCookie(cb.headers['set-cookie'], '__Host-session')!;
  const dev = await _app.inject({
    method: 'POST', url: '/api/devices',
    cookies: { '__Host-session': session },
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
  return { session, userId: me.json().user.id, keyId, deviceId: dev.json().device.id };
}

async function uploadOne(app: FastifyInstance, ctx: { session: string; userId: string; keyId: string }, fileId: string) {
  const key = await makeKey();
  const versionId = newVersionId();
  const { ciphertext, nonce } = await encrypt({
    key, plaintext: Buffer.from('x'),
    userId: ctx.userId, fileId, versionId, keyId: ctx.keyId,
  });
  await app.inject({
    method: 'PUT', url: `/api/files/${fileId}/versions/${versionId}`,
    cookies: { '__Host-session': ctx.session },
    headers: {
      'x-requested-with': 'claude-sync', 'content-type': 'application/octet-stream',
      'x-nonce': nonce.toString('base64url'), 'x-key-id': ctx.keyId,
    },
    payload: ciphertext,
  });
  return versionId;
}

describe('GET /api/sync', () => {
  it('returns monotonically increasing seq', async () => {
    const built = await makeApp();
    app = built.app;
    const ctx = await bootstrap(app);
    const f1 = newFileId(), f2 = newFileId(), f3 = newFileId();
    await uploadOne(app, ctx, f1);
    await uploadOne(app, ctx, f2);
    await uploadOne(app, ctx, f3);

    const r = await app.inject({ method: 'GET', url: '/api/sync?since=0', cookies: { '__Host-session': ctx.session } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.changes.length).toBe(3);
    expect(body.changes[0].seq).toBeLessThan(body.changes[1].seq);
    expect(body.changes[1].seq).toBeLessThan(body.changes[2].seq);
    expect(body.has_more).toBe(false);
  });

  it('since=last returns empty', async () => {
    const built = await makeApp();
    app = built.app;
    const ctx = await bootstrap(app);
    await uploadOne(app, ctx, newFileId());
    const r1 = await app.inject({ method: 'GET', url: '/api/sync?since=0', cookies: { '__Host-session': ctx.session } });
    const last = r1.json().next_seq;
    const r2 = await app.inject({ method: 'GET', url: `/api/sync?since=${last}`, cookies: { '__Host-session': ctx.session } });
    expect(r2.json().changes).toHaveLength(0);
  });

  it('limit paging works (has_more true)', async () => {
    const built = await makeApp();
    app = built.app;
    const ctx = await bootstrap(app);
    for (let i = 0; i < 5; i++) await uploadOne(app, ctx, newFileId());
    const r = await app.inject({ method: 'GET', url: '/api/sync?since=0&limit=3', cookies: { '__Host-session': ctx.session } });
    const body = r.json();
    expect(body.changes).toHaveLength(3);
    expect(body.has_more).toBe(true);
  });
});
