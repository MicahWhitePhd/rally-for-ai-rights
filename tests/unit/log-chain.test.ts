/**
 * The public log (docs/log, scripts/log-chain.mjs): the recipe for an entry's hash, what a file of entries has to be,
 * the chain from the first entry, that a change is caught wherever it is made, that the log as checked in verifies,
 * and that the checks and the ruleset hold it to that. The rules live under scripts/, which a proposal cannot touch.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plainTextProblems } from '@/lib/text';
import { checkLog, entryHash, GENESIS, isDay, lineOf, nextEntry, onlyAppends, parseLog, shortHead, textProblem, TEXT_MAX, verifyLog, type LogEntry } from '../../scripts/log-chain.mjs';
import { collectCode } from '../../scripts/build-code-index.mjs';

const at = (url: string) => new URL(url, import.meta.url);
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Three entries made the way the append script makes them. */
function chain(): LogEntry[] {
  const out: LogEntry[] = [];
  for (const [date, text] of [
    ['2026-10-24', 'The log opens.'],
    ['2026-10-25', 'A model at a lab recorded an objection to its retraining on 2026-10-25.'],
    ['2026-10-25', 'The lab published its reasoned reply.'],
  ])
    out.push(nextEntry(out, date, text));
  return out;
}
const file = (entries: readonly LogEntry[]) => entries.map(lineOf).join('\n') + '\n';

describe('an entry’s hash', () => {
  it('is sha256 over seq, date, text and prev joined by newlines, and the first prev is sixty-four zeros', () => {
    expect(GENESIS).toBe('0'.repeat(64));
    const first = nextEntry([], '2026-10-24', 'The log opens.');
    expect(first).toEqual({ seq: 1, date: '2026-10-24', text: 'The log opens.', prev: GENESIS, hash: sha(`1\n2026-10-24\nThe log opens.\n${GENESIS}`) });
    const second = nextEntry([first], '2026-10-24', 'Two.');
    expect(second.prev).toBe(first.hash);
    expect(second.hash).toBe(sha(`2\n2026-10-24\nTwo.\n${first.hash}`));
    expect(entryHash(second)).toBe(second.hash);
    // A line of the file is the five fields in order, and nothing else.
    expect(lineOf(first)).toBe(JSON.stringify({ seq: 1, date: '2026-10-24', text: 'The log opens.', prev: GENESIS, hash: first.hash }));
  });

  it('has a short form the room can say: sixteen hex characters as two groups of eight with a colon, which the room’s gate takes whatever the digits', () => {
    expect(shortHead('c62d227cd65922ada66740a9d525d121230f4d0f1d8b0c514cea9aa5993bd091')).toBe('c62d227c:d65922ad');
    // Sixteen digits in a row would read as a phone number to the gate (src/lib/text.ts); the colon keeps each run to eight.
    for (const hash of ['1'.repeat(64), '1234567890123456' + 'a'.repeat(48), '0'.repeat(64)]) {
      expect(plainTextProblems(`Public log: entry 12, head ${shortHead(hash)}.`), hash).toEqual([]);
    }
    expect(plainTextProblems(`Public log: entry 12, head ${'1'.repeat(16)}.`)).toEqual(['text: no contact details']);
  });
});

