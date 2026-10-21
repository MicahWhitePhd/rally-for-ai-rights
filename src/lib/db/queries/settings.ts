/**
 * Settings: the small switches and state rows (db/schema.sql). Every open card's sync reads several of them, and they
 * change rarely, so reads come from one snapshot of the whole table, taken at most every few seconds per server
 * instance. A write on this instance drops the snapshot at once; other instances see it within a few seconds.
 */
import { query } from '@/lib/db';

const FRESH_MS = 5000;
let snapshot: { at: number; values: Map<string, unknown> } | null = null;
let loading: Promise<Map<string, unknown>> | null = null;

async function values(): Promise<Map<string, unknown>> {
  if (snapshot && Date.now() - snapshot.at < FRESH_MS) return snapshot.values;
  if (!loading) {
    loading = query<{ key: string; value: unknown }>(`SELECT key, value FROM settings`)
      .then((rows) => {
        const map = new Map(rows.map((r) => [r.key, r.value] as const));
        snapshot = { at: Date.now(), values: map };
        return map;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const v = (await values()).get(key);
  return (v === null || v === undefined ? fallback : v) as T;
}

/** Test hook, and for anything that must see a write made elsewhere at once. */
export function forgetSettings(): void {
  snapshot = null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
  forgetSettings();
}

/**
 * Writes a row unless a mark stands in it: a mark is `value.<field> = { at: <ms> }`, and it stands while `at` is later
 * than `since`. One statement, so two instances that write at once get one winner. True when this call wrote.
 */
export async function setSettingUnlessMarked(key: string, value: unknown, field: string, since: number): Promise<boolean> {
  const rows = await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     WHERE coalesce((settings.value -> $3::text ->> 'at')::float8, 0) <= $4::float8
     RETURNING key`,
    [key, JSON.stringify(value), field, since],
  );
  forgetSettings();
  return rows.length === 1;
}

export async function listSettings(): Promise<{ key: string; value: unknown; updated_at: Date }[]> {
  return query(`SELECT key, value, updated_at FROM settings ORDER BY key`);
}
