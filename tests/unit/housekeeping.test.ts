/**
 * Housekeeping (src/lib/housekeeping.ts): at most once an hour per instance, seats before guests, after the response,
 * and a failure is a warning and never a throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ calls: [] as string[], fail: false, deferred: [] as Array<() => unknown> }));
vi.mock('next/server', () => ({ after: (fn: () => unknown) => void io.deferred.push(fn) }));
vi.mock('@/lib/db/queries/room', () => ({ SEAT_DAYS: 7 }));
vi.mock('@/lib/db/queries/sweep', () => ({
  deleteExpiredSeats: async (days: number) => {
    if (io.fail) throw new Error('database unreachable');
    io.calls.push(`seats:${days}`);
    return 2;
  },
  deleteIdleGuests: async (days: number) => {
    io.calls.push(`guests:${days}`);
    return 0;
  },
}));

import { forgetHousekeeping, GUEST_DAYS, housekeep } from '@/lib/housekeeping';

/** Runs what was put off until after the response. */
const afterResponse = async () => {
  for (const fn of io.deferred.splice(0)) await fn();
};

beforeEach(() => {
  io.calls = [];
  io.fail = false;
  io.deferred = [];
  forgetHousekeeping();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('housekeeping', () => {
  it('sweeps once an hour per instance, after the response, seats a day past their days first and then idle guests', async () => {
    housekeep();
    expect(io.calls).toEqual([]);
    await afterResponse();
    expect(io.calls).toEqual(['seats:8', `guests:${GUEST_DAYS}`]);
    housekeep();
    await afterResponse();
    expect(io.calls).toHaveLength(2);
    vi.advanceTimersByTime(3_600_000);
    housekeep();
    await afterResponse();
    expect(io.calls).toHaveLength(4);
  });

  it('a sweep that fails is a warning, and the next hour tries again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    io.fail = true;
    housekeep();
    await expect(afterResponse()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(io.calls).toEqual([]);
  });
});
