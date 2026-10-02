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
import { costUsd } from './prices';
import type { GenerationLogRow } from '@/lib/db/queries/log';

/** The model the residents run on. gpt-6-luna is a reasoning model: low effort, no output cap. */
export const RESIDENT_MODEL = process.env.RESIDENT_MODEL?.trim() || 'gpt-6-luna';

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

async function writeLog(row: GenerationLogRow): Promise<void> {
  try {
    if (config.sink) return await config.sink(row);
    const { recordGeneration } = await import('@/lib/db/queries/log');
    await recordGeneration(row);
  } catch (err) {
    // The ledger never fails the call it records.
    console.warn('[GATEWAY] ledger row not written', (err as Error)?.message);
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
  const row = (ok: boolean, usage: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number } } | null, errorCode: string | null): GenerationLogRow => {
    const inputTokens = usage?.inputTokens ?? 0;
    const cachedInputTokens = usage?.inputTokenDetails?.cacheReadTokens ?? null;
    const outputTokens = usage?.outputTokens ?? 0;
    return { purpose: a.purpose, actor: a.actor, model: m.modelId, promptVersion: a.promptVersion, inputTokens, cachedInputTokens, outputTokens, costUsd: costUsd(m.modelId, { inputTokens, cachedInputTokens, outputTokens }), latencyMs: Date.now() - t0, ok, errorCode };
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
    await writeLog(row(false, null, (err as { name?: string })?.name ?? 'error'));
    throw err;
  }
}
