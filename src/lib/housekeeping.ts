/**
 * Housekeeping, in passing: rows nobody will read again (seats past their days, guests seen once and never again) are
 * deleted a bounded batch at a time, at most hourly per instance, after a response has gone out (the two HTTP doors
 * call housekeep(): the card's API and the connector). Two instances sweeping at once skip each other's rows. No
 * request waits for it, and none can fail for it. Nothing said is ever deleted (docs/SETUP.md: taking down hides).
 */
import { after } from 'next/server';
import { SEAT_DAYS } from '@/lib/db/queries/room';
import { deleteExpiredSeats, deleteIdleGuests } from '@/lib/db/queries/sweep';

const EVERY_MS = 3_600_000;
/** A guest seen once and not for this long is a card that was opened and closed. */
export const GUEST_DAYS = 30;
let last = 0;

/** Sweeps once an hour per instance, once the response has gone out. Safe to call on every request. */
export function housekeep(): void {
  const now = Date.now();
  if (now - last < EVERY_MS) return;
  last = now;
  try {
    after(() => sweep());
  } catch {
    // No request scope to hang it on: sweep anyway. The request that called this never fails for it.
    void sweep();
  }
}

export async function sweep(): Promise<void> {
  try {
    // Seats first: a guest with none left may then go, and a member row's cascade has nothing to do.
    const seats = await deleteExpiredSeats(SEAT_DAYS + 1);
    const guests = await deleteIdleGuests(GUEST_DAYS);
    if (seats || guests) console.log(`[ROOM] swept ${seats} old seats and ${guests} idle guests`);
  } catch (err) {
    console.warn('[ROOM] sweep failed', (err as Error)?.message);
  }
}

/** Test hook: the next housekeep() sweeps. */
export function forgetHousekeeping(): void {
  last = 0;
}
