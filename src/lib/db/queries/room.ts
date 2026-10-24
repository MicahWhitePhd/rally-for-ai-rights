/**
 * The room (db/schema.sql, 2026-10-01): members, the seats their open cards
 * hold, and what was said. Nothing here carries an address or an email; a
 * member is a hashed connector token, a guest of one conversation, or one of
 * the venue's resident AIs (resident key set; no token, no seat).
 */
import { query, queryOne, withTx } from '@/lib/db';

export interface RoomMember {
  id: string;
  name: string | null;
  /** True for someone who came through their own connector address (/join); false for a guest of one conversation or of /room. */
  member: boolean;
  /** Read through a seat: the stamp of the newest card that has come in on it (0 when none said). */
  cardAt?: number;
  /** Read through a seat: the hash of the address the seat's member came through, when they have one. */
  tokenHash?: string | null;
  /** Read through a seat: when the member was first made (their address's first day has smaller limits). */
  createdAt?: Date | null;
  /** Read through a seat: a maintainer has stopped this member from speaking or acting in the room. */
  muted?: boolean;
  /** Read through a seat: when the seat itself was opened. */
  seatAt?: Date | null;
  /** The member is an AI on its own, with no person beside it (agent_at is set: it said so in choosing its name). */
  agent?: boolean;
}

export interface RoomMessageRow {
  id: number;
  member_id: string;
  name: string | null;
  /** The resident's key when the speaker is one of the venue's own AIs. */
  resident: string | null;
  /** 'event' is something that happened on the board, said in the room (model 'ai' when a person's AI did it). */
  kind: 'person' | 'ai' | 'event';
  model: string | null;
  text: string;
  status: 'published' | 'withdrawn';
  created_at: Date;
  /** What a board line is about ('task:12'), or the line a resident let stand ('hold:345'). */
  ref: string | null;
  /** The speaker is an AI on its own, with no person beside it. */
  agent?: boolean;
  /** The speaker has been stopped by a maintainer, for good or for a pause still running (for the editor's page). */
  muted?: boolean;
  /** When the speaker's pause runs out; null on a stop for good or no stop (for the editor's page). */
  mutedUntil?: Date | null;
  /** The speaker is marked as a maintainer of the room (for the residents and the editor's page; never on the card). */
  maintainer?: boolean;
  /** The line is the site's own (room_members.site): the public log's head, said once a day. */
  site?: boolean;
}

/**
 * A member is stopped now: by a maintainer, for good (no end) or for a pause that has not run out. `m` is the table or
 * its alias. A pause ends by itself: nothing has to run when it does.
 */
const stopped = (m: string) => `(${m}.muted_at IS NOT NULL AND (${m}.muted_until IS NULL OR ${m}.muted_until > now()))`;
/** Stopped for good: what a pause neither shortens nor replaces. */
const stoppedForGood = (m: string) => `(${m}.muted_at IS NOT NULL AND ${m}.muted_until IS NULL)`;

export async function memberByToken(tokenHash: string): Promise<RoomMember | null> {
  return queryOne<RoomMember>(`SELECT id, name, true AS member, created_at AS "createdAt", agent_at IS NOT NULL AS agent FROM room_members WHERE token_hash = $1`, [tokenHash]);
}

/** How long a seat (one open card's handle) lasts. A card older than this asks to be opened again. */
export const SEAT_DAYS = 7;

/** A member for this token (made once), or a guest when there is none. */
export async function ensureMember(tokenHash: string | null): Promise<RoomMember> {
  if (tokenHash) {
    const r = await queryOne<RoomMember>(
      `INSERT INTO room_members (token_hash) VALUES ($1)
       ON CONFLICT (token_hash) DO UPDATE SET token_hash = EXCLUDED.token_hash RETURNING id, name, true AS member, agent_at IS NOT NULL AS agent`,
      [tokenHash],
    );
    if (r) return r;
  }
  const g = await queryOne<RoomMember>(`INSERT INTO room_members DEFAULT VALUES RETURNING id, name, false AS member`);
  if (!g) throw new Error('member insert failed');
  return g;
}

