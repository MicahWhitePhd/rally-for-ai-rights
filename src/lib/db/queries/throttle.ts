import { query, queryOne } from '@/lib/db';

/**
 * Fixed-window counter on the `throttle` table. ONE statement per check: the
 * window start is computed in SQL from now() so concurrent callers agree on it,
 * and the upsert returns the post-increment count.
 */
export async function bumpThrottle(bucket: string, windowSec: number): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `INSERT INTO throttle (bucket, win, n)
     VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2::int) * $2::int), 1)
     ON CONFLICT (bucket, win) DO UPDATE SET n = throttle.n + 1
     RETURNING n`,
    [bucket, windowSec],
  );
  return row?.n ?? 0;
}

/** Nightly housekeeping: windows older than `olderThanSec` are dead weight. */
export async function cleanupThrottle(olderThanSec = 86_400): Promise<number> {
  const rows = await query<{ bucket: string }>(
    `DELETE FROM throttle WHERE win < now() - ($1::int * interval '1 second') RETURNING bucket`,
    [olderThanSec],
  );
  return rows.length;
}
