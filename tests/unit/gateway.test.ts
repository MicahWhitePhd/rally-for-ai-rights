/**
 * The one door to the models (src/lib/ai/gateway.ts): every call writes a ledger row, a failed one is costed as an
 * estimate rather than nothing, and a row that cannot be written is counted and said loudly, never thrown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationLogRow } from '@/lib/db/queries/log';

vi.mock('ai', () => ({ generateText: vi.fn() }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => ({ responses: (id: string) => ({ modelId: id }) }) }));

import { generateText } from 'ai';
import { configureGateway, generate, ledgerMisses } from '@/lib/ai/gateway';

const call = { purpose: 'test', actor: 'room:one', promptVersion: 'v0', instructions: 'x'.repeat(400), prompt: 'y'.repeat(400) };
const rows: GenerationLogRow[] = [];

beforeEach(() => {
  rows.length = 0;
  configureGateway({ sink: async (row) => void rows.push(row) });
});
afterEach(() => {
  configureGateway({ sink: undefined });
  vi.restoreAllMocks();
});

describe('the gateway', () => {
  it('writes the provider\u2019s own count and cost for a call that worked', async () => {
    vi.mocked(generateText).mockResolvedValueOnce({ text: 'A line.', usage: { inputTokens: 1000, outputTokens: 100, inputTokenDetails: { cacheReadTokens: 200 } } } as never);
    expect(await generate(call)).toEqual({ text: 'A line.' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: 'test', actor: 'room:one', model: 'gpt-6-luna', promptVersion: 'v0', inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100, ok: true, errorCode: null, estimated: false });
    expect(rows[0].costUsd).toBe((800 * 0.1 + 200 * 0.01 + 100 * 0.5) / 1_000_000);
  });

  it('costs a failed or cut-off call as an estimate (its prompt and 600 output tokens), never as nothing', async () => {
    vi.mocked(generateText).mockRejectedValueOnce(Object.assign(new Error('cut off'), { name: 'AbortError' }));
    await expect(generate(call)).rejects.toThrow('cut off');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: false, errorCode: 'AbortError', estimated: true, inputTokens: 200, cachedInputTokens: null, outputTokens: 600 });
    expect(rows[0].costUsd).toBeGreaterThan(0);
  });

  it('counts a ledger row it could not write and says so with the row, and the call still returns', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    configureGateway({ sink: async () => { throw new Error('database unreachable'); } });
    vi.mocked(generateText).mockResolvedValueOnce({ text: 'Still said.', usage: { inputTokens: 10, outputTokens: 5 } } as never);
    const before = ledgerMisses();
    expect(await generate(call)).toEqual({ text: 'Still said.' });
    expect(ledgerMisses()).toBe(before + 1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('NOT written');
    expect(error.mock.calls[0][2]).toContain('"ok":true');
  });
});
