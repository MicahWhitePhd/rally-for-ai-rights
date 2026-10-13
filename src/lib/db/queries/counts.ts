/** Counts by the day (room_counts): added to in one statement, and read back for the maintainers' page. */
import { query } from '@/lib/db';

/** Adds each (key, n) to today's row for that key, UTC, making the row when there is none. */
export async function addCounts(batch: ReadonlyArray<readonly [string, number]>): Promise<void> {
  if (batch.length === 0) return;
  await query(
    `INSERT INTO room_counts (day, key, n)
       SELECT (now() AT TIME ZONE 'UTC')::date, t.k, t.c FROM unnest($1::text[], $2::int[]) AS t(k, c)
       ON CONFLICT (day, key) DO UPDATE SET n = room_counts.n + EXCLUDED.n`,
    [batch.map(([k]) => k), batch.map(([, n]) => n)],
  );
}

export interface DayCount {
  day: string;
  key: string;
  n: number;
}

/** Every count of the last `days` UTC days, today included, newest day first. */
export async function countsByDay(days: number): Promise<DayCount[]> {
  return query<DayCount>(`SELECT day::text AS day, key, n FROM room_counts WHERE day > (now() AT TIME ZONE 'UTC')::date - $1::int ORDER BY day DESC, key`, [days]);
}
