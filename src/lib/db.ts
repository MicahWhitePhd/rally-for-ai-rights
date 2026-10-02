/**
 * The Postgres connection. db/schema.sql is the whole database.
 *
 * Server-only: `pg` is a Node client and must never reach the browser bundle.
 * Every consumer is a React Server Component, a route handler, a Server Action,
 * or a script run with tsx. Timestamps come back as JS Date (pg default).
 */
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';

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
  // TLS for hosted Postgres without verifying the cert chain. Toggle with PGSSL=require.
  const useSsl = process.env.PGSSL === 'require';
  let connectionString = raw;
  if (useSsl) {
    try {
      const u = new URL(raw);
      u.searchParams.delete('sslmode');
      u.searchParams.delete('channel_binding');
      connectionString = u.toString();
    } catch {
      /* unparseable string — leave as-is */
    }
  }
  return {
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    // Headroom for a Neon cold start (TCP + TLS + wake can exceed a few seconds).
    connectionTimeoutMillis: 12_000,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
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

/** Parameterised query; retries ONCE on a connect-acquire failure (Neon cold start). */
export async function query<T extends QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<T[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await getPool().query<T>(text, params as unknown[]);
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
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Several statements in ONE transaction on one checked-out client. */
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
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
