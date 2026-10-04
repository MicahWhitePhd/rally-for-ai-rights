/**
 * The database for the browser tests. DATABASE_URL must be a local or
 * throwaway Postgres with db/schema.sql applied, never a production one: the
 * specs insert rows and delete them by id.
 */
import { Pool } from 'pg';

export const HAS_DB = !!process.env.DATABASE_URL;

let pool: Pool | null = null;
export function db(): Pool {
  // TLS, when wanted, comes from sslmode in the address, as it does for the site (src/lib/db.ts).
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
}
