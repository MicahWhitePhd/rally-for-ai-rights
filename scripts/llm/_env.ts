/**
 * Shared bootstrap for scripts: loads .env.local from the repo root, parses
 * --no-db, and when no database is in play sends the gateway's ledger rows to
 * stdout instead.
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { configureGateway } from '@/lib/ai/gateway';

config({ path: resolve(import.meta.dirname ?? '.', '../../.env.local'), override: false });

export const args = process.argv.slice(2);
export const flag = (name: string): boolean => args.includes(`--${name}`);
export const opt = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

export const NO_DB = flag('no-db') || !process.env.DATABASE_URL;

export const spend = { usd: 0, calls: 0 };

if (NO_DB) {
  configureGateway({
    sink: async (row) => {
      spend.usd += row.costUsd;
      spend.calls++;
      console.log(`[generation_log] ${row.purpose} ${row.model} in=${row.inputTokens}${row.cachedInputTokens ? ` (cached ${row.cachedInputTokens})` : ''} out=${row.outputTokens} $${row.costUsd.toFixed(5)} ${row.latencyMs}ms ok=${row.ok}${row.errorCode ? ` err=${row.errorCode}` : ''}`);
    },
  });
}

export function requireKey(): void {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY missing (expected in .env.local at the repo root)');
    process.exit(1);
  }
}
