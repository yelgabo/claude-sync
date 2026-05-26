import { describe, it, expect, afterEach } from 'vitest';
import { makeApp, getCookie } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance | undefined;
afterEach(async () => { if (app) await app.close(); app = undefined; });

const STRONG = 'correct-horse-battery-staple-9!';

describe('signup', () => {
  it('creates a user, normalizes email lowercase, issues __Host-session', async () => {
    const built = await makeApp();
    app = built.app;
    const r = await app.inject({
      method: 'POST', url: '/auth/signup',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'Alice@Example.com', password: STRONG }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().user.email).toBe('alice@example.com');
    const session = getCookie(r.headers['set-cookie'], '__Host-session');
    expect(session).toBeTruthy();

    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { '__Host-session': session! } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('alice@example.com');
  });

  it('rejects weak password (< 12 chars) with 400', async () => {
    const built = await makeApp();
    app = built.app;
    const r = await app.inject({
      method: 'POST', url: '/auth/signup',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.com', password: 'short' }),
    });
    expect(r.statusCode).toBe(400);
  });

  it('rejects duplicate email with 409 (case-insensitive)', async () => {
    const built = await makeApp();
    app = built.app;
    const first = await app.inject({
      method: 'POST', url: '/auth/signup',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'dup@example.com', password: STRONG }),
    });
    expect(first.statusCode).toBe(200);

    const dup = await app.inject({
      method: 'POST', url: '/auth/signup',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'DUP@example.com', password: STRONG }),
    });
    expect(dup.statusCode).toBe(409);
  });
});

describe('login', () => {
  it('valid credentials issue a session; wrong password 401 with uniform message', async () => {
    const built = await makeApp();
    app = built.app;
    await app.inject({
      method: 'POST', url: '/auth/signup',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'login@x.com', password: STRONG }),
    });

    const ok = await app.inject({
      method: 'POST', url: '/auth/login',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'login@x.com', password: STRONG }),
    });
    expect(ok.statusCode).toBe(200);
    const sess = getCookie(ok.headers['set-cookie'], '__Host-session');
    expect(sess).toBeTruthy();

    const bad = await app.inject({
      method: 'POST', url: '/auth/login',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'login@x.com', password: 'wrong-but-long-enough!!' }),
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.message).toBe('invalid email or password');
  });

  it('non-existent email returns same 401 message as wrong password (no account-enum oracle)', async () => {
    const built = await makeApp();
    app = built.app;
    const r = await app.inject({
      method: 'POST', url: '/auth/login',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'nope@x.com', password: STRONG }),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.message).toBe('invalid email or password');
  });
});

describe('email auth works without GitHub env vars', () => {
  it('app builds and email signup works when GITHUB_CLIENT_ID/SECRET are absent', async () => {
    // Override env to remove GitHub creds
    const built = await makeApp({ id: 0, email: null }, { GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined } as never);
    app = built.app;
    const signup = await app.inject({
      method: 'POST', url: '/auth/signup',
      headers: { 'x-requested-with': 'claude-sync', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'no-gh@x.com', password: STRONG }),
    });
    expect(signup.statusCode).toBe(200);

    // GitHub route should NOT be registered
    const gh = await app.inject({ method: 'GET', url: '/auth/github' });
    expect(gh.statusCode).toBe(404);
  });
});
