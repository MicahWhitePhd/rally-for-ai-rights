/**
 * Copy overrides (db/schema.sql, 2026-09-28): the site's text, edited by hand
 * in /editor/copy. One row per string path in src/lib/copy.ts ("ROOM.title",
 * "FRONT.steps[1].text"); no row means the default in the code.
 */
import { query } from '@/lib/db';

export interface CopyOverride {
  path: string;
  value: string;
  updated_at: Date;
  updated_by: string | null;
}

export async function listCopyOverrides(): Promise<CopyOverride[]> {
  return query<CopyOverride>(`SELECT path, value, updated_at, updated_by FROM copy_overrides ORDER BY path`);
}

export async function setCopyOverride(path: string, value: string, by: string | null): Promise<void> {
  await query(
    `INSERT INTO copy_overrides (path, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (path) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [path, value, by],
  );
}

export async function deleteCopyOverride(path: string): Promise<boolean> {
  return (await query(`DELETE FROM copy_overrides WHERE path = $1 RETURNING path`, [path])).length === 1;
}
