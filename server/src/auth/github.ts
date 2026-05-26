import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '../db/client.js';
import type { Env } from '../env.js';
import { createSession, setSessionCookie } from './session.js';
import { ApiError } from '../lib/errors.js';
import { sweepOauthStates } from '../lib/oauth-state-sweep.js';
import { ensureUserSeqRow } from '../lib/seq.js';

export const OAUTH_STATE_COOKIE = '__Secure-oauth-state';
const STATE_TTL_MS = 10 * 60 * 1000;

interface GitHubUser { id: number; email: string | null }

function signState(state: string, secret: string): string {
  return createHmac('sha256', secret).update(state).digest('base64url');
}

function safeEq(a: string, b: string): boolean {
  const aB = Buffer.from(a);
  const bB = Buffer.from(b);
  if (aB.length !== bB.length) return false;
  return timingSafeEqual(aB, bB);
}

export interface GithubAuthDeps {
  db: DbClient;
  env: Env;
  exchangeCodeForToken?: (code: string) => Promise<string>;
  fetchGitHubUser?: (token: string) => Promise<GitHubUser>;
}

export function registerGithubAuth(app: FastifyInstance, deps: GithubAuthDeps): void {
  const { db, env } = deps;
  // Caller (index.ts) only invokes this when both env vars are set; narrow here.
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new Error('registerGithubAuth requires GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET');
  }
  const githubClientId = env.GITHUB_CLIENT_ID;
  const githubClientSecret = env.GITHUB_CLIENT_SECRET;
  const exchange = deps.exchangeCodeForToken ?? defaultExchange(githubClientId, githubClientSecret, env.AUTH_URL);
  const fetchUser = deps.fetchGitHubUser ?? defaultFetchUser;

  app.get('/auth/github', async (req, reply) => {
    const state = randomBytes(24).toString('base64url');
    const signed = `${state}.${signState(state, env.AUTH_SECRET)}`;
    const expires = new Date(Date.now() + STATE_TTL_MS);

    await db.query(`INSERT INTO oauth_states (state, expires_at) VALUES ($1, $2)`, [state, expires]);
    sweepOauthStates(db).catch((e) => req.log.warn({ err: e }, 'oauth_states sweep failed'));

    reply.setCookie(OAUTH_STATE_COOKIE, signed, {
      httpOnly: true, secure: true, sameSite: 'lax',
      path: '/auth/github/callback', maxAge: Math.floor(STATE_TTL_MS / 1000),
    });

    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', githubClientId);
    url.searchParams.set('redirect_uri', `${env.AUTH_URL}/auth/github/callback`);
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);
    return reply.redirect(url.toString(), 302);
  });

  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/auth/github/callback',
    async (req, reply) => {
      const code = req.query.code;
      const stateParam = req.query.state;
      if (!code || !stateParam) throw new ApiError('invalid_request', 'missing code or state');

      const cookieVal = req.cookies[OAUTH_STATE_COOKIE];
      if (!cookieVal) throw new ApiError('invalid_request', 'missing state cookie');
      const [cookieState, cookieSig] = cookieVal.split('.');
      if (!cookieState || !cookieSig) throw new ApiError('invalid_request', 'malformed state cookie');
      if (!safeEq(cookieSig, signState(cookieState, env.AUTH_SECRET))) {
        throw new ApiError('invalid_request', 'state signature mismatch');
      }
      if (!safeEq(cookieState, stateParam)) {
        throw new ApiError('invalid_request', 'state mismatch');
      }

      const consumed = await db.query(
        `UPDATE oauth_states SET consumed_at = now()
         WHERE state = $1 AND consumed_at IS NULL AND expires_at > now()
         RETURNING state`,
        [stateParam],
      );
      if (consumed.rows.length === 0) {
        throw new ApiError('invalid_request', 'state already consumed or expired');
      }

      reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth/github/callback' });

      const accessToken = await exchange(code);
      const gh = await fetchUser(accessToken);

      const userId = await upsertUser(db, gh.id, gh.email);
      await ensureUserSeqRow(db, userId);

      const sessionId = await createSession(db, userId, null);
      setSessionCookie(reply, sessionId);

      return reply.redirect(env.AUTH_URL, 302);
    },
  );
}

async function upsertUser(db: DbClient, githubId: number, email: string | null): Promise<string> {
  const existing = await db.query<{ id: string }>(`SELECT id FROM users WHERE github_id = $1`, [githubId]);
  if (existing.rows[0]) return existing.rows[0].id;

  const id = uuidv4();
  await db.query(
    `INSERT INTO users (id, github_id, email) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO NOTHING`,
    [id, githubId, email],
  );
  const got = await db.query<{ id: string }>(`SELECT id FROM users WHERE github_id = $1`, [githubId]);
  if (!got.rows[0]) throw new ApiError('internal', 'failed to create user');
  return got.rows[0].id;
}

function defaultExchange(clientId: string, clientSecret: string, authUrl: string): (code: string) => Promise<string> {
  return async (code) => {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: `${authUrl}/auth/github/callback`,
      }),
    });
    const json = (await res.json()) as { access_token?: string; error?: string };
    if (!json.access_token) throw new ApiError('unauthorized', `github token exchange failed: ${json.error ?? 'unknown'}`);
    return json.access_token;
  };
}

async function defaultFetchUser(token: string): Promise<GitHubUser> {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'claude-sync' },
  });
  if (!res.ok) throw new ApiError('unauthorized', `github /user failed: ${res.status}`);
  const u = (await res.json()) as { id: number; email: string | null };
  return { id: u.id, email: u.email };
}


