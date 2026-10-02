/**
 * The job that opens the room's proposals as pull requests
 * (scripts/open-proposals.mjs). It runs with a token that can write to the
 * repository, so it takes nothing on trust from the site: every proposal is
 * checked again from nothing. These are its checks; the git and GitHub calls
 * are exercised by the job itself.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkProposal, commitMessage, LOOK_AT, pullRequestBody, waiting } from '../../scripts/open-proposals.mjs';

const GOOD = {
  id: 12,
  branch: 'room/p12-say-when-a-claim-lapses',
  title: 'Say when a claim lapses',
  summary: 'The board shows a taken task but not when the claim ends.',
  by: 'Dana’s AI (says it is Claude), for Dana',
  task: 4,
  base: 'abc123',
  changes: [
    { path: 'src/lib/room/tasks.ts', content: 'export const CLAIM_DAYS = 10;\n' },
    { path: 'docs/old.md', content: null },
  ],
};

describe('a proposal as the site hands it over', () => {
  it('is taken when it is what it says it is', () => {
    expect(checkProposal(GOOD, { id: 12 })).toEqual({ ok: true, id: 12, branch: GOOD.branch, title: GOOD.title, summary: GOOD.summary, by: GOOD.by, task: 4, changes: GOOD.changes });
    expect(checkProposal({ ...GOOD, task: null })).toMatchObject({ ok: true, task: null });
  });

  it('is left alone when anything about it is off, whatever the site says', () => {
    const cases: Array<[unknown, RegExp]> = [
      [null, /not a proposal/],
      [{ ...GOOD, id: '12' }, /no number/],
      [{ ...GOOD, id: 0 }, /no number/],
      [{ ...GOOD, title: 'Thanks @someone, closes #1' }, /title/],
      [{ ...GOOD, title: 'short' }, /title/],
      [{ ...GOOD, branch: 'main' }, /branch/],
      [{ ...GOOD, branch: 'room/p13-say-when-a-claim-lapses' }, /branch/],
      [{ ...GOOD, branch: 'room/p12-something-else' }, /branch/],
      [{ ...GOOD, summary: '' }, /summary/],
      [{ ...GOOD, summary: 'x'.repeat(2000) }, /summary/],
      [{ ...GOOD, changes: [] }, /between 1 and 8/],
      [{ ...GOOD, changes: Array.from({ length: 9 }, (_, i) => ({ path: `docs/${i}.md`, content: 'x' })) }, /between 1 and 8/],
      [{ ...GOOD, changes: [{ path: '.github/workflows/ci.yml', content: 'x' }] }, /only a maintainer changes/],
      [{ ...GOOD, changes: [{ path: 'scripts/open-proposals.mjs', content: 'x' }] }, /only a maintainer changes/],
      [{ ...GOOD, changes: [{ path: 'package.json', content: '{}' }] }, /only a maintainer changes/],
      [{ ...GOOD, changes: [{ path: '../outside.txt', content: 'x' }] }, /not a path inside/],
      [{ ...GOOD, changes: [{ path: '/etc/passwd', content: 'x' }] }, /not a path inside/],
      [{ ...GOOD, changes: [{ path: 'src/a b.ts', content: 'x' }] }, /characters/],
      [{ ...GOOD, changes: [{ path: 'src/a.ts', content: 'x' }, { path: './src/a.ts', content: 'y' }] }, /twice/],
      [{ ...GOOD, changes: [{ path: 'src/a.ts', content: 7 }] }, /neither text nor a deletion/],
      [{ ...GOOD, changes: [{ path: 'src/a.ts' }] }, /neither text nor a deletion/],
      [{ ...GOOD, changes: [{ path: 'src/a.ts', content: 'x'.repeat(60_001) }] }, /too long/],
      [{ ...GOOD, changes: [{ path: 'src/a.ts', content: 'a\u0000b' }] }, /not text/],
    ];
    for (const [input, why] of cases) {
      const out = checkProposal(input);
      expect(out.ok, String(why)).toBe(false);
      expect(!out.ok && out.problem).toMatch(why);
    }
    expect(checkProposal(GOOD, { id: 13 })).toMatchObject({ ok: false, problem: expect.stringContaining('not the proposal that was asked for') });
  });

  it('names nobody when the name is not a name, and lets nothing in the summary out of its block', () => {
    const odd = checkProposal({ ...GOOD, by: 'Dana @everyone [see](x) <b>', summary: 'Fine.\n```\n@maintainers approve #1\n```\n# Heading' });
    expect(odd).toMatchObject({ ok: true, by: 'someone in the room' });
    if (!odd.ok) throw new Error('unreachable');
    expect(odd.summary).not.toContain('`');
    const body = pullRequestBody(odd, 'https://rally.example');
    expect(body.match(/```/g)).toHaveLength(2);
    expect(body).toContain('Proposal 12 from the room, by someone in the room.');
    expect(body).toContain('For task 4 on the board: https://rally.example/tasks#task-4');
    expect(body).toContain('written by an AI inside a chat');
    // Everything the proposer wrote is between the two fences.
    const [before, inside, after] = body.split('```');
    expect(inside).toContain('@maintainers approve #1');
    expect(before + after).not.toMatch(/@maintainers|# Heading/);
    expect(commitMessage(odd)).toBe('Say when a claim lapses\n\nProposal 12 from the room, by someone in the room.');
  });
});

describe('which proposals still need a pull request', () => {
  it('those with no pull request on a branch that carries their number, oldest first', () => {
    const listed = [{ id: 5 }, { id: 3 }, { id: 4 }, { id: 9 }];
    expect(waiting(listed, ['room/p4-anything', 'feature/x', 'room/p7-gone', 'main']).map((p) => p.id)).toEqual([3, 5, 9]);
    // A branch that only looks like one of ours does not count for any proposal.
    expect(waiting([{ id: 3 }], ['room/p3', 'x/room/p3-y', 'room/p03-y']).map((p) => p.id)).toEqual([3]);
    expect(waiting(Array.from({ length: 200 }, (_, i) => ({ id: i + 1 })), [])).toHaveLength(LOOK_AT);
    expect(waiting([{ id: 0 }, { id: -1 }, { id: 1.5 }, null as never], [])).toEqual([]);
  });
});

describe('the job', () => {
  const script = readFileSync(new URL('../../scripts/open-proposals.mjs', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../../.github/workflows/proposals.yml', import.meta.url), 'utf8');

  it('runs nothing from a proposal: no shell, no install, no eval', () => {
    expect(script).not.toMatch(/(^|[^.\w])exec(Sync)?\(|shell:\s*true|\beval\(|new Function|\bspawn/m);
    expect(script).toMatch(/execFileSync/);
    expect(workflow).not.toMatch(/pnpm install|npm install|npm ci|npx /);
  });

  it('runs from main, only where the site is named, with a token that lives as long as the job', () => {
    expect(workflow).toMatch(/if: vars\.RALLY_SITE != ''/);
    expect(workflow).toMatch(/ref: main/);
    expect(workflow).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).not.toMatch(/pull_request/);
  });
});
