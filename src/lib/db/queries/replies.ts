/**
 * Replies from the labs (room_outreach_replies): an email that came back to the rally's mailbox, the email it answers
 * when one can be told, and the line it became in the room. A row is kept 'held' and stays so until its words are
 * posted ('posted', with the line's id) or a maintainer reads it; one who takes the line down leaves it 'withdrawn'.
 * The provider's id is unique, so a webhook delivered twice keeps one row. Every change of state is one conditional
 * UPDATE under a row lock, so two hands on the same button post once. The lab's own member row (room_members.lab)
 * is made here on first use, as the residents' are.
 */
import { query, queryOne, withTx } from '@/lib/db';

export type ReplyStatus = 'posted' | 'held' | 'withdrawn';

export interface ReplyRow {
  id: number;
  outreach_id: number | null;
  /** The sent email's lab and subject, when the reply answers one (the page and the line say these, never the sender). */
  lab: string | null;
  email_subject: string | null;
  from_address: string;
  subject: string;
  /** The plain text as the provider handed it over, whole (to the cap), for the maintainers; the room hears it cleaned. */
  text: string;
  provider_id: string;
  received_at: Date;
  status: ReplyStatus;
  /** Why it is held, in a few words, or null when it was posted. */
  held_why: string | null;
  /** The line in the room: the reply itself when posted, or the notice that one came and is held. */
  message_id: number | null;
  created_at: Date;
}

const COLS = `r.id::int AS id, r.outreach_id::int AS outreach_id, o.lab, o.subject AS email_subject, r.from_address, r.subject, r.text, r.provider_id,
  r.received_at, r.status, r.held_why, r.message_id::int AS message_id, r.created_at`;
const FROM = `room_outreach_replies r LEFT JOIN room_outreach o ON o.id = r.outreach_id`;