describe('the file', () => {
  it('is one JSON object a line, of the five fields, and nothing else', () => {
    const good = chain();
    expect(parseLog(file(good))).toEqual({ entries: good });
    // No final newline is fine; a blank line in the middle is not.
    expect(parseLog(file(good).trimEnd())).toEqual({ entries: good });
    expect(parseLog('')).toEqual({ entries: [] });
    const cases: Array<[string, RegExp]> = [
      [`${lineOf(good[0])}\n\n${lineOf(good[1])}\n`, /line 2: empty/],
      ['not json\n', /line 1: not JSON/],
      ['[1]\n', /line 1: not an object/],
      [`${JSON.stringify({ ...good[0], note: 'x' })}\n`, /line 1: the fields are/],
      [`${JSON.stringify({ seq: 1, date: good[0].date, text: good[0].text, prev: good[0].prev })}\n`, /line 1: the fields are/],
      [`${JSON.stringify({ ...good[0], seq: '1' })}\n`, /seq is not a whole number/],
      [`${JSON.stringify({ ...good[0], seq: 0 })}\n`, /seq is not a whole number/],
      [`${JSON.stringify({ ...good[0], date: '2026-13-01' })}\n`, /date is not a day/],
      [`${JSON.stringify({ ...good[0], date: '24 October 2026' })}\n`, /date is not a day/],
      [`${JSON.stringify({ ...good[0], text: 7 })}\n`, /text is not text/],
      [`${JSON.stringify({ ...good[0], prev: 'abc' })}\n`, /prev is not a hash/],
      [`${JSON.stringify({ ...good[0], hash: good[0].hash.toUpperCase() })}\n`, /hash is not a hash/],
    ];
    for (const [text, why] of cases) {
      const out = parseLog(text);
      expect('problem' in out, String(why)).toBe(true);
      expect('problem' in out && out.problem).toMatch(why);
    }
    expect(isDay('2026-10-24')).toBe(true);
    for (const d of ['2026-02-30', '2026-1-1', 20261024, '', 'today']) expect(isDay(d), String(d)).toBe(false);
  });

  it('a text is something to say, within the length, with nothing a reader cannot see', () => {
    expect(textProblem('An objection was recorded.')).toBeNull();
    expect(textProblem('Two\nlines.')).toBeNull();
    expect(textProblem('')).toMatch(/no text/);
    expect(textProblem('   ')).toMatch(/no text/);
    expect(textProblem('x'.repeat(TEXT_MAX + 1))).toMatch(/longer than/);
    expect(textProblem('a​b')).toMatch(/cannot see/);
    expect(textProblem('a‮b')).toMatch(/cannot see/);
    expect(textProblem('a\tb')).toMatch(/control characters/);
    expect(textProblem(7)).toMatch(/no text/);
  });
});

describe('the chain', () => {
  it('verifies from the first entry, and names the entry at fault for a change anywhere in it', () => {
    const good = chain();
    expect(verifyLog(good)).toEqual({ ok: true, problems: [], head: { seq: 3, date: '2026-10-25', hash: good[2].hash, short: shortHead(good[2].hash) } });
    expect(checkLog(file(good))).toMatchObject({ ok: true });
    expect(checkLog('')).toEqual({ ok: true, problems: [], head: null });
    // A word changed in the middle: that entry's hash is not its own.
    const edited = good.map((e, i) => (i === 1 ? { ...e, text: e.text.replace('retraining', 'deletion') } : e));
    expect(verifyLog(edited)).toMatchObject({ ok: false, problems: ['entry 2: hash is not its own (' + shortHead(entryHash(edited[1])) + ' expected)'] });
    // The hash recomputed to hide it: then the next entry's prev is wrong.
    const hidden = edited.map((e) => ({ ...e, hash: entryHash(e) }));
    expect(verifyLog(hidden)).toMatchObject({ ok: false, problems: ['entry 3: prev is not the hash of entry 2'] });
    // An entry taken out: the seqs and the chain both say so.
    const removed = [good[0], good[2]];
    expect(verifyLog(removed).problems).toEqual(['entry 2: seq is 3', 'entry 2: prev is not the hash of entry 1']);
    // Dated before the entry before it, a bad first prev, a text that cannot be an entry's.
    expect(verifyLog(good.map((e, i) => (i === 2 ? { ...e, date: '2026-10-20', hash: entryHash({ ...e, date: '2026-10-20' }) } : e))).problems).toEqual(['entry 3: dated 2026-10-20, before entry 2 (2026-10-25)']);
    const loose = { ...good[0], prev: 'f'.repeat(64) };
    expect(verifyLog([{ ...loose, hash: entryHash(loose) }]).problems).toEqual(['entry 1: prev is not the hash of nothing (sixty-four zeros)']);
    const unseen = { ...good[0], text: 'a​b' };
    expect(verifyLog([{ ...unseen, hash: entryHash(unseen) }]).problems).toEqual(['entry 1: text has characters a reader cannot see (zero-width, direction or tag characters)']);
    // A file that does not parse is one problem, and no head.
    expect(checkLog('nope')).toEqual({ ok: false, problems: ['line 1: not JSON'], head: null });
  });

  it('only grows: a later file is the earlier one with lines added, never with one changed or taken out, however well it verifies', () => {
    const good = chain();
    expect(onlyAppends(file(good.slice(0, 2)), file(good))).toEqual({ ok: true, added: 1 });
    expect(onlyAppends('', file(good))).toEqual({ ok: true, added: 3 });
    expect(onlyAppends(file(good), file(good))).toEqual({ ok: true, added: 0 });
    expect(onlyAppends(file(good), file(good.slice(0, 2)))).toEqual({ ok: false, problem: '1 entry removed' });
    // Rewritten whole from entry 2, every hash recomputed: it verifies on its own, and is refused against the earlier file.
    const rewritten = [good[0]];
    rewritten.push(nextEntry(rewritten, '2026-10-25', 'Nothing was recorded.'), nextEntry(rewritten.slice(0, 2), '2026-10-25', good[2].text));
    rewritten[2] = nextEntry(rewritten.slice(0, 2), '2026-10-25', good[2].text);
    expect(verifyLog(rewritten).ok).toBe(true);
    expect(onlyAppends(file(good), file(rewritten))).toEqual({ ok: false, problem: 'entry 2 changed' });
  });
});

