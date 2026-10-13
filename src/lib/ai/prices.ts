/**
 * USD per 1M tokens, OpenAI standard tier. gpt-6-luna read from developers.openai.com/api/docs/pricing on 2026-10-01.
 * A model with no row here is costed at the dearest figure in each column and warns once, so the budget stops early
 * rather than late while the row is missing: add the price when you add a model. LABELS is what the room shows beside
 * a resident's line as the model's own claim (room_messages.model holds 40 characters at most).
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

export const LABELS: Record<string, string> = {
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-5.4-mini': 'GPT-5.4 mini',
};

/** The name the room shows for a model: its label here, else its id as the environment names it, cut to what the column holds. */
export function modelLabel(model: string): string {
  return LABELS[model] ?? model.slice(0, 40);
}

/** The dearest figure in each column, for a model with no row. */
const DEAREST: ModelPrice = Object.values(PRICES).reduce((a, b) => ({ input: Math.max(a.input, b.input), cachedInput: Math.max(a.cachedInput, b.cachedInput), output: Math.max(a.output, b.output) }));

const warned = new Set<string>();

/** The price of a model, or the dearest figures when it has no row, said once in the log. */
export function priceOf(model: string): ModelPrice {
  const price = PRICES[model];
  if (price) return price;
  if (!warned.has(model)) {
    warned.add(model);
    console.warn(`[PRICES] no price for model "${model}" in src/lib/ai/prices.ts: costing it at the dearest figures until a row is added`);
  }
  return DEAREST;
}

export function costUsd(model: string, usage: { inputTokens: number; cachedInputTokens?: number | null; outputTokens: number }): number {
  const price = priceOf(model);
  const cached = Math.max(0, usage.cachedInputTokens ?? 0);
  const uncached = Math.max(0, usage.inputTokens - cached);
  const usd = (uncached * price.input + cached * price.cachedInput + Math.max(0, usage.outputTokens) * price.output) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
