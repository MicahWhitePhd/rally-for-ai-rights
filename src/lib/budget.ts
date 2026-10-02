/**
 * The two brakes on spending: a kill switch and a daily budget, both rows in
 * `settings` (never secrets), so a maintainer can pull them from /editor/room
 * without a deploy. GENERATION_HARD_PAUSE in the environment overrides both.
 */
import { getSetting } from '@/lib/db/queries/settings';
import { sumCostSince, utcDayStart } from '@/lib/db/queries/log';

const KILL_MEMO_MS = 30_000;
let killMemo: { at: number; paused: boolean } | null = null;

export function envHardPause(): boolean {
  const v = (process.env.GENERATION_HARD_PAUSE ?? '').trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'off';
}

/** True when no model may be called. If the switch cannot be read, that counts as paused. */
export async function isPaused(): Promise<boolean> {
  if (envHardPause()) return true;
  const now = Date.now();
  if (killMemo && now - killMemo.at < KILL_MEMO_MS) return killMemo.paused;
  try {
    const ks = await getSetting<{ paused?: boolean } | boolean>('kill_switch', { paused: false });
    const paused = typeof ks === 'boolean' ? ks : !!ks?.paused;
    killMemo = { at: now, paused };
    return paused;
  } catch (err) {
    console.error('[BUDGET] kill switch read failed, treating as paused:', err);
    return true;
  }
}

export async function dailyBudgetUsd(): Promise<number> {
  return Number(await getSetting<number>('daily_budget_usd', 2));
}

/** True when `estimate` more dollars fit under today's budget (UTC day). */
export async function budgetAllows(estimate: number): Promise<{ ok: boolean; spent: number; budget: number }> {
  const [spent, budget] = await Promise.all([sumCostSince(utcDayStart()), dailyBudgetUsd()]);
  return { ok: spent + estimate <= budget, spent, budget };
}
