import { describe, it, expect, afterEach } from 'vitest';
import { makeApp, getCookie } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance | undefined;
afterEach(async () => { if (app) await app.close(); app = undefined; });

const STRONG = 'correct-horse-battery-staple-9!';
const NEW_PASSWORD = 'a-brand-new-password-42!';

async function signup(_app: FastifyInstance, email: string, password = STRONG): Promise<void> {
  const r = await _app.inject({
    method: 'POST', url: '/auth/signup',
    headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password }),
  });
  expect(r.statusCode).toBe(200);
}

function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get('token')!;
}

describe('password reset', () => {
  it('request returns the reset url in dev/test for an existing account', async () => {
    const built = await makeApp();
    app = built.app;
    await signup(app, 'reset-me@example.com');

    const r = await app.inject({
      method: 'POST', url: '/auth/reset/request',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'reset-me@example.com' }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
    expect(r.json().reset_url).toContain('/reset.html?token=');
  });

  it('request for an unknown email still returns 200 with no url (no enumeration oracle)', async () => {
    const built = await makeApp();
    app = built.app;
    const r = await app.inject({
      method: 'POST', url: '/auth/reset/request',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'nobody@example.com' }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
    expect(r.json().reset_url).toBeUndefined();
  });

  it('confirm sets the new password: old fails, new logs in', async () => {
    const built = await makeApp();
    app = built.app;
    await signup(app, 'flow@example.com');

    const req = await app.inject({
      method: 'POST', url: '/auth/reset/request',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'flow@example.com' }),
    });
    const token = tokenFromUrl(req.json().reset_url);

    const confirm = await app.inject({
      method: 'POST', url: '/auth/reset/confirm',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ token, password: NEW_PASSWORD }),
    });
    expect(confirm.statusCode).toBe(200);

    // Old password no longer works.
    const oldLogin = await app.inject({
      method: 'POST', url: '/auth/login',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'flow@example.com', password: STRONG }),
    });
    expect(oldLogin.statusCode).toBe(401);

    // New password works.
    const newLogin = await app.inject({
      method: 'POST', url: '/auth/login',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'flow@example.com', password: NEW_PASSWORD }),
    });
    expect(newLogin.statusCode).toBe(200);
    expect(getCookie(newLogin.headers['set-cookie'], '__Host-session')).toBeTruthy();
  });

  it('a token cannot be used twice', async () => {
    const built = await makeApp();
    app = built.app;
    await signup(app, 'twice@example.com');
    const req = await app.inject({
      method: 'POST', url: '/auth/reset/request',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'twice@example.com' }),
    });
    const token = tokenFromUrl(req.json().reset_url);

    const first = await app.inject({
      method: 'POST', url: '/auth/reset/confirm',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ token, password: NEW_PASSWORD }),
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST', url: '/auth/reset/confirm',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ token, password: 'yet-another-password-77!' }),
    });
    expect(second.statusCode).toBe(400);
  });

  it('rejects an unknown token with 400', async () => {
    const built = await makeApp();
    app = built.app;
    const r = await app.inject({
      method: 'POST', url: '/auth/reset/confirm',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ token: 'not-a-real-token', password: NEW_PASSWORD }),
    });
    expect(r.statusCode).toBe(400);
  });

  it('rejects a weak new password with 400', async () => {
    const built = await makeApp();
    app = built.app;
    await signup(app, 'weak@example.com');
    const req = await app.inject({
      method: 'POST', url: '/auth/reset/request',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'weak@example.com' }),
    });
    const token = tokenFromUrl(req.json().reset_url);
    const r = await app.inject({
      method: 'POST', url: '/auth/reset/confirm',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ token, password: 'short' }),
    });
    expect(r.statusCode).toBe(400);
  });
});
