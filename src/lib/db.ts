/**
 * The Postgres connection. db/schema.sql is the whole database.
 *
 * Server-only: `pg` is a Node client and must never reach the browser bundle.
 * Every consumer is a React Server Component, a route handler, a Server Action,
 * or a script run with tsx. Timestamps come back as JS Date (pg default).
 */
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import { roomChanged } from '@/lib/quiet';

declare global {
  // eslint-disable-next-line no-var
  var __rallyPool: Pool | undefined;
}

function baseConfig(): PoolConfig {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      'DATABASE_URL is not set. Set it to a Postgres that db/schema.sql has been applied to (`pnpm db:apply`).',
    );
  }
  // TLS comes from the address itself: a hosted Postgres gives an address with sslmode=require, which `pg` treats as
  // verify-full (the server's certificate is checked). A local database needs none.
  return {
    connectionString: raw,
    // One sync runs several queries at once; room for two or three of them on one instance.
    max: 10,
    // Idle connections close quickly, so a database that bills while connections are open can go to sleep.
    idleTimeoutMillis: 5_000,
    // Headroom for a Neon cold start (TCP + TLS + wake can exceed a few seconds).
    connectionTimeoutMillis: 12_000,
  };
}

/**
 * Lazy, memoised pool. Lazy is load-bearing: Next evaluates route modules at
 * build time and must not throw on a missing DATABASE_URL then.
 */
export function getPool(): Pool {
  if (!globalThis.__rallyPool) {
    globalThis.__rallyPool = new Pool(baseConfig());
  }
  return globalThis.__rallyPool;
}

/** Connection-ACQUISITION failures (nothing executed) — safe to retry even for writes. */
function isConnectAcquireError(e: unknown): boolean {
  const err = e as { message?: string; code?: string };
  const msg = (err?.message ?? '').toLowerCase();
  const code = err?.code;
  return (
    msg.includes('timeout exceeded when trying to connect') ||
    msg.includes('connection terminated due to connection timeout') ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN'
  );
}

/** A statement that may change something: anything but a plain read (a lock in a read counts too; that only costs a reread). */
const WRITES = /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|ALTER|CREATE|DROP)\b/i;

export interface QueryOptions {
  /** A write that changes nothing anyone reading the room is shown (the throttle's counts): the room's version stays (src/lib/quiet.ts). */
  unseen?: boolean;
}

/**
 * Parameterised query; retries ONCE on a connect-acquire failure (Neon cold start). A write that changed a row moves
 * the room's version (src/lib/quiet.ts) before it returns, so no read kept from before it is given again; one that
 * changed none changed nothing (every write here that wraps another in WITH returns the rows it changed).
 */
export async function query<T extends QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
  options: QueryOptions = {},
): Promise<T[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await getPool().query<T>(text, params as unknown[]);
      if (!options.unseen && res.rowCount !== 0 && WRITES.test(text)) await roomChanged();
      return res.rows;
    } catch (e) {
      if (attempt < 2 && isConnectAcquireError(e)) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      throw e;
    }
  }
}

export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
  options: QueryOptions = {},
): Promise<T | null> {
  const rows = await query<T>(text, params, options);
  return rows[0] ?? null;
}

/** Several statements in ONE transaction on one checked-out client. Once committed, the room's version moves (src/lib/quiet.ts). */
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    await roomChanged();
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* surface the original error */
    }
    throw err;
  } finally {
    client.release();
  }
}
