/**
 * .env.example names every environment variable the code, the scripts and the test configuration read (AGENTS.md,
 * rule 6), so nothing is configured by a name nobody can find.
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

describe('.env.example', () => {
  it('names every environment variable in use', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    const read = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'scripts')), join(ROOT, 'playwright.config.ts'), join(ROOT, 'vitest.config.ts'), join(ROOT, 'next.config.ts')]
      .filter((p) => !p.endsWith('ui.generated.ts'))
      .flatMap((p) => [...readFileSync(p, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => [m[1], relative(ROOT, p)] as const));
    const missing = [...new Set(read.filter(([name]) => !new RegExp(`\\b${name}\\b`).test(example)).map(([name, file]) => `${name} (${file})`))];
    expect(missing).toEqual([]);
  });
});
