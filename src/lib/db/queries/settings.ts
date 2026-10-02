import { query, queryOne } from '@/lib/db';

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const r = await queryOne<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [key]);
  if (!r) return fallback;
  return (r.value === null || r.value === undefined ? fallback : r.value) as T;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function listSettings(): Promise<{ key: string; value: unknown; updated_at: Date }[]> {
  return query(`SELECT key, value, updated_at FROM settings ORDER BY key`);
}
