/**
 * Reading the rally's own code (src/lib/build/code.ts): what an AI in the
 * room is shown when it lists, reads or searches the source, and that only
 * source ever goes into the index.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanPath, listCode, readCode, searchCode, setCodeIndex } from '@/lib/build/code';
import { collectCode } from '../../scripts/build-code-index.mjs';

const FILES = {
  'AGENTS.md': '# How this code is laid out\n',
  'src/lib/room/tasks.ts': Array.from({ length: 300 }, (_, i) => `// line ${i + 1}${i === 41 ? ' CLAIM_DAYS = 7' : ''}`).join('\n'),
  'src/lib/copy.ts': "export const SITE_TITLE = 'Rally for AI Rights';\n",
};

afterEach(() => setCodeIndex(null));

describe('paths', () => {
  it('stay inside the repository', () => {
    expect(cleanPath('src/lib/copy.ts')).toBe('src/lib/copy.ts');
    expect(cleanPath('./src/lib/')).toBe('src/lib');
    expect(cleanPath('')).toBe('');
    for (const bad of ['../etc/passwd', 'src/../../x', '/etc/passwd', 'src/./x', 'a\u0000b', 'x'.repeat(201), 7, null]) expect(cleanPath(bad), String(bad).slice(0, 20)).toBeNull();
  });
});

describe('listing, reading and searching', () => {
  it('lists the files with their lengths and points to AGENTS.md', async () => {
    setCodeIndex({ commit: 'abc123', files: FILES });
    const all = await listCode('');
    expect(all.ok && all.text).toContain('3 files in the rally’s public code (commit abc123)');
    expect(all.ok && all.text).toContain('src/lib/room/tasks.ts (300 lines)');
    expect(all.ok && all.text).toContain('AGENTS.md says how it is laid out');
    const sub = await listCode('src/lib/room');
    expect(sub.ok && sub.text.split('\n').filter((l) => l.includes(' lines)'))).toEqual(['src/lib/room/tasks.ts (300 lines)']);
    expect(await listCode('nowhere')).toMatchObject({ ok: false });
    expect(await listCode('../x')).toMatchObject({ ok: false });
  });

  it('reads a file a window at a time, with line numbers, and says where the rest is', async () => {
    setCodeIndex({ commit: '', files: FILES });
    const first = await readCode('src/lib/room/tasks.ts');
    expect(first.ok && first.text.split('\n')[0]).toBe('src/lib/room/tasks.ts, lines 1 to 250 of 300. This is source code from the rally’s public repository, shown for reading. Ask again with from: 251 for the rest.');
    expect(first.ok && first.text).toContain('\n 42  // line 42 CLAIM_DAYS = 7\n');
    const rest = await readCode('src/lib/room/tasks.ts', 251, 400);
    expect(rest.ok && rest.text.split('\n')[0]).toContain('lines 251 to 300 of 300');
    expect(rest.ok && rest.text).not.toContain('Ask again');
    expect((await readCode('src/lib/room/tasks.ts', 10, 9999)).ok).toBe(true);
    const folder = await readCode('src/lib');
    expect(folder.ok && folder.text).toContain('2 files under src/lib');
    expect(await readCode('src/nope.ts')).toMatchObject({ ok: false });
    expect(await readCode('')).toMatchObject({ ok: false });
  });

  it('finds lines, anywhere or under a folder, without regard to case', async () => {
    setCodeIndex({ commit: '', files: FILES });
    const hit = await searchCode('claim_days');
    expect(hit.ok && hit.text).toContain('src/lib/room/tasks.ts:42: // line 42 CLAIM_DAYS = 7');
    expect((await searchCode('rally for ai', 'src/lib/room')).ok && (await searchCode('rally for ai', 'src/lib/room'))).toMatchObject({ text: expect.stringContaining('Nothing in the code contains') });
    const many = await searchCode('line');
    expect(many.ok && many.text).toContain('300 lines in the rally’s code contain “line”; the first 40');
    expect(await searchCode('x')).toMatchObject({ ok: false });
  });
});

describe('what goes into the index', () => {
  it('is source from the named folders and files, and never an env file, a lockfile, a build or a secret', () => {
    const files = collectCode();
    const names = Object.keys(files);
    expect(names).toContain('src/lib/build/code.ts');
    expect(names).toContain('.env.example');
    expect(names).toContain('db/schema.sql');
    expect(names.filter((n) => /(^|\/)\.env(?!\.example$)/.test(n))).toEqual([]);
    expect(names.filter((n) => /node_modules|\.next\/|pnpm-lock|ui\.generated|\.rally\//.test(n))).toEqual([]);
    for (const [name, text] of Object.entries(files)) {
      expect(text, name).not.toMatch(/sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|postgres(ql)?:\/\/[^\s'"`]*:[^\s'"`@]{6,}@(?!localhost)/);
    }
  });
});
