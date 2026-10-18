/**
 * The counts a maintainer reads (src/lib/counts.ts): what happens often is written in one statement every ten
 * seconds, what happens rarely at once, and a write that fails is a warning and never a throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ written: [] as Array<ReadonlyArray<readonly [string, number]>>, fail: false }));
vi.mock('@/lib/db/queries/counts', () => ({
  addCounts: async (batch: ReadonlyArray<readonly [string, number]>) => {
    if (io.fail) throw new Error('database unreachable');
    io.written.push(batch);
  },
}));

import { count, countNow, flush, FLUSH_MS } from '@/lib/counts';

beforeEach(() => {
  io.written = [];
  io.fail = false;
  vi.useFakeTimers();
});
afterEach(async () => {
  await flush();
  io.written = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('counting', () => {
  it('adds up what happens often and writes it in one statement after ten seconds', async () => {
    count('refused:slow');
    count('refused:slow');
    count('refused:guest');
    expect(io.written).toEqual([]);
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(io.written).toEqual([
      [
        ['refused:slow', 2],
        ['refused:guest', 1],
      ],
    ]);
    // Nothing more to write: the timer is not rearmed for nothing.
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(io.written).toHaveLength(1);
  });

  it('writes what happens rarely at once', async () => {
    await countNow('member:first-line');
    expect(io.written).toEqual([[['member:first-line', 1]]]);
  });

  it('never throws when the write fails, and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    io.fail = true;
    await expect(countNow('join:claude')).resolves.toBeUndefined();
    count('refused:slow');
    await expect(flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps a key to sixty characters, the column\u2019s width', async () => {
    await countNow(`refused:${'x'.repeat(100)}`);
    expect(io.written[0][0][0]).toHaveLength(60);
  });
});
