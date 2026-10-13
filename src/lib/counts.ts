/**
 * Counts a maintainer reads by the day at /editor/room (room_counts): refusals by reason, ledger rows that could not
 * be written, and the first steps people take. Numbers with no one in them, and no words. Two ways in: count() for
 * what happens often (a refusal a flood brings by the hundred), kept in this instance's memory and written in one
 * statement at most every ten seconds, so a flood turned away before the database is not a write per request; and
 * countNow() for what happens rarely (a first line), written at once and awaited. Neither ever throws, and neither
 * holds the process open. A count lost with an instance that goes away inside those ten seconds is a count, not a
 * line said.
 */
import { addCounts } from '@/lib/db/queries/counts';

export const FLUSH_MS = 10_000;
const KEY_MAX = 60;
const pending = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;

function warn(err: unknown): void {
  failures += 1;
  // Said once, then once in a hundred: a database that is down says so elsewhere too.
  if (failures === 1 || failures % 100 === 0) console.warn('[COUNTS] not written', (err as Error)?.message);
}

/** One more of `key` today, written with the rest of this instance's counts within ten seconds. */
export function count(key: string, n = 1): void {
  const k = key.slice(0, KEY_MAX);
  pending.set(k, (pending.get(k) ?? 0) + n);
  if (!timer) {
    timer = setTimeout(() => void flush(), FLUSH_MS);
    timer.unref?.();
  }
}

/** Writes what this instance has counted. Called by the timer; a test may call it. */
export async function flush(): Promise<void> {
  timer = null;
  if (pending.size === 0) return;
  const batch = [...pending.entries()];
  pending.clear();
  try {
    await addCounts(batch);
  } catch (err) {
    warn(err);
  }
}

/** One more of `key` today, written now. For what happens rarely and matters: a first step. */
export async function countNow(key: string): Promise<void> {
  try {
    await addCounts([[key.slice(0, KEY_MAX), 1]]);
  } catch (err) {
    warn(err);
  }
}
