import { describe, it, expect, afterEach } from 'vitest';
import { makeApp, getCookie } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance | undefined;
afterEach(async () => { if (app) await app.close(); app = undefined; });

async function completeOauth(_app: FastifyInstance): Promise<string> {
  // /auth/github → 302 with state cookie
  const init = await _app.inject({ method: 'GET', url: '/auth/github' });
  expect(init.statusCode).toBe(302);
  const oauthCookie = getCookie(init.headers['set-cookie'], '__Secure-oauth-state');
  expect(oauthCookie).toBeTruthy();
  const stateMatch = /state=([^&]+)/.exec(init.headers['location'] as string);
  const state = stateMatch?.[1];
  expect(state).toBeTruthy();

  const cb = await _app.inject({
    method: 'GET',
    url: `/auth/github/callback?code=foo&state=${state}`,
    cookies: { '__Secure-oauth-state': oauthCookie! },
  });
  expect(cb.statusCode).toBe(302);
  const session = getCookie(cb.headers['set-cookie'], '__Host-session');
  expect(session).toBeTruthy();
  return session!;
}

describe('OAuth callback', () => {
  it('happy path: completes flow and issues session', async () => {
    const built = await makeApp();
    app = built.app;
    const session = await completeOauth(app);
    expect(session).toBeTruthy();

    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { '__Host-session': session } });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.user.email).toBe('test@example.com');
  });

  it('rejects missing state cookie', async () => {
    const built = await makeApp();
    app = built.app;
    const init = await app.inject({ method: 'GET', url: '/auth/github' });
    const stateMatch = /state=([^&]+)/.exec(init.headers['location'] as string);
    const cb = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=foo&state=${stateMatch![1]}`,
    });
    expect(cb.statusCode).toBe(400);
    expect(cb.json().error.code).toBe('invalid_request');
  });

  it('rejects state mismatch (CSRF)', async () => {
    const built = await makeApp();
    app = built.app;
    const init = await app.inject({ method: 'GET', url: '/auth/github' });
    const cookieVal = getCookie(init.headers['set-cookie'], '__Secure-oauth-state');
    const cb = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=foo&state=DIFFERENT`,
      cookies: { '__Secure-oauth-state': cookieVal! },
    });
    expect(cb.statusCode).toBe(400);
  });

  it('rejects tampered state signature', async () => {
    const built = await makeApp();
    app = built.app;
    const init = await app.inject({ method: 'GET', url: '/auth/github' });
    const cookieVal = getCookie(init.headers['set-cookie'], '__Secure-oauth-state');
    const [s] = cookieVal!.split('.');
    const tampered = `${s}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const cb = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=foo&state=${s}`,
      cookies: { '__Secure-oauth-state': tampered },
    });
    expect(cb.statusCode).toBe(400);
  });

  it('rejects replayed state (single-use)', async () => {
    const built = await makeApp();
    app = built.app;
    const init = await app.inject({ method: 'GET', url: '/auth/github' });
    const cookieVal = getCookie(init.headers['set-cookie'], '__Secure-oauth-state');
    const state = /state=([^&]+)/.exec(init.headers['location'] as string)![1];

    const first = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=foo&state=${state}`,
      cookies: { '__Secure-oauth-state': cookieVal! },
    });
    expect(first.statusCode).toBe(302);

    const replay = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=foo&state=${state}`,
      cookies: { '__Secure-oauth-state': cookieVal! },
    });
    expect(replay.statusCode).toBe(400);
  });

  it('issues __Host-session cookie with HttpOnly; Secure; SameSite=Strict; Path=/', async () => {
    const built = await makeApp();
    app = built.app;
    const init = await app.inject({ method: 'GET', url: '/auth/github' });
    const cookieVal = getCookie(init.headers['set-cookie'], '__Secure-oauth-state');
    const state = /state=([^&]+)/.exec(init.headers['location'] as string)![1];
    const cb = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=foo&state=${state}`,
      cookies: { '__Secure-oauth-state': cookieVal! },
    });
    const setCookie = cb.headers['set-cookie'];
    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
    const sessionCookieStr = arr.find((c) => typeof c === 'string' && c.startsWith('__Host-session='));
    expect(sessionCookieStr).toBeDefined();
    expect(sessionCookieStr).toContain('HttpOnly');
    expect(sessionCookieStr).toContain('Secure');
    expect(sessionCookieStr).toMatch(/SameSite=Strict/i);
    expect(sessionCookieStr).toMatch(/Path=\//);
  });
});

describe('Sessions', () => {
  it('rejects unauthenticated /api/me with 401', async () => {
    const built = await makeApp();
    app = built.app;
    const r = await app.inject({ method: 'GET', url: '/api/me' });
    expect(r.statusCode).toBe(401);
  });

  it('logout revokes session', async () => {
    const built = await makeApp();
    app = built.app;
    const session = await completeOauth(app);
    const out = await app.inject({
      method: 'POST', url: '/auth/logout',
      cookies: { '__Host-session': session },
      headers: { 'x-requested-with': 'claude-sync' },
    });
    expect(out.statusCode).toBe(200);

    const meAgain = await app.inject({ method: 'GET', url: '/api/me', cookies: { '__Host-session': session } });
    expect(meAgain.statusCode).toBe(401);
  });

  it('revoke-all invalidates sibling sessions', async () => {
    const built = await makeApp();
    app = built.app;
    const s1 = await completeOauth(app);
    const s2 = await completeOauth(app);

    const r = await app.inject({
      method: 'POST', url: '/auth/sessions/revoke-all',
      cookies: { '__Host-session': s1 },
      headers: { 'x-requested-with': 'claude-sync' },
    });
    expect(r.statusCode).toBe(200);

    const a = await app.inject({ method: 'GET', url: '/api/me', cookies: { '__Host-session': s1 } });
    const b = await app.inject({ method: 'GET', url: '/api/me', cookies: { '__Host-session': s2 } });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
  });
});

