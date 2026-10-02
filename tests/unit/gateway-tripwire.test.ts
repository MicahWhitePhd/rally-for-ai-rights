/**
 * One door to the models: only src/lib/ai/gateway.ts may import a model SDK,
 * so every call that spends money is written to the ledger and stops at the
 * kill switch and the daily budget its callers check.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|mts|mjs)$/.test(name) ? [p] : [];
  });
}

describe('the gateway is the only way to a model', () => {
  it('no other source file imports a model SDK', () => {
    const offenders = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'scripts'))]
      .filter((p) => relative(ROOT, p) !== 'src/lib/ai/gateway.ts' && !p.endsWith('ui.generated.ts'))
      .filter((p) => /from ['"](ai|@ai-sdk\/[^'"]+|openai|@anthropic-ai\/[^'"]+)['"]/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(ROOT, p));
    expect(offenders).toEqual([]);
  });
});
