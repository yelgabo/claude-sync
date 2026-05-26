import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbClient } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export async function runMigrations(db: DbClient): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
    await db.query(sql);
  }
}

if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  const { createPgClient } = await import('./client.js');
  const url = process.env['DATABASE_URL'];
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const db = createPgClient(url);
  try { await runMigrations(db); console.log('migrations applied'); }
  finally { await db.end(); }
}