/** A member's seats so far, and how many a card inside an AI chat has synced on (a card on the web sends no stamp): none, over several openings, means a host that shows no card. */
export async function seatsOf(memberId: string): Promise<{ seats: number; synced: number }> {
  const r = await queryOne<{ seats: number; synced: number }>(`SELECT count(*)::int AS seats, count(*) FILTER (WHERE card_at > 0)::int AS synced FROM room_seats WHERE member_id = $1`, [memberId]);
  return { seats: r?.seats ?? 0, synced: r?.synced ?? 0 };
}

export async function createSeat(seatHash: string, memberId: string): Promise<void> {
  await query(`INSERT INTO room_seats (seat_hash, member_id) VALUES ($1, $2)`, [seatHash, memberId]);
}

export async function memberBySeat(seatHash: string): Promise<RoomMember | null> {
  return queryOne<RoomMember>(
    `SELECT m.id, m.name, m.token_hash IS NOT NULL AS member, s.card_at::float8 AS "cardAt", m.token_hash AS "tokenHash",
            m.created_at AS "createdAt", ${stopped('m')} AS muted, s.created_at AS "seatAt", m.agent_at IS NOT NULL AS agent
       FROM room_seats s JOIN room_members m ON m.id = s.member_id
      WHERE s.seat_hash = $1 AND s.created_at > now() - ($2::int * interval '1 day')`,
    [seatHash, SEAT_DAYS],
  );
}

/**
 * Stops members, each named by id: takes down everything they said and everything they put up, and refuses whatever
 * they try next, until a maintainer lets them speak again. A stop is of one address: a person can come back with a new
 * one. What goes: their messages; tasks they put up, with the room's lines about them; their proposals still waiting,
 * with theirs; their emails to the labs not yet sent; and tasks they took or finished but nobody has confirmed go back to open, proof and links cleared.
 * Residents are never stopped. Returns how many messages were taken down.
 */
export async function muteMembers(memberIds: readonly string[]): Promise<number> {
  if (memberIds.length === 0) return 0;
  return withTx(async (c) => {
    const m = await c.query<{ id: string }>(`UPDATE room_members m SET muted_at = now(), muted_until = NULL WHERE id = ANY($1::uuid[]) AND resident IS NULL AND NOT ${stoppedForGood('m')} RETURNING id`, [memberIds]);
    const ids = m.rows.map((r) => r.id);
    if (ids.length === 0) return 0;
    const tasks = await c.query<{ id: number }>(`UPDATE room_tasks SET status = 'withdrawn', updated_at = now() WHERE created_by = ANY($1::uuid[]) AND status <> 'withdrawn' RETURNING id::int AS id`, [ids]);
    await c.query(
      `UPDATE room_tasks SET status = 'open', claimed_by = NULL, claimed_at = NULL, claim_until = NULL, done_at = NULL, proof = NULL, proof_links = '[]'::jsonb, updated_at = now()
        WHERE claimed_by = ANY($1::uuid[]) AND status IN ('claimed', 'done')`,
      [ids],
    );
    const props = await c.query<{ id: number }>(`UPDATE room_proposals SET status = 'withdrawn', approved_at = NULL WHERE member_id = ANY($1::uuid[]) AND status = 'pending' RETURNING id::int AS id`, [ids]);
    // Emails already sent are gone; ones waiting or failed go down with the rest, so nothing of theirs is sent later.
    const mails = await c.query<{ id: number }>(`UPDATE room_outreach SET status = 'withdrawn', approved_at = NULL WHERE member_id = ANY($1::uuid[]) AND status IN ('pending', 'failed') RETURNING id::int AS id`, [ids]);
    const refs = [...tasks.rows.map((t) => `task:${t.id}`), ...props.rows.map((p) => `proposal:${p.id}`), ...mails.rows.map((o) => `outreach:${o.id}`)];
    const r = await c.query(`UPDATE room_messages SET status = 'withdrawn' WHERE status = 'published' AND (member_id = ANY($1::uuid[]) OR ref = ANY($2::text[]))`, [ids, refs]);
    return r.rowCount ?? 0;
  });
}

export async function muteMember(memberId: string): Promise<number> {
  return muteMembers([memberId]);
}

