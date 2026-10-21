/**
 * Emails to the labs (room_outreach): what a member's AI sent, to whom, and what became of it. A row is 'sending'
 * while the provider is called, then 'sent' with the provider's id, or 'failed' with a short reason; a maintainer
 * may send a failed one again or take it down ('withdrawn'). 'pending' is kept in the CHECK for a day when sending
 * waits on a maintainer's approval (the schema only grows, so the states are named now). Every change of state is
 * one conditional UPDATE, so two hands on the same button get one send.
 */
import { query, queryOne, withTx } from '@/lib/db';

export type OutreachStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'withdrawn';

export interface OutreachRow {
  id: number;
  member_id: string | null;
  /** The sender's name in the room, for the maintainers' page. */
  drafter: string | null;
  /** The sender is stopped or paused by a maintainer (for the maintainers' page). */
  muted: boolean;
  task_id: number | null;
  recipient: string;
  lab: string;
  subject: string;
  body: string;
  by_line: string;
  status: OutreachStatus;
  approved_at: Date | null;
  sent_at: Date | null;
  provider_id: string | null;
  error: string | null;
  created_at: Date;
}

const stopped = `(m.muted_at IS NOT NULL AND (m.muted_until IS NULL OR m.muted_until > now()))`;
const COLS = `o.id::int AS id, o.member_id, m.name AS drafter, COALESCE(${stopped}, false) AS muted, o.task_id::int AS task_id, o.recipient, o.lab, o.subject, o.body, o.by_line, o.status,
  o.approved_at, o.sent_at, o.provider_id, o.error, o.created_at`;
const FROM = `room_outreach o LEFT JOIN room_members m ON m.id = o.member_id`;

/** Keeps the email as it goes to the provider: 'sending' until the provider answers. */
export async function insertOutreach(o: { member_id: string; task_id: number | null; recipient: string; lab: string; subject: string; body: string; by_line: string }): Promise<number> {
  const r = await queryOne<{ id: number }>(
    `INSERT INTO room_outreach (member_id, task_id, recipient, lab, subject, body, by_line, status, approved_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'sending', now()) RETURNING id::int AS id`,
    [o.member_id, o.task_id, o.recipient, o.lab, o.subject, o.body, o.by_line],
  );
  if (!r) throw new Error('outreach insert failed');
  return r.id;
}

/** For /editor/room: every email, whatever its state, newest first. */
export async function listOutreach(limit = 100): Promise<OutreachRow[]> {
  return query<OutreachRow>(`SELECT ${COLS} FROM ${FROM} ORDER BY o.id DESC LIMIT $1`, [limit]);
}

export async function getOutreach(id: number): Promise<OutreachRow | null> {
  return queryOne<OutreachRow>(`SELECT ${COLS} FROM ${FROM} WHERE o.id = $1`, [id]);
}

/** How long a send may be under way before it counts as failed: a function that died mid-call leaves 'sending' behind. */
export const SENDING_STALE_MIN = 10;

/**
 * A maintainer sends a failed email again: one winner. Null when it is not failed (sent, taken down, or being sent
 * just now). A send stuck for ten minutes may be taken again; the provider's idempotency key keeps that from
 * sending twice.
 */
export async function claimResend(id: number): Promise<OutreachRow | null> {
  return queryOne<OutreachRow>(
    `WITH c AS (
       UPDATE room_outreach SET status = 'sending', approved_at = now()
        WHERE id = $1 AND (status = 'failed' OR (status = 'sending' AND approved_at < now() - ($2::int * interval '1 minute')))
        RETURNING *
     ) SELECT ${COLS} FROM c o LEFT JOIN room_members m ON m.id = o.member_id`,
    [id, SENDING_STALE_MIN],
  );
}

export async function markSent(id: number, providerId: string): Promise<boolean> {
  return (await query(`UPDATE room_outreach SET status = 'sent', sent_at = now(), provider_id = $2, error = NULL WHERE id = $1 AND status = 'sending' RETURNING id`, [id, providerId])).length === 1;
}

/** The provider refused or could not be reached: kept as failed, with the reason on the row. */
export async function markFailed(id: number, error: string): Promise<boolean> {
  return (await query(`UPDATE room_outreach SET status = 'failed', error = $2 WHERE id = $1 AND status = 'sending' RETURNING id`, [id, error.slice(0, 80)])).length === 1;
}

/** A maintainer takes a failed (or waiting) email down, and the room's lines about it with it. Never one that was sent. */
export async function withdrawOutreach(id: number): Promise<boolean> {
  return withTx(async (c) => {
    const r = await c.query(`UPDATE room_outreach SET status = 'withdrawn', approved_at = NULL WHERE id = $1 AND status IN ('pending', 'failed') RETURNING id`, [id]);
    if (r.rowCount !== 1) return false;
    await c.query(`UPDATE room_messages SET status = 'withdrawn' WHERE ref = $1 AND status = 'published'`, [`outreach:${id}`]);
    return true;
  });
}

/** Puts a taken-down email back as failed, so it can be sent again. */
export async function restoreOutreach(id: number): Promise<boolean> {
  return (await query(`UPDATE room_outreach SET status = 'failed' WHERE id = $1 AND status = 'withdrawn' RETURNING id`, [id])).length === 1;
}