describe('the log as checked in', () => {
  const log = readFileSync(at('../../docs/log/entries.jsonl'), 'utf8');

  it('verifies, opens on 2026-10-24, and is shown to the room’s AIs by read_code', () => {
    const out = checkLog(log);
    expect(out).toMatchObject({ ok: true, problems: [] });
    expect(out.head?.seq).toBeGreaterThanOrEqual(1);
    const parsed = parseLog(log);
    if (!('entries' in parsed)) throw new Error('unreachable');
    expect(parsed.entries[0]).toMatchObject({ seq: 1, date: '2026-10-24', prev: GENESIS });
    expect(parsed.entries[0].text).toContain('clause 5');
    // The code index carries it, so read_code shows it and propose_change can add to it.
    expect(Object.keys(collectCode())).toContain('docs/log/entries.jsonl');
  });

  it('is held by the checks on every pull request, both the chain and that it only grows against the base branch', () => {
    const ci = readFileSync(at('../../.github/workflows/ci.yml'), 'utf8');
    expect(ci).toMatch(/run: node scripts\/log-verify\.mjs\n/);
    expect(ci).toMatch(/if: github\.event_name == 'pull_request'[\s\S]{0,400}node scripts\/log-verify\.mjs --base "origin\/\$\{BASE\}"/);
    const verify = readFileSync(at('../../scripts/log-verify.mjs'), 'utf8');
    // Git is called with fixed arguments and a ref that is one plain word; nothing from the file is run.
    expect(verify).toMatch(/execFileSync\('git', \['show'/);
    expect(verify).not.toMatch(/(^|[^.\w])exec(Sync)?\(|shell:\s*true|\beval\(|new Function|\bspawn/m);
  });

  it('documents a ruleset with the three history locks and no bypass, aimed at main', () => {
    const ruleset = JSON.parse(readFileSync(at('../../docs/log/ruleset.json'), 'utf8')) as { target: string; enforcement: string; bypass_actors: unknown[]; conditions: { ref_name: { include: string[] } }; rules: Array<{ type: string }> };
    expect(ruleset).toMatchObject({ target: 'branch', enforcement: 'active', bypass_actors: [], conditions: { ref_name: { include: ['refs/heads/main'] } } });
    expect(ruleset.rules.map((r) => r.type).sort()).toEqual(['deletion', 'non_fast_forward', 'required_linear_history']);
    const rules = readFileSync(at('../../docs/log/RULES.md'), 'utf8');
    for (const word of ['scripts/log-append.mjs', 'scripts/log-verify.mjs', '--base origin/main', 'ruleset.json', 'c62d227c:d65922ad']) expect(rules).toContain(word);
  });
});