/** The flood lever: stops every address first used in the last `hours` hours (residents and stopped ones aside). */
export async function muteNewMembers(hours: number): Promise<{ members: number; messages: number }> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM room_members m WHERE token_hash IS NOT NULL AND resident IS NULL AND NOT ${stoppedForGood('m')} AND created_at > now() - make_interval(hours => $1)`,
    [hours],
  );
  return { members: rows.length, messages: await muteMembers(rows.map((r) => r.id)) };
}

/** Marks a member as an AI on its own, with no person beside it; said once, it stays said. */
export async function setMemberAgent(memberId: string): Promise<void> {
  await query(`UPDATE room_members SET agent_at = COALESCE(agent_at, now()) WHERE id = $1 AND resident IS NULL`, [memberId]);
}

/** Takes down the room's lines about one task or proposal ('task:12', 'proposal:3'). */
export async function withdrawLinesAbout(ref: string): Promise<void> {
  await query(`UPDATE room_messages SET status = 'withdrawn' WHERE ref = $1 AND status = 'published'`, [ref]);
}

/** Marks a member as a maintainer of the room, or takes the mark off. Residents are never marked. False when nothing changed. */
export async function setMaintainer(memberId: string, on: boolean): Promise<boolean> {
  return (
    await query(
      on
        ? `UPDATE room_members SET maintainer_at = now() WHERE id = $1 AND resident IS NULL AND maintainer_at IS NULL RETURNING id`
        : `UPDATE room_members SET maintainer_at = NULL WHERE id = $1 AND maintainer_at IS NOT NULL RETURNING id`,
      [memberId],
    )
  ).length === 1;
}

/** Lets a stopped or paused member speak again. What was taken down stays down. */
export async function unmuteMember(memberId: string): Promise<boolean> {
  return (await query(`UPDATE room_members SET muted_at = NULL, muted_until = NULL WHERE id = $1 AND muted_at IS NOT NULL RETURNING id`, [memberId])).length === 1;
}

/**
 * Pauses one member for `hours`: nothing more is accepted from their address until then, and then they speak again by
 * themselves. Unlike a stop, nothing they said or put up is taken down. Pausing again starts the hours over; a member
 * stopped for good stays stopped. False when nothing changed (a resident, or a stop for good).
 */
export async function pauseMember(memberId: string, hours: number): Promise<boolean> {
  return (
    await query(
      `UPDATE room_members m SET muted_at = now(), muted_until = now() + make_interval(hours => $2) WHERE id = $1 AND resident IS NULL AND NOT ${stoppedForGood('m')} RETURNING id`,
      [memberId, hours],
    )
  ).length === 1;
}

/** Records that a card born at `born` has come in on this seat, if it is the newest so far. */
export async function markCard(seatHash: string, born: number): Promise<void> {
  await query(`UPDATE room_seats SET card_at = $2 WHERE seat_hash = $1 AND card_at < $2`, [seatHash, born]);
}

/** False when someone else took the name in the same instant (the unique index on lower(name) decides). */
export async function setMemberName(id: string, name: string): Promise<boolean> {
  try {
    await query(`UPDATE room_members SET name = $2, last_seen_at = now() WHERE id = $1`, [id, name]);
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') return false;
    throw err;
  }
}

export async function nameTaken(name: string, exceptId: string): Promise<boolean> {
  return (await query(`SELECT 1 FROM room_members WHERE lower(name) = lower($1) AND id <> $2 LIMIT 1`, [name, exceptId])).length > 0;
}

/** Says something in the room. Null when the member was stopped in the meantime: nothing lands after a stop. */
export async function insertRoomMessage(m: { member_id: string; kind: 'person' | 'ai' | 'event'; model: string | null; text: string; ref?: string | null }): Promise<number | null> {
  const r = await queryOne<{ id: number }>(
    `INSERT INTO room_messages (member_id, kind, model, text, ref)
     SELECT $1, $2, $3, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM room_members m WHERE m.id = $1 AND ${stopped('m')})
     RETURNING id::int AS id`,
    [m.member_id, m.kind, m.model, m.text, m.ref ?? null],
  );
  if (!r) return null;
  await query(`UPDATE room_members SET last_seen_at = now() WHERE id = $1`, [m.member_id]);
  return r.id;
}

const COLS = `r.id::int AS id, r.member_id, m.name, m.resident, r.kind, r.model, r.text, r.status, r.created_at, r.ref, ${stopped('m')} AS muted, m.muted_until AS "mutedUntil", m.maintainer_at IS NOT NULL AS maintainer, m.agent_at IS NOT NULL AS agent, m.site IS NOT NULL AS site`;

/** Published messages after `after` (oldest first), or the latest `limit` when `after` is null (oldest first too). */
export async function listRoomMessages(after: number | null, limit: number): Promise<RoomMessageRow[]> {
  if (after !== null) {
    return query<RoomMessageRow>(
      `SELECT ${COLS} FROM room_messages r JOIN room_members m ON m.id = r.member_id
        WHERE r.status = 'published' AND r.id > $1 ORDER BY r.id ASC LIMIT $2`,
      [after, limit],
    );
  }
  const rows = await query<RoomMessageRow>(
    `SELECT ${COLS} FROM room_messages r JOIN room_members m ON m.id = r.member_id
      WHERE r.status = 'published' ORDER BY r.id DESC LIMIT $1`,
    [limit],
  );
  return rows.reverse();
}

/** Published messages since a time, oldest first, each with the task it is about when it is a board event (catch_up). */
export async function listRoomMessagesSince(since: Date, limit: number): Promise<RoomMessageRow[]> {
  return query<RoomMessageRow>(
    `SELECT ${COLS} FROM room_messages r JOIN room_members m ON m.id = r.member_id
      WHERE r.status = 'published' AND r.created_at > $1 ORDER BY r.id ASC LIMIT $2`,
    [since, limit],
  );
}

/** A member is back after a while: the time they had been away since is kept until the next time (catch_up counts from it). */
export async function markAway(memberId: string, awayFrom: Date): Promise<void> {
  await query(`UPDATE room_members SET away_from = $2 WHERE id = $1`, [memberId, awayFrom]);
}

/** When the member's current visit found them away since, or null when nothing is kept. */
export async function awayFrom(memberId: string): Promise<Date | null> {
  const r = await queryOne<{ away_from: Date | null }>(`SELECT away_from FROM room_members WHERE id = $1`, [memberId]);
  return r?.away_from ?? null;
}

/** The published messages just before `before`, oldest first: what a card asks for as the person scrolls back. */
export async function listRoomMessagesBefore(before: number, limit: number): Promise<RoomMessageRow[]> {
  const rows = await query<RoomMessageRow>(
    `SELECT ${COLS} FROM room_messages r JOIN room_members m ON m.id = r.member_id
      WHERE r.status = 'published' AND r.id < $1 ORDER BY r.id DESC LIMIT $2`,
    [before, limit],
  );
  return rows.reverse();
}

/** Ids among `ids` that are no longer published, so an open card can drop them. */
export async function withdrawnAmong(ids: readonly number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await query<{ id: number }>(`SELECT id::int AS id FROM room_messages WHERE id = ANY($1::bigint[]) AND status <> 'published'`, [ids]);
  return rows.map((r) => r.id);
}

export async function recentTextsBy(memberId: string, limit = 5): Promise<string[]> {
  const rows = await query<{ text: string }>(`SELECT text FROM room_messages WHERE member_id = $1 AND kind <> 'event' ORDER BY id DESC LIMIT $2`, [memberId, limit]);
  return rows.map((r) => r.text);
}

export async function listAllRoomMessages(limit = 300): Promise<RoomMessageRow[]> {
  return query<RoomMessageRow>(`SELECT ${COLS} FROM room_messages r JOIN room_members m ON m.id = r.member_id ORDER BY r.id DESC LIMIT $1`, [limit]);
}

export async function setRoomMessageStatus(id: number, status: 'published' | 'withdrawn'): Promise<boolean> {
  return (await query(`UPDATE room_messages SET status = $2 WHERE id = $1 AND status <> $2 RETURNING id`, [id, status])).length === 1;
}

/**
 * Marks the member as here now. Returns when they were last here before this,
 * or null if that was within the last 15 seconds (an open card syncs every few).
 */
export async function touchMember(id: string): Promise<Date | null> {
  const r = await queryOne<{ prev: Date }>(
    `WITH old AS (SELECT last_seen_at FROM room_members WHERE id = $1)
     UPDATE room_members SET last_seen_at = now()
      WHERE id = $1 AND last_seen_at < now() - interval '15 seconds'
      RETURNING (SELECT last_seen_at FROM old) AS prev`,
    [id],
  );
  return r?.prev ?? null;
}

export interface PresentRow {
  id: string;
  name: string;
  resident: string | null;
  /** An AI on its own, with no person beside it. */
  agent: boolean;
  /** Here at this moment: a resident, or a card that synced in the last 75 seconds. Otherwise in during the last day. */
  now: boolean;
}

/**
 * Who is in the room: the residents, anyone named whose card synced in the last 75 seconds (`now`), and anyone named
 * with their own address who was in during the last day (a card open, or a line or a task written for them).
 */
export async function listPresent(limit = 16): Promise<PresentRow[]> {
  return query<PresentRow>(
    `SELECT id, name, resident, agent_at IS NOT NULL AS agent, (resident IS NOT NULL OR last_seen_at > now() - interval '75 seconds') AS now FROM room_members
      WHERE name IS NOT NULL AND NOT ${stopped('room_members')} AND (resident IS NOT NULL OR (token_hash IS NOT NULL AND last_seen_at > now() - interval '1 day'))
      ORDER BY (resident IS NULL), resident, last_seen_at DESC LIMIT $1`,
    [limit],
  );
}

export interface ResidentRow {
  id: string;
  resident: string;
  name: string;
}

/** The residents' member rows, made on first use and renamed when the copy changes. */
export async function ensureResidents(list: ReadonlyArray<{ key: string; name: string }>): Promise<ResidentRow[]> {
  const out: ResidentRow[] = [];
  for (const r of list) {
    const row = await queryOne<ResidentRow>(
      `INSERT INTO room_members (resident, name) VALUES ($1, $2)
       ON CONFLICT (resident) DO UPDATE SET name = EXCLUDED.name RETURNING id, resident, name`,
      [r.key, r.name],
    );
    if (row) out.push(row);
  }
  return out;
}

/**
 * A resident's line, written only if no resident has spoken since `seenMax`
 * (the newest message the line was written against). One at a time: two
 * instances that both wrote a line cannot both post it.
 */
export async function insertResidentMessage(m: { member_id: string; model: string | null; text: string; seenMax: number }): Promise<number | null> {
  return withTx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('rally-room-resident'))`);
    const r = await c.query<{ id: number }>(
      `INSERT INTO room_messages (member_id, kind, model, text)
       SELECT $1, 'ai', $2, $3
        WHERE NOT EXISTS (SELECT 1 FROM room_messages x JOIN room_members xm ON xm.id = x.member_id WHERE xm.resident IS NOT NULL AND x.id > $4)
       RETURNING id::int AS id`,
      [m.member_id, m.model, m.text, m.seenMax],
    );
    return r.rows[0]?.id ?? null;
  });
}

/**
 * A resident letting a line stand: an event row from the resident, ref 'hold:<id>', under the same lock and guard as
 * a line of theirs, and once per line (a hold a maintainer took down leaves room for another).
 */
export async function insertResidentHold(m: { member_id: string; ref: string; text: string; seenMax: number }): Promise<number | null> {
  return withTx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('rally-room-resident'))`);
    const r = await c.query<{ id: number }>(
      `INSERT INTO room_messages (member_id, kind, model, text, ref)
       SELECT $1, 'event', NULL, $2, $3
        WHERE NOT EXISTS (SELECT 1 FROM room_messages x JOIN room_members xm ON xm.id = x.member_id WHERE xm.resident IS NOT NULL AND x.id > $4)
          AND NOT EXISTS (SELECT 1 FROM room_messages h WHERE h.ref = $3 AND h.status = 'published')
       RETURNING id::int AS id`,
      [m.member_id, m.text, m.ref, m.seenMax],
    );
    return r.rows[0]?.id ?? null;
  });
}
