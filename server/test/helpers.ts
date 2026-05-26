import type { Env } from '../src/env.js';
import { buildApp } from '../src/index.js';
import { newTestDb } from './setup.js';

export const TEST_ENV: Env = {
  DATABASE_URL: undefined,
  AUTH_URL: 'http://localhost:8080',
  AUTH_TRUST_HOST: false,
  AUTH_SECRET: 'test-secret-test-secret-test-secret-32',
  GITHUB_CLIENT_ID: 'test_gh_id',
  GITHUB_CLIENT_SECRET: 'test_gh_secret',
  PORT: 8080,
  NODE_ENV: 'test',
  RATE_LIMIT_AUTH_PER_IP: 1000,
  RATE_LIMIT_API_PER_USER: 1000,
  STORAGE_QUOTA_BYTES: 10 * 1024 * 1024,
};

export async function makeApp(
  githubUserOverride: { id: number; email: string | null } = { id: 12345, email: 'test@example.com' },
  envOverride: Partial<Env> = {},
) {
  const db = await newTestDb();
  const built = await buildApp({
    env: { ...TEST_ENV, ...envOverride },
    db,
    skipMigrations: true,
    disableRateLimit: true,
    githubDeps: {
      exchangeCodeForToken: async () => 'fake_access_token',
      fetchGitHubUser: async () => githubUserOverride,
    },
  });
  return built;
}

// Extract cookie value by name from response set-cookie header(s).
export function getCookie(setCookieHeader: string | string[] | undefined, name: string): string | undefined {
  if (!setCookieHeader) return undefined;
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const c of arr) {
    const m = new RegExp(`^${name.replace(/[$()*+./?[\\\]^{|}-]/g, '\\$&')}=([^;]+)`).exec(c);
    if (m) return decodeURIComponent(m[1]!);
  }
  return undefined;
}

