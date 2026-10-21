/**
 * Housekeeping (src/lib/housekeeping.ts): rows nobody will read again, deleted a bounded batch at a time. Each
 * statement is one DELETE over rows it has locked and skips rows another instance has, so two instances sweeping at
 * once never wait on each other. Nothing said, put up or proposed is ever touched here: taking down hides.
 */
import { query } from '@/lib/db';

/** Seats older than `days` days. memberBySeat refuses them already (SEAT_DAYS), so nothing changes but the table's size. */
export async function deleteExpiredSeats(days: number, limit = 2000): Promise<number> {
  const rows = await query<{ seat_hash: string }>(
    `DELETE FROM room_seats WHERE seat_hash IN (
       SELECT seat_hash FROM room_seats WHERE created_at < now() - ($1::int * interval '1 day') ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED
     ) RETURNING seat_hash`,
    [days, limit],
  );
  return rows.length;
}

/**
 * Guests (no address, no resident key, no lab) not seen for `days` days, with no seat left and no line of their own: a
 * card that was opened once and closed. Members with an address are never swept; nor is anyone with a line in the
 * room, nor a lab's member (one row per lab, kept for the next reply).
 */
export async function deleteIdleGuests(days: number, limit = 1000): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM room_members WHERE id IN (
       SELECT m.id FROM room_members m
        WHERE m.token_hash IS NULL AND m.resident IS NULL AND m.lab IS NULL AND m.last_seen_at < now() - ($1::int * interval '1 day')
          AND NOT EXISTS (SELECT 1 FROM room_seats s WHERE s.member_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM room_messages r WHERE r.member_id = m.id)
        ORDER BY m.last_seen_at LIMIT $2 FOR UPDATE SKIP LOCKED
     ) RETURNING id`,
    [days, limit],
  );
  return rows.length;
}
