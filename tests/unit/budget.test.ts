/**
 * The two brakes on spending (src/lib/budget.ts): the kill switch as a row or as the environment, read at most every
 * thirty seconds and paused when it cannot be read; and the daily budget, checked before a call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = { settings: new Map<string, unknown>(), spent: 0, fail: false };
vi.mock('@/lib/db/queries/settings', () => ({
  getSetting: async (key: string, fallback: unknown) => {
    if (io.fail) throw new Error('settings unreachable');
    return io.settings.has(key) ? io.settings.get(key) : fallback;
  },
}));
vi.mock('@/lib/db/queries/log', () => ({
  sumCostSince: async () => io.spent,
  utcDayStart: () => new Date(0),
}));

import { budgetAllows, dailyBudgetUsd, envHardPause, forgetBudget, isPaused, killSwitchSet } from '@/lib/budget';

beforeEach(() => {
  io.settings.clear();
  io.spent = 0;
  io.fail = false;
  forgetBudget();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the kill switch', () => {
  it('in the environment: anything but empty, 0, false or off pauses', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'paused']) {
      vi.stubEnv('GENERATION_HARD_PAUSE', v);
      expect(envHardPause(), v).toBe(true);
    }
    for (const v of ['', '0', 'false', 'off', ' ']) {
      vi.stubEnv('GENERATION_HARD_PAUSE', v);
      expect(envHardPause(), JSON.stringify(v)).toBe(false);
    }
  });

  it('as a row: a bare boolean or {paused}, read now by killSwitchSet and at most every thirty seconds by isPaused', async () => {
    expect(await isPaused()).toBe(false);
    io.settings.set('kill_switch', { paused: true });
    expect(await killSwitchSet()).toBe(true);
    // Memoised: the pull is seen once the memo is thirty seconds old.
    expect(await isPaused()).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(await isPaused()).toBe(true);
    io.settings.set('kill_switch', false);
    forgetBudget();
    expect(await isPaused()).toBe(false);
    io.settings.set('kill_switch', true);
    forgetBudget();
    expect(await isPaused()).toBe(true);
  });

  it('counts as pulled when it cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    io.fail = true;
    expect(await isPaused()).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('the daily budget', () => {
  it('is two dollars unless a row says otherwise, as a number or a string', async () => {
    expect(await dailyBudgetUsd()).toBe(2);
    io.settings.set('daily_budget_usd', '5');
    expect(await dailyBudgetUsd()).toBe(5);
    io.settings.set('daily_budget_usd', 0.5);
    expect(await dailyBudgetUsd()).toBe(0.5);
  });

  it('allows a call while what is spent plus the estimate fits, to the cent', async () => {
    io.spent = 1.998;
    expect(await budgetAllows(0.002)).toEqual({ ok: true, spent: 1.998, budget: 2 });
    expect((await budgetAllows(0.003)).ok).toBe(false);
    io.settings.set('daily_budget_usd', 0);
    expect((await budgetAllows(0.002)).ok).toBe(false);
  });
});