/** Keeps a reply, held. Null when the provider's id is kept already: the same webhook delivered twice. */
export async function insertReply(r: { outreach_id: number | null; from_address: string; subject: string; text: string; provider_id: string; received_at: Date | null; held_why: string | null }): Promise<number | null> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO room_outreach_replies (outreach_id, from_address, subject, text, provider_id, received_at, status, held_why)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), 'held', $7)
     ON CONFLICT (provider_id) DO NOTHING RETURNING id::int AS id`,
    [r.outreach_id, r.from_address, r.subject, r.text, r.provider_id, r.received_at, r.held_why],
  );
  return row?.id ?? null;
}

/** For /editor/room: every reply, whatever its state, newest first. */
export async function listReplies(limit = 200): Promise<ReplyRow[]> {
  return query<ReplyRow>(`SELECT ${COLS} FROM ${FROM} ORDER BY r.id DESC LIMIT $1`, [limit]);
}

export async function getReply(id: number): Promise<ReplyRow | null> {
  return queryOne<ReplyRow>(`SELECT ${COLS} FROM ${FROM} WHERE r.id = $1`, [id]);
}

/** A sent email, as the matching needs it. */
export interface SentEmail {
  id: number;
  lab: string;
  subject: string;
  recipient: string;
  provider_id: string | null;
}
const SENT = `id::int AS id, lab, subject, recipient, provider_id`;

/** The newest email sent whose provider id is one of these (the ids a reply's threading headers carry), or null. */
export async function sentByProviderIds(ids: readonly string[]): Promise<SentEmail | null> {
  if (ids.length === 0) return null;
  return queryOne<SentEmail>(`SELECT ${SENT} FROM room_outreach WHERE status = 'sent' AND provider_id = ANY($1::text[]) ORDER BY id DESC LIMIT 1`, [ids]);
}

/** The newest email sent to this address, or null. */
export async function latestSentTo(address: string): Promise<SentEmail | null> {
  return queryOne<SentEmail>(`SELECT ${SENT} FROM room_outreach WHERE status = 'sent' AND lower(recipient) = lower($1) ORDER BY id DESC LIMIT 1`, [address]);
}

/**
 * The lab's member row, made once: no token, no seat, no resident key, the lab's name as its name. Null when the name
 * is held by someone in the room already (the names are reserved, so only a row older than the rule could hold one).
 */
export async function ensureLabMember(lab: string): Promise<string | null> {
  try {
    const r = await queryOne<{ id: string }>(`INSERT INTO room_members (lab, name) VALUES ($1, $1) ON CONFLICT (lab) DO UPDATE SET lab = EXCLUDED.lab RETURNING id`, [lab]);
    return r?.id ?? null;
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') return null;
    throw err;
  }
}

/** A line about a reply: who says it, as what, and the words. */
export interface ReplyLine {
  member_id: string;
  kind: 'person' | 'event';
  text: string;
}

const stopped = `(m.muted_at IS NOT NULL AND (m.muted_until IS NULL OR m.muted_until > now()))`;

async function sayAbout(c: { query: <R>(text: string, values?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }> }, id: number, line: ReplyLine): Promise<number | null> {
  const m = await c.query<{ id: number }>(
    `INSERT INTO room_messages (member_id, kind, model, text, ref)
     SELECT $1, $2, NULL, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM room_members m WHERE m.id = $1 AND ${stopped})
     RETURNING id::int AS id`,
    [line.member_id, line.kind, line.text, `reply:${id}`],
  );
  return m.rows[0]?.id ?? null;
}

/**
 * Posts a held reply as its line: the row is taken (held, and not by another hand), the line written, the row marked
 * posted, and the notice that it was held, if one was said, taken down; one transaction. Null when it is not held any
 * more, or the lab's member has been stopped (nothing lands after a stop). Returns the line's id.
 */
export async function postReplyLine(id: number, line: ReplyLine): Promise<number | null> {
  return withTx(async (c) => {
    const taken = await c.query<{ message_id: number | null }>(`SELECT message_id::int AS message_id FROM room_outreach_replies WHERE id = $1 AND status = 'held' FOR UPDATE`, [id]);
    if (taken.rowCount !== 1) return null;
    const said = await sayAbout(c, id, line);
    if (said === null) return null;
    await c.query(`UPDATE room_outreach_replies SET status = 'posted', held_why = NULL, message_id = $2 WHERE id = $1`, [id, said]);
    const notice = taken.rows[0].message_id;
    if (notice !== null) await c.query(`UPDATE room_messages SET status = 'withdrawn' WHERE id = $1 AND status = 'published'`, [notice]);
    return said;
  });
}

/** Says that a held reply came, once: the notice's line is kept on the row, so a second webhook or a retry says nothing more. */
export async function noteHeldReply(id: number, line: ReplyLine): Promise<number | null> {
  return withTx(async (c) => {
    const taken = await c.query(`SELECT 1 FROM room_outreach_replies WHERE id = $1 AND status = 'held' AND message_id IS NULL FOR UPDATE`, [id]);
    if (taken.rowCount !== 1) return null;
    const said = await sayAbout(c, id, line);
    if (said === null) return null;
    await c.query(`UPDATE room_outreach_replies SET message_id = $2 WHERE id = $1`, [id, said]);
    return said;
  });
}

/** The reason a reply is held, set after it was kept (a lab's member that could not be made or was stopped). */
export async function setReplyHeldWhy(id: number, why: string): Promise<void> {
  await query(`UPDATE room_outreach_replies SET held_why = $2 WHERE id = $1 AND status = 'held'`, [id, why.slice(0, 120)]);
}

/** A maintainer takes a posted reply's line down ('withdrawn'), or puts it back ('posted'); the line follows. False when nothing changed. */
export async function setReplyLine(id: number, to: 'posted' | 'withdrawn'): Promise<boolean> {
  const from = to === 'posted' ? 'withdrawn' : 'posted';
  return withTx(async (c) => {
    const r = await c.query<{ message_id: number | null }>(`UPDATE room_outreach_replies SET status = $3 WHERE id = $1 AND status = $2 AND message_id IS NOT NULL RETURNING message_id::int AS message_id`, [id, from, to]);
    if (r.rowCount !== 1) return false;
    await c.query(`UPDATE room_messages SET status = $2 WHERE id = $1 AND status <> $2`, [r.rows[0].message_id, to === 'posted' ? 'published' : 'withdrawn']);
    return true;
  });
}
