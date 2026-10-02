/** The model-call ledger (generation_log): one row a call, and what today has cost. */
import { query, queryOne } from '@/lib/db';

export interface GenerationLogRow {
  purpose: string;
  /** Who the call was for, e.g. "room:one". */
  actor: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  costUsd: number;
  latencyMs: number | null;
  ok: boolean;
  errorCode: string | null;
}

export async function recordGeneration(row: GenerationLogRow): Promise<void> {
  await query(
    `INSERT INTO generation_log (purpose, actor, model, prompt_version, input_tokens, cached_input_tokens, output_tokens, cost_usd, latency_ms, ok, error_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [row.purpose, row.actor, row.model, row.promptVersion, row.inputTokens, row.cachedInputTokens, row.outputTokens, row.costUsd, row.latencyMs, row.ok, row.errorCode],
  );
}

export function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function sumCostSince(since: Date): Promise<number> {
  const r = await queryOne<{ usd: string }>(`SELECT COALESCE(SUM(cost_usd), 0)::text AS usd FROM generation_log WHERE created_at >= $1`, [since]);
  return Number(r?.usd ?? 0);
}

/** Today's calls and cost, for the editor. */
export async function todaySpend(): Promise<{ calls: number; usd: number; errors: number }> {
  const r = await queryOne<{ calls: string; usd: string; errors: string }>(
    `SELECT COUNT(*)::text AS calls, COALESCE(SUM(cost_usd),0)::text AS usd, COUNT(*) FILTER (WHERE NOT ok)::text AS errors FROM generation_log WHERE created_at >= $1`,
    [utcDayStart()],
  );
  return { calls: Number(r?.calls ?? 0), usd: Number(r?.usd ?? 0), errors: Number(r?.errors ?? 0) };
}
