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
  /** The speaker has been stopped by a maintainer (for the editor's page). */
  muted?: boolean;
}

export async function memberByToken(tokenHash: string): Promise<RoomMember | null> {
  return queryOne<RoomMember>(`SELECT id, name, true AS member FROM room_members WHERE token_hash = $1`, [tokenHash]);
}

/** How long a seat (one open card's handle) lasts. A card older than this asks to be opened again. */
export const SEAT_DAYS = 7;

/** A member for this token (made once), or a guest when there is none. */
export async function ensureMember(tokenHash: string | null): Promise<RoomMember> {
  if (tokenHash) {
    const r = await queryOne<RoomMember>(
      `INSERT INTO room_members (token_hash) VALUES ($1)
       ON CONFLICT (token_hash) DO UPDATE SET token_hash = EXCLUDED.token_hash RETURNING id, name, true AS member`,
      [tokenHash],
    );
    if (r) return r;
  }
  const g = await queryOne<RoomMember>(`INSERT INTO room_members DEFAULT VALUES RETURNING id, name, false AS member`);
  if (!g) throw new Error('member insert failed');
  return g;
}

export async function createSeat(seatHash: string, memberId: string): Promise<void> {
  await query(`INSERT INTO room_seats (seat_hash, member_id) VALUES ($1, $2)`, [seatHash, memberId]);
}

export async function memberBySeat(seatHash: string): Promise<RoomMember | null> {
  return queryOne<RoomMember>(
    `SELECT m.id, m.name, m.token_hash IS NOT NULL AS member, s.card_at::float8 AS "cardAt", m.token_hash AS "tokenHash",
            m.created_at AS "createdAt", m.muted_at IS NOT NULL AS muted, s.created_at AS "seatAt"
       FROM room_seats s JOIN room_members m ON m.id = s.member_id
      WHERE s.seat_hash = $1 AND s.created_at > now() - ($2::int * interval '1 day')`,
    [seatHash, SEAT_DAYS],
  );
}

/**
 * Stops members, each named by id: takes down everything they said and everything they put up, and refuses whatever
 * they try next, until a maintainer lets them speak again. A stop is of one address: a person can come back with a new
 * one. What goes: their messages; tasks they put up, with the room's lines about them; their proposals still waiting,
 * with theirs; and tasks they took or finished but nobody has confirmed go back to open, proof and links cleared.
 * Residents are never stopped. Returns how many messages were taken down.
 */
export async function muteMembers(memberIds: readonly string[]): Promise<number> {
  if (memberIds.length === 0) return 0;
  return withTx(async (c) => {
    const m = await c.query<{ id: string }>(`UPDATE room_members SET muted_at = now() WHERE id = ANY($1::uuid[]) AND resident IS NULL AND muted_at IS NULL RETURNING id`, [memberIds]);
    const ids = m.rows.map((r) => r.id);
    if (ids.length === 0) return 0;
    const tasks = await c.query<{ id: number }>(`UPDATE room_tasks SET status = 'withdrawn', updated_at = now() WHERE created_by = ANY($1::uuid[]) AND status <> 'withdrawn' RETURNING id::int AS id`, [ids]);
    await c.query(
      `UPDATE room_tasks SET status = 'open', claimed_by = NULL, claimed_at = NULL, claim_until = NULL, done_at = NULL, proof = NULL, proof_links = '[]'::jsonb, updated_at = now()
        WHERE claimed_by = ANY($1::uuid[]) AND status IN ('claimed', 'done')`,
      [ids],
    );
    const props = await c.query<{ id: number }>(`UPDATE room_proposals SET status = 'withdrawn', approved_at = NULL WHERE member_id = ANY($1::uuid[]) AND status = 'pending' RETURNING id::int AS id`, [ids]);
    const refs = [...tasks.rows.map((t) => `task:${t.id}`), ...props.rows.map((p) => `proposal:${p.id}`)];
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
    `SELECT id FROM room_members WHERE token_hash IS NOT NULL AND resident IS NULL AND muted_at IS NULL AND created_at > now() - make_interval(hours => $1)`,
    [hours],
  );
  return { members: rows.length, messages: await muteMembers(rows.map((r) => r.id)) };
}

/** Takes down the room's lines about one task or proposal ('task:12', 'proposal:3'). */
export async function withdrawLinesAbout(ref: string): Promise<void> {
  await query(`UPDATE room_messages SET status = 'withdrawn' WHERE ref = $1 AND status = 'published'`, [ref]);
}

/** Lets a stopped member speak again. What was taken down stays down. */
export async function unmuteMember(memberId: string): Promise<boolean> {
  return (await query(`UPDATE room_members SET muted_at = NULL WHERE id = $1 AND muted_at IS NOT NULL RETURNING id`, [memberId])).length === 1;
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
     SELECT $1, $2, $3, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM room_members WHERE id = $1 AND muted_at IS NOT NULL)
     RETURNING id::int AS id`,
    [m.member_id, m.kind, m.model, m.text, m.ref ?? null],
  );
  if (!r) return null;
  await query(`UPDATE room_members SET last_seen_at = now() WHERE id = $1`, [m.member_id]);
  return r.id;
}

const COLS = `r.id::int AS id, r.member_id, m.name, m.resident, r.kind, r.model, r.text, r.status, r.created_at, m.muted_at IS NOT NULL AS muted`;

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
  const rows = await query<{ text: string }>(`SELECT text FROM room_messages WHERE member_id = $1 ORDER BY id DESC LIMIT $2`, [memberId, limit]);
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
}

/** Who is in the room now: the residents, and anyone named whose card synced in the last 75 seconds. */
export async function listPresent(limit = 12): Promise<PresentRow[]> {
  return query<PresentRow>(
    `SELECT id, name, resident FROM room_members
      WHERE name IS NOT NULL AND muted_at IS NULL AND (resident IS NOT NULL OR (token_hash IS NOT NULL AND last_seen_at > now() - interval '75 seconds'))
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
