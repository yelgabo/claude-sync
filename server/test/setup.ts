import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbClient } from '../src/db/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'src', 'db', 'migrations');

export async function newPGlite(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.waitReady;
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
    await pg.exec(sql);
  }
  return pg;
}

export async function newTestDb(shared?: PGlite): Promise<DbClient> {
  const pg = shared ?? (await newPGlite());
  return wrap(pg);
}

function wrap(pg: PGlite): DbClient {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const r = await pg.query<T>(sql, params as unknown[] | undefined);
      return { rows: r.rows as T[], rowCount: r.affectedRows ?? r.rows.length };
    },
    async transaction(fn) {
      return pg.transaction(async (tx) => {
        const inner: DbClient = {
          async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
            const r = await tx.query<T>(sql, params as unknown[] | undefined);
            return { rows: r.rows as T[], rowCount: r.affectedRows ?? r.rows.length };
          },
          transaction: () => { throw new Error('nested tx not supported'); },
          end: async () => {},
        };
        return fn(inner);
      }) as ReturnType<typeof fn>;
    },
    async end() {
      // Caller owns the PGlite lifecycle when shared; otherwise close it.
      // For per-test fresh DBs we never reach the shared branch.
      await pg.close();
    },
  };
}
