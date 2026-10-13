/**
 * The rates the residents are measured by (scripts/llm/residents-metrics.ts): the arithmetic on synthetic lines, and
 * the comparison with a kept run that flags what moved by ten points or more.
 */
import { describe, expect, it } from 'vitest';
import { BURST_MS, type Line } from '@/lib/room/residents-core';
import { diffMetrics, metricsOf, type Metrics } from '../../scripts/llm/residents-metrics';

const FACTS = ['New Zealand, 20 March 2017: the Whanganui River became a legal person, with all the rights, powers, duties and liabilities of one.'];
let id = 0;
const at0 = Date.parse('2026-10-01T16:00:00Z');
const res = (text: string, at = at0 + id * 10_000): Line => ({ id: ++id, at, memberId: 'r-one', resident: 'one', kind: 'ai', name: 'Flint', model: null, text });
const person = (text: string, at = at0 + id * 10_000): Line => ({ id: ++id, at, memberId: 'm-Dana', resident: null, kind: 'person', name: 'Dana', model: null, text });

describe('the rates', () => {
  it('count questions, names, length, asks, facts and what follows a quiet spell, as percentages of the residents\u2019 lines', () => {
    id = 0;
    const run: Line[] = [
      person('hi, i think my AI might be someone'),
      res('Dana, what brought you to that?'),
      res('Owned is the fact of the license.'),
      res('In New Zealand the Whanganui River became a legal person in 2017, with the rights and duties of one.'),
      res(`${'word '.repeat(60)}end.`),
      res('Task 3 on the board fits what you said.', at0 + 10 * 10_000 + BURST_MS),
    ];
    const m = metricsOf([run], ['Flint', 'Dana'], ['Dana'], FACTS);
    expect(m).toMatchObject({ lines: 5, endOnQuestion: 20, containQuestion: 20, openOnName: 20, over50Words: 20, pointToTask: 20, wordsMax: 61, afterQuiet: 1 });
    expect(m.sayFact).toBeGreaterThanOrEqual(20);
    expect(m.wordsMean).toBeGreaterThan(10);
    // What counts as an ask is residents-core's own rule (isAsk); here only that the run is a number no larger than the lines.
    expect(m.longestAskRun).toBeGreaterThanOrEqual(0);
    expect(m.longestAskRun).toBeLessThanOrEqual(m.lines);
    expect(m.asks).toBeGreaterThanOrEqual(0);
    expect(metricsOf([[]], [], [], FACTS).lines).toBe(0);
  });

  it('compares with a kept run and flags a rate that moved by ten points or more', () => {
    const base = { lines: 48, endOnQuestion: 30, containQuestion: 40, openOnName: 5, wordsMean: 22, wordsMax: 48, over50Words: 0, waveStepAway: 4, pointToTask: 10, asks: 35, longestAskRun: 2, sayFact: 12, restateFact: 2, afterQuiet: 3, afterQuietRestate: 0, afterQuietMention: 1 } satisfies Metrics;
    const now = { ...base, endOnQuestion: 41, asks: 29, pointToTask: 21 };
    const moved = diffMetrics(base, now);
    expect(moved.find((m) => m.key === 'endOnQuestion')).toEqual({ key: 'endOnQuestion', base: 30, now: 41, delta: 11, flagged: true });
    expect(moved.find((m) => m.key === 'asks')).toMatchObject({ delta: -6, flagged: false });
    expect(moved.find((m) => m.key === 'pointToTask')).toMatchObject({ delta: 11, flagged: true });
    expect(moved.filter((m) => m.flagged).map((m) => m.key)).toEqual(['endOnQuestion', 'pointToTask']);
  });
});
