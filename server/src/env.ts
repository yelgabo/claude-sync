import { z } from 'zod';

const Schema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  AUTH_URL: z.string().url(),
  AUTH_TRUST_HOST: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 chars'),
  // GitHub OAuth is now optional. If both are present, /auth/github routes register.
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  RATE_LIMIT_AUTH_PER_IP: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_API_PER_USER: z.coerce.number().int().positive().default(60),
  STORAGE_QUOTA_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
});

export type Env = z.infer<typeof Schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
