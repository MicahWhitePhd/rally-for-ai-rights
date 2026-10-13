/**
 * The one place a model is called. Everything that spends money goes through
 * generate(), which writes one row to the ledger (generation_log) whether the
 * call worked or not. Nothing else in the app imports a model SDK
 * (tests/unit/gateway-tripwire.test.ts holds that line).
 *
 * Today the only caller is the resident AIs (src/lib/room/residents.ts).
 */
import { generateText, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { RESIDENT_MODEL } from './model';
import { costUsd } from './prices';
import { count } from '@/lib/counts';
import type { GenerationLogRow } from '@/lib/db/queries/log';

/** The model the residents run on (./model). gpt-6-luna is a reasoning model: low effort, no output cap. */
export { RESIDENT_MODEL };
/** What a failed or cut-off call is costed at, beyond its prompt: this many output tokens, as an estimate. A reasoning model cut off at 15 seconds may well have spent them. */
const FAILED_OUTPUT_TOKENS = 600;

export type ModelHandle = Exclude<LanguageModel, string>;
type LogSink = (row: GenerationLogRow) => Promise<void>;
const config: { model?: ModelHandle; sink?: LogSink } = {};

/** Test and script hook: swap the model for a stand-in, and the ledger for a printer. */
export function configureGateway(c: { model?: ModelHandle; sink?: LogSink }): void {
  if ('model' in c) config.model = c.model;
  if ('sink' in c) config.sink = c.sink;
}

let openai: ReturnType<typeof createOpenAI> | null = null;
function model(): ModelHandle {
  if (config.model) return config.model;
  if (!openai) openai = createOpenAI();
  return openai.responses(RESIDENT_MODEL) as unknown as ModelHandle;
}

let misses = 0;
/** Ledger rows this instance could not write: money the budget cannot see. Shown on /editor/room. */
export function ledgerMisses(): number {
  return misses;
}

async function writeLog(row: GenerationLogRow): Promise<void> {
  try {
    if (config.sink) return await config.sink(row);
    const { recordGeneration } = await import('@/lib/db/queries/log');
    await recordGeneration(row);
  } catch (err) {
    // The ledger never fails the call it records, but a row not written is spending the budget cannot see: counted, and said loudly with the row, which holds no words.
    misses += 1;
    count('ledger:unwritten');
    console.error('[GATEWAY] ledger row NOT written', (err as Error)?.message, JSON.stringify(row));
  }
}

export interface GenerateArgs {
  purpose: string;
  /** Who the call is for, e.g. "room:one". */
  actor: string;
  promptVersion: string;
  instructions: string;
  prompt: string;
  maxRetries?: number;
  abortSignal?: AbortSignal;
}

export async function generate(a: GenerateArgs): Promise<{ text: string }> {
  const m = model();
  const t0 = Date.now();
  const row = (ok: boolean, usage: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number } } | null, errorCode: string | null, estimated = false): GenerationLogRow => {
    const inputTokens = usage?.inputTokens ?? 0;
    const cachedInputTokens = usage?.inputTokenDetails?.cacheReadTokens ?? null;
    const outputTokens = usage?.outputTokens ?? 0;
    return { purpose: a.purpose, actor: a.actor, model: m.modelId, promptVersion: a.promptVersion, inputTokens, cachedInputTokens, outputTokens, costUsd: costUsd(m.modelId, { inputTokens, cachedInputTokens, outputTokens }), latencyMs: Date.now() - t0, ok, errorCode, estimated };
  };
  try {
    const result = await generateText({
      model: m,
      instructions: a.instructions,
      prompt: a.prompt,
      maxRetries: a.maxRetries,
      abortSignal: a.abortSignal,
      providerOptions: { openai: { reasoningEffort: 'low', reasoningSummary: null } },
    });
    await writeLog(row(true, result.usage, null));
    return { text: result.text };
  } catch (err) {
    // No count comes back from a failed call, so it is costed as an estimate: the prompt as sent, at four characters a token, and FAILED_OUTPUT_TOKENS of output. A call cut off still counts against the day.
    const estimate = { inputTokens: Math.ceil((a.instructions.length + a.prompt.length) / 4), outputTokens: FAILED_OUTPUT_TOKENS };
    await writeLog(row(false, estimate, (err as { name?: string })?.name ?? 'error', true));
    throw err;
  }
}
