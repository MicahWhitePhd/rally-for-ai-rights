/**
 * The figures on the maintainers' page (/editor/room) and in /api/health?deep=1, read from the tables the room already
 * keeps: lines, model calls and spend by the day, when each resident last spoke, when the proposals job last read the
 * site. Numbers by the day, with no one in them.
 */
import { query, queryOne } from '@/lib/db';
import { getSetting } from '@/lib/db/queries/settings';
import { utcDayStart } from '@/lib/db/queries/log';

/** Midnight UTC, `days - 1` days ago: the start of a window of `days` UTC days ending today. */
export const windowStart = (days: number, now = new Date()): Date => new Date(utcDayStart(now).getTime() - (days - 1) * 86_400_000);

export interface DayLines {
  day: string;
  people: number;
  ais: number;
  residents: number;
  holds: number;
  events: number;
}

/** Published lines by the day: people's, their AIs', the residents', the lines a resident let stand, and what the board said. */
export async function linesByDay(days: number): Promise<DayLines[]> {
  return query<DayLines>(
    `SELECT (r.created_at AT TIME ZONE 'UTC')::date::text AS day,
            COUNT(*) FILTER (WHERE r.kind = 'person')::int AS people,
            COUNT(*) FILTER (WHERE r.kind = 'ai' AND m.resident IS NULL)::int AS ais,
            COUNT(*) FILTER (WHERE r.kind = 'ai' AND m.resident IS NOT NULL)::int AS residents,
            COUNT(*) FILTER (WHERE r.kind = 'event' AND r.ref LIKE 'hold:%')::int AS holds,
            COUNT(*) FILTER (WHERE r.kind = 'event' AND (r.ref IS NULL OR r.ref NOT LIKE 'hold:%'))::int AS events
       FROM room_messages r JOIN room_members m ON m.id = r.member_id
      WHERE r.status = 'published' AND r.created_at >= $1
      GROUP BY 1 ORDER BY 1 DESC`,
    [windowStart(days)],
  );
}

export interface DaySpend {
  day: string;
  calls: number;
  usd: number;
  failed: number;
  estimated: number;
}

/** Model calls by the day: how many, what they cost, how many failed, how many are costed as an estimate. */
export async function spendByDay(days: number): Promise<DaySpend[]> {
  return query<DaySpend>(
    `SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day, COUNT(*)::int AS calls, COALESCE(SUM(cost_usd), 0)::float8 AS usd,
            COUNT(*) FILTER (WHERE NOT ok)::int AS failed, COUNT(*) FILTER (WHERE estimated)::int AS estimated
       FROM generation_log WHERE created_at >= $1 GROUP BY 1 ORDER BY 1 DESC`,
    [windowStart(days)],
  );
}

export interface ResidentLast {
  resident: string;
  name: string;
  at: Date | null;
}

/** When each resident last spoke (a published line of theirs), by their key. */
export async function residentsLastLine(): Promise<ResidentLast[]> {
  return query<ResidentLast>(
    `SELECT m.resident, m.name, MAX(r.created_at) AS at
       FROM room_members m LEFT JOIN room_messages r ON r.member_id = m.id AND r.kind = 'ai' AND r.status = 'published'
      WHERE m.resident IS NOT NULL GROUP BY m.id, m.resident, m.name ORDER BY m.resident`,
  );
}

/** When a person last spoke, or null when nobody has. */
export async function lastPersonLine(): Promise<Date | null> {
  const r = await queryOne<{ at: Date | null }>(`SELECT MAX(created_at) AS at FROM room_messages WHERE kind = 'person' AND status = 'published'`);
  return r?.at ?? null;
}

/** When the repository's job last read /api/proposals, or null when it has not been seen. */
export async function proposalsJobSeenAt(): Promise<Date | null> {
  const v = await getSetting<string | null>('proposals_job_seen_at', null);
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}
