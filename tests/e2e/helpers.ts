/**
 * The database for the browser tests. DATABASE_URL must be a local or
 * throwaway Postgres with db/schema.sql applied, never a production one: the
 * specs insert rows and delete them by id.
 */
import { Pool } from 'pg';

export const HAS_DB = !!process.env.DATABASE_URL;

let pool: Pool | null = null;
export function db(): Pool {
  if (!pool) {
    const ssl = process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined;
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl });
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
}
