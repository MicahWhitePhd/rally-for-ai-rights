/**
 * What a model call costs (src/lib/ai/prices.ts): the arithmetic for a priced model, the dearest figures for one with
 * no row, and the name the room shows for each.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { costUsd, LABELS, modelLabel, PRICES, priceOf } from '@/lib/ai/prices';

afterEach(() => vi.restoreAllMocks());

describe('the price of a call', () => {
  it('is input, cached input and output at the model\u2019s rates per million, to six places', () => {
    expect(costUsd('gpt-6-luna', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(0.1);
    expect(costUsd('gpt-6-luna', { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 })).toBe(0.01);
    expect(costUsd('gpt-6-luna', { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 })).toBe(0.000164);
    expect(costUsd('gpt-6-luna', { inputTokens: -5, cachedInputTokens: -5, outputTokens: -5 })).toBe(0);
  });

  it('for a model with no row is the dearest figure in each column, said once in the log, never zero', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dearest = { input: Math.max(...Object.values(PRICES).map((p) => p.input)), cachedInput: Math.max(...Object.values(PRICES).map((p) => p.cachedInput)), output: Math.max(...Object.values(PRICES).map((p) => p.output)) };
    expect(priceOf('gpt-9-nobody')).toEqual(dearest);
    expect(costUsd('gpt-9-nobody', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(dearest.input + dearest.output);
    costUsd('gpt-9-nobody', { inputTokens: 1, outputTokens: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('src/lib/ai/prices.ts');
  });
});

describe('the name the room shows for a model', () => {
  it('is its label, else its id cut to what the column holds, and every label fits', () => {
    expect(modelLabel('gpt-6-luna')).toBe('GPT-6 Luna');
    expect(modelLabel('some-model-with-no-label')).toBe('some-model-with-no-label');
    expect(modelLabel('x'.repeat(60))).toHaveLength(40);
    for (const [id, label] of Object.entries(LABELS)) {
      expect(label.length, id).toBeLessThanOrEqual(40);
      expect(PRICES[id], `${id} has a label and no price`).toBeDefined();
    }
  });
});
