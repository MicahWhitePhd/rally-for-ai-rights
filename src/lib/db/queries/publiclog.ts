/**
 * The public log's head in the room (room_log_heads): the site's own voice, a member row with `site` set and the name
 * kept for it, made on first use as a lab's is (replies.ts); and one row a day for the head it said, with the line
 * that said it. The row and the line are written in one transaction keyed on the day, so the head is said once a UTC
 * day however many instances or callers ask at once (src/lib/publiclog/head.ts).
 */
import { query, queryOne, withTx } from '@/lib/db';

const stopped = `(m.muted_at IS NOT NULL AND (m.muted_until IS NULL OR m.muted_until > now()))`;

/**
 * The site's member row for one voice ('log'), made once with the name kept for it. Null when the name is held by
 * someone in the room already (it is reserved, so only a row older than the rule could hold it).
 */
export async function ensureSiteMember(voice: string, name: string): Promise<string | null> {
  try {
    const r = await queryOne<{ id: string }>(`INSERT INTO room_members (site, name) VALUES ($1, $2) ON CONFLICT (site) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [voice, name]);
    return r?.id ?? null;
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') return null;
    throw err;
  }
}

export interface LogHeadRow {
  day: Date;
  seq: number;
  hash: string;
  message_id: number | null;
  created_at: Date;
}

/**
 * Says the head for `day` (YYYY-MM-DD, UTC), once: the day's row is taken, the line written as the site's event (ref
 * 'log:<seq>'), and the line's id kept on the row. Null when the day has its row already. `line` is null when the
 * row was made but the voice is stopped (a maintainer paused or stopped the site's member): the row still stands, so
 * nothing tries again until tomorrow, and the maintainers see the line missing.
 */
export async function sayLogHead(o: { day: string; seq: number; hash: string; member_id: string; text: string }): Promise<{ line: number | null } | null> {
  return withTx(async (c) => {
    const taken = await c.query(`INSERT INTO room_log_heads (day, seq, hash) VALUES ($1::date, $2, $3) ON CONFLICT (day) DO NOTHING RETURNING day`, [o.day, o.seq, o.hash]);
    if (taken.rowCount !== 1) return null;
    const said = await c.query<{ id: number }>(
      `INSERT INTO room_messages (member_id, kind, model, text, ref)
       SELECT $1, 'event', NULL, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM room_members m WHERE m.id = $1 AND ${stopped})
       RETURNING id::int AS id`,
      [o.member_id, o.text, `log:${o.seq}`],
    );
    const line = said.rows[0]?.id ?? null;
    if (line !== null) await c.query(`UPDATE room_log_heads SET message_id = $2 WHERE day = $1::date`, [o.day, line]);
    return { line };
  });
}

/** The latest day the head was said, or null when it never has been. */
export async function lastLogHead(): Promise<LogHeadRow | null> {
  return queryOne<LogHeadRow>(`SELECT day, seq, hash, message_id::int AS message_id, created_at FROM room_log_heads ORDER BY day DESC LIMIT 1`);
}

/** For the maintainers' page: the heads said, newest first. */
export async function listLogHeads(limit = 60): Promise<LogHeadRow[]> {
  return query<LogHeadRow>(`SELECT day, seq, hash, message_id::int AS message_id, created_at FROM room_log_heads ORDER BY day DESC LIMIT $1`, [limit]);
}
