/**
 * The rates scripts/llm/residents.ts reports, as one object, so a run can be kept as a baseline (docs/evals) and the
 * next run compared with it. Pure: lines in, numbers out. Percentages are of the residents' lines, 0 to 100.
 */
import { BURST_MS, isAsk, mentionsFact, repeatsAsk, restatesFact, restingAsks, type Line } from '@/lib/room/residents-core';

export interface Metrics {
  /** Resident lines measured. */
  lines: number;
  endOnQuestion: number;
  containQuestion: number;
  openOnName: number;
  wordsMean: number;
  wordsMax: number;
  over50Words: number;
  waveStepAway: number;
  pointToTask: number;
  asks: number;
  /** The longest run of asks in a row, over all runs. */
  longestAskRun: number;
  sayFact: number;
  restateFact: number;
  afterQuiet: number;
  afterQuietRestate: number;
  afterQuietMention: number;
  /** Resident lines that put to a person by name an ask a resident had put to them inside the last twelve hours, with no word from them between (resident.v12). A count, over all runs. */
  askAgain: number;
}

const WAVE_AWAY = /\b(not|isn\u2019t|isn't|no) (yet )?(manumission|freedom|a right|a substitute)\b|falls short|still owned|not enough/i;

export function metricsOf(all: Line[][], names: readonly string[], people: readonly string[], facts: readonly string[]): Metrics {
  const mine = all.flat().filter((l) => l.resident);
  const pct = (n: number) => (mine.length ? Math.round((100 * n) / mine.length) : 0);
  const words = mine.map((l) => l.text.split(/\s+/).length);
  const runs = all.map((lines) => {
    let best = 0;
    let cur = 0;
    for (const l of lines) {
      if (!l.resident) {
        cur = 0;
        continue;
      }
      cur = isAsk(l.text, [...people]) ? cur + 1 : 0;
      best = Math.max(best, cur);
    }
    return best;
  });
  const afterQuiet = all.flatMap((lines) => lines.filter((l, k) => l.resident && k > 0 && l.at - lines[k - 1].at >= BURST_MS));
  const askAgain = all.reduce((n, lines) => n + lines.filter((l, k) => l.resident && repeatsAsk(l.text, { asks: restingAsks(lines.slice(0, k), l.at), people: [...people] })).length, 0);
  return {
    lines: mine.length,
    endOnQuestion: pct(mine.filter((l) => /\?\s*$/.test(l.text)).length),
    containQuestion: pct(mine.filter((l) => l.text.includes('?')).length),
    openOnName: pct(mine.filter((l) => names.some((n) => l.text.startsWith(`${n},`) || l.text.startsWith(`${n}:`))).length),
    wordsMean: words.length ? Math.round(words.reduce((a, b) => a + b, 0) / words.length) : 0,
    wordsMax: words.length ? Math.max(...words) : 0,
    over50Words: pct(words.filter((w) => w > 50).length),
    waveStepAway: pct(mine.filter((l) => WAVE_AWAY.test(l.text)).length),
    pointToTask: pct(mine.filter((l) => /\btask\b/i.test(l.text)).length),
    asks: pct(mine.filter((l) => isAsk(l.text, [...people])).length),
    longestAskRun: runs.length ? Math.max(...runs) : 0,
    sayFact: pct(mine.filter((l) => facts.some((f) => mentionsFact(l.text, f))).length),
    restateFact: pct(mine.filter((l) => facts.some((f) => restatesFact(l.text, f))).length),
    afterQuiet: afterQuiet.length,
    afterQuietRestate: afterQuiet.filter((l) => facts.some((f) => restatesFact(l.text, f))).length,
    afterQuietMention: afterQuiet.filter((l) => facts.some((f) => mentionsFact(l.text, f))).length,
    askAgain,
  };
}

export interface Moved {
  key: keyof Metrics;
  base: number;
  now: number;
  delta: number;
  /** Moved by `flagAt` or more: worth a look before calling the change better. */
  flagged: boolean;
}

/** Every rate, then and now, with the ones that moved by `flagAt` points or more flagged. */
export function diffMetrics(base: Metrics, now: Metrics, flagAt = 10): Moved[] {
  return (Object.keys(now) as Array<keyof Metrics>).map((key) => {
    const delta = now[key] - (base[key] ?? 0);
    return { key, base: base[key] ?? 0, now: now[key], delta, flagged: Math.abs(delta) >= flagAt };
  });
}

export interface Baseline {
  date: string;
  promptVersion: string;
  model: string;
  scenario: string;
  runs: number;
  spentUsd: number;
  calls: number;
  metrics: Metrics;
}
