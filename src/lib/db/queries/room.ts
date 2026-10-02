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
}

export async function memberByToken(tokenHash: string): Promise<RoomMember | null> {
  return queryOne<RoomMember>(`SELECT id, name, true AS member FROM room_members WHERE token_hash = $1`, [tokenHash]);
}

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

export async function createSeat(seatHash: string, memberId: string): Promise<number> {
  const r = await queryOne<{ n: number }>(`INSERT INTO room_seats (seat_hash, member_id) VALUES ($1, $2) RETURNING n::int AS n`, [seatHash, memberId]);
  if (!r) throw new Error('seat insert failed');
  return r.n;
}

export async function memberBySeat(seatHash: string): Promise<RoomMember | null> {
  return queryOne<RoomMember>(`SELECT m.id, m.name, m.token_hash IS NOT NULL AS member, s.card_at::float8 AS "cardAt", m.token_hash AS "tokenHash" FROM room_seats s JOIN room_members m ON m.id = s.member_id
      WHERE s.seat_hash = $1 AND s.created_at > now() - interval '30 days'`,
    [seatHash],
  );
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

export async function insertRoomMessage(m: { member_id: string; kind: 'person' | 'ai' | 'event'; model: string | null; text: string }): Promise<number> {
  const r = await queryOne<{ id: number }>(`INSERT INTO room_messages (member_id, kind, model, text) VALUES ($1, $2, $3, $4) RETURNING id::int AS id`, [m.member_id, m.kind, m.model, m.text]);
  if (!r) throw new Error('message insert failed');
  await query(`UPDATE room_members SET last_seen_at = now() WHERE id = $1`, [m.member_id]);
  return r.id;
}

const COLS = `r.id::int AS id, r.member_id, m.name, m.resident, r.kind, r.model, r.text, r.status, r.created_at`;

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
      WHERE name IS NOT NULL AND (resident IS NOT NULL OR (token_hash IS NOT NULL AND last_seen_at > now() - interval '75 seconds'))
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
