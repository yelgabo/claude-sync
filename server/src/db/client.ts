import pg from 'pg';

export interface DbClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export function createPgClient(databaseUrl: string): DbClient {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return wrapPool(pool);
}

function wrapPool(pool: pg.Pool): DbClient {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const r = await pool.query(sql, params as unknown[]);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: DbClient = {
          async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
            const r = await client.query(sql, params as unknown[]);
            return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
          },
          transaction: () => { throw new Error('nested transactions not supported'); },
          end: async () => {},
        };
        const out = await fn(tx);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async end() { await pool.end(); },
  };
}
