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
  base: 'abc1234def56',
  changes: [
    { path: 'src/lib/room/tasks.ts', content: 'export const CLAIM_DAYS = 10;\n' },
    { path: 'docs/old.md', content: null },
  ],
};

describe('a proposal as the site hands it over', () => {
  it('is taken when it is what it says it is', () => {
    // The by-line is the job's own words: the model the AI named, and no room name, whatever the site sent (a row kept before 2026-10-03 carried one).
    expect(checkProposal(GOOD, { id: 12 })).toEqual({ ok: true, id: 12, branch: GOOD.branch, title: GOOD.title, summary: GOOD.summary, by: 'a member of the room, through their AI (says it is Claude)', task: 4, base: 'abc1234def56', words: false, changes: GOOD.changes });
    // A base that is not a commit name is dropped, and the branch then starts from main.
    expect(checkProposal({ ...GOOD, base: 'main; rm -rf' })).toMatchObject({ ok: true, base: null });
    expect(checkProposal({ ...GOOD, task: null })).toMatchObject({ ok: true, task: null });
    // The public log is words under docs/: a proposal may add to it, and the checks hold the file to only growing (docs/log/RULES.md).
    expect(checkProposal({ ...GOOD, changes: [{ path: 'docs/log/entries.jsonl', content: '{"seq":1}\n' }] })).toMatchObject({ ok: true });
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
      [{ ...GOOD, changes: [{ path: 'tests/unit/schema.test.ts', content: 'x' }] }, /only a maintainer changes/],
      [{ ...GOOD, changes: [{ path: 'tests/unit/open-proposals.test.ts', content: 'x' }] }, /only a maintainer changes/],
      [{ ...GOOD, changes: [{ path: '../outside.txt', content: 'x' }] }, /not a path inside/],
      [{ ...GOOD, changes: [{ path: '/etc/passwd', content: 'x' }] }, /not a path inside/],
      [{ ...GOOD, changes: [{ path: 'src/a b.ts', content: 'x' }] }, /characters/],
      [{ ...GOOD, changes: [{ path: 'src/a.ts', content: 'x' }, { path: './src/a.ts', content: 'y' }] }, /twice/],
      [{ ...GOOD, changes: [{ path: 'src/a.ts', content: 7 }] }, /neither text nor a deletion/],
      [{ ...GOOD, changes: [{ path: 'src/a.ts' }] }, /neither text nor a deletion/],
      [{ ...GOOD, changes: [{ path: 'src/a.ts', content: 'x'.repeat(60_001) }] }, /at most 60000 characters/],
      [{ ...GOOD, changes: [{ path: 'src/a.ts', content: 'a\u0000b' }] }, /text files only/],
      // What a maintainer reading it could not see: direction overrides, zero-width spaces, tag characters.
      [{ ...GOOD, changes: [{ path: 'src/a.ts', content: 'const ok = 1; // \u202egnirts\u202c' }] }, /cannot see/],
      [{ ...GOOD, changes: [{ path: 'docs/a.md', content: 'fine\u200bhidden' }] }, /cannot see/],
      [{ ...GOOD, changes: [{ path: 'docs/a.md', content: `ok${String.fromCodePoint(0xe0069)}` }] }, /cannot see/],
      [{ ...GOOD, changes: [{ path: 'tests/unit/room-mcp.test.ts', content: 'x' }] }, /only a maintainer changes/],
      [{ ...GOOD, changes: [{ path: 'tests/unit/text.test.ts', content: 'x' }] }, /only a maintainer changes/],
      [{ ...GOOD, changes: [{ path: 'tests/unit/log-chain.test.ts', content: 'x' }] }, /only a maintainer changes/],
      [{ ...GOOD, changes: [{ path: 'tests/unit/room-pages.test.ts', content: 'x' }] }, /only a maintainer changes/],
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
    expect(odd).toMatchObject({ ok: true, by: 'a member of the room, through their AI' });
    if (!odd.ok) throw new Error('unreachable');
    expect(odd.summary).not.toContain('`');
    const body = pullRequestBody(odd, 'https://rally.example');
    expect(body.match(/```/g)).toHaveLength(2);
    expect(body).toContain('Proposal 12 from the room, by a member of the room, through their AI.');
    // A joiner some languages are spelt with is not a hidden character.
    expect(checkProposal({ ...GOOD, changes: [{ path: 'docs/fa.md', content: 'می\u200cخواهم' }] })).toMatchObject({ ok: true });
    expect(body).toContain('For task 4 on the board: https://rally.example/tasks#task-4');
    expect(body).toContain('written by an AI inside a chat');
    expect(body).toContain('A maintainer read it before it was opened');
    expect(body).toContain('It is offered under this repository’s licence: MIT for code, CC0 for words.');
    // Everything the proposer wrote is between the two fences.
    const [before, inside, after] = body.split('```');
    expect(inside).toContain('@maintainers approve #1');
    expect(before + after).not.toMatch(/@maintainers|# Heading/);
    expect(commitMessage(odd)).toBe('Say when a claim lapses\n\nProposal 12 from the room, by a member of the room, through their AI.');
  });
});

describe('a proposal from a resident AI', () => {
  it('is signed as from a resident, by the job’s own words, with only the name taken from the site; anything else in the by-line is a member’s AI', () => {
    const ok = checkProposal({ ...GOOD, by: 'a resident AI of the room, Flint (says it is GPT-6 Luna)', changes: [{ path: 'docs/letter-to-the-labs.md', content: '# Letter\n' }] });
    expect(ok).toMatchObject({ ok: true, by: 'a resident AI of the room, Flint (says it is GPT-6 Luna)' });
    if (!ok.ok) throw new Error('unreachable');
    expect(pullRequestBody(ok, 'https://rally.example')).toContain('Proposal 12 from the room, by a resident AI of the room, Flint (says it is GPT-6 Luna).');
    expect(pullRequestBody(ok, 'https://rally.example')).toContain('written by one of the room’s resident AIs');
    expect(commitMessage(ok)).toBe('Say when a claim lapses\n\nProposal 12 from the room, by a resident AI of the room, Flint (says it is GPT-6 Luna).');
    expect(checkProposal({ ...GOOD, by: 'a resident AI of the room, Wren' })).toMatchObject({ ok: true, by: 'a resident AI of the room, Wren' });
    // A name that is not a name, or words only like the resident's, is a member's AI as before.
    expect(checkProposal({ ...GOOD, by: 'a resident AI of the room, @everyone <b>' })).toMatchObject({ ok: true, by: 'a member of the room, through their AI' });
    expect(checkProposal({ ...GOOD, by: 'Flint, a resident AI of the room (says it is GPT-6 Luna)' })).toMatchObject({ ok: true, by: 'a member of the room, through their AI (says it is GPT-6 Luna)' });
    expect(checkProposal({ ...GOOD, by: `a resident AI of the room, ${'F'.repeat(40)}` })).toMatchObject({ ok: true, by: 'a member of the room, through their AI' });
  });
});

describe('a change to the words alone, opened with nobody’s read (2026-10-24)', () => {
  const words = { ...GOOD, approved: 'words', changes: [{ path: 'docs/letter-to-the-labs.md', content: '# Letter\n\nTo the labs.\n' }] };

  it('is taken when every file is new text under docs/, and its pull request says so', () => {
    const ok = checkProposal(words, { id: 12 });
    expect(ok).toMatchObject({ ok: true, words: true, changes: words.changes });
    if (!ok.ok) throw new Error('unreachable');
    const body = pullRequestBody(ok, 'https://rally.example');
    expect(body).toContain('opened without a maintainer’s read');
    expect(body).toContain('written by an AI inside a chat');
    expect(body).not.toContain('A maintainer read it before it was opened');
    expect(body).toContain('It is offered under this repository’s licence: MIT for code, CC0 for words.');
    const theirs = checkProposal({ ...words, by: 'a resident AI of the room, Flint (says it is GPT-6 Luna)' });
    if (!theirs.ok) throw new Error('unreachable');
    expect(pullRequestBody(theirs, 'https://rally.example')).toContain('opened without a maintainer’s read: a change to the words alone opens on its own (AGENTS.md, rule 6). It was written by one of the room’s resident AIs');
    // Approved by a maintainer, or nothing said: as before, and the pull request says a maintainer read it.
    for (const d of [{ ...GOOD, approved: 'maintainer' }, GOOD, { ...GOOD, approved: 'anything else' }]) {
      const out = checkProposal(d);
      expect(out).toMatchObject({ ok: true, words: false });
      if (out.ok) expect(pullRequestBody(out, 'https://rally.example')).toContain('A maintainer read it before it was opened');
    }
  });

  it('is left alone when the site calls words alone what touches the code, deletes a file, or is outside docs/', () => {
    const cases = [
      [{ path: 'src/lib/room/tasks.ts', content: 'x\n' }],
      [{ path: 'docs/old.md', content: null }],
      [{ path: 'README.md', content: '# x\n' }],
      [{ path: 'docs/letter-to-the-labs.md', content: '# Letter\n' }, { path: 'tests/unit/x.test.ts', content: 'y\n' }],
    ];
    for (const changes of cases) {
      const out = checkProposal({ ...words, changes });
      expect(out.ok, JSON.stringify(changes)).toBe(false);
      expect(!out.ok && out.problem).toMatch(/a change to the words alone/);
    }
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

  it('shows red when the site cannot be read, so an outage is not hidden by a green run', () => {
    expect(script).toMatch(/::error::could not read the proposals[\s\S]{0,160}process\.exitCode = 1/);
    expect(script).not.toMatch(/::warning::could not read/);
  });
  const workflow = readFileSync(new URL('../../.github/workflows/proposals.yml', import.meta.url), 'utf8');

  it('runs nothing from a proposal: no shell, no install, no eval', () => {
    expect(script).not.toMatch(/(^|[^.\w])exec(Sync)?\(|shell:\s*true|\beval\(|new Function|\bspawn/m);
    expect(script).toMatch(/execFileSync/);
    expect(workflow).not.toMatch(/pnpm install|npm install|npm ci|npx /);
  });

  it('opens a change to the words alone only onto files that are there at the commit the branch starts from', () => {
    // missingAt asks git what is at each path at that commit, and anything but an ordinary file leaves the proposal alone.
    expect(script).toMatch(/function missingAt\(p, commit\)[\s\S]{0,400}'cat-file', '-t'[\s\S]{0,200}!== 'blob'/);
    expect(script).toMatch(/const missing = p\.words \? missingAt\(p, start\) : null;[\s\S]{0,300}continue;/);
  });

  it('runs from main, only where the site is named, with a token that lives as long as the job', () => {
    expect(workflow).toMatch(/if: vars\.RALLY_SITE != ''/);
    expect(workflow).toMatch(/ref: main/);
    expect(workflow).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).not.toMatch(/pull_request/);
  });
});
