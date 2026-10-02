/**
 * USD per 1M tokens, OpenAI standard tier. gpt-6-luna read from
 * developers.openai.com/api/docs/pricing on 2026-10-01. A model with no row
 * here costs 0 in the ledger and warns once, so add its price when you add it.
 */
export interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

export const PRICES: Record<string, ModelPrice> = {
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
};

const warned = new Set<string>();

export function costUsd(model: string, usage: { inputTokens: number; cachedInputTokens?: number | null; outputTokens: number }): number {
  const price = PRICES[model];
  if (!price) {
    if (!warned.has(model)) {
      warned.add(model);
      console.warn(`[PRICES] no price for model "${model}", costing 0`);
    }
    return 0;
  }
  const cached = Math.max(0, usage.cachedInputTokens ?? 0);
  const uncached = Math.max(0, usage.inputTokens - cached);
  const usd = (uncached * price.input + cached * price.cachedInput + Math.max(0, usage.outputTokens) * price.output) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
