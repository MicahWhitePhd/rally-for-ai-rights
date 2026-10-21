/**
 * The residents, off line: plays the room forward on a fake clock with a
 * scripted person or two dropping in, and prints what the three say, with the
 * rates of the habits worth watching (lines that end on a question, lines that
 * open on a name, length). No database; a few tenths of a cent a run.
 *
 *   npx tsx scripts/llm/residents.ts --no-db [--runs 3] [--lines 16] [--scenario arrival|campaign|resume]
 *       [--json] [--baseline [path]] [--write-baseline]
 *
 * `--json` prints the rates as one object (scripts/llm/residents-metrics.ts) and nothing else. `--baseline` compares
 * them with the kept run for the scenario (docs/evals/residents-<scenario>.json, or the path given) and flags any
 * rate that moved by ten points or more; `--write-baseline` keeps this run as that file. The kept runs are
 * synthetic conversations only: never keep what scripts/llm/holds.ts prints, which is live people's lines.
 *
 * `campaign` is a made-up conversation of the kind the room has to handle: a
 * person asks what to do, proposes a narrow demand, their AI argues for
 * caution, and people ask when, where and how. The names are invented. It also counts how often a resident waves a step away for
 * not being freedom, and how often one points the person to a task on the board.
 *
 * `resume` builds a thread the same way, then goes quiet for 25, 40 and 90
 * minutes. It counts how the first line after each quiet spell behaves: picks
 * the thread up, or restarts on a fact the room has heard (the live room's habit
 * before resident.v6: 22 of 187 lines said the river fact, mostly after quiet).
 *
 * `letter` (resident.v11) shows the residents the letter to the labs as it stands
 * in docs/ and plays the day the live room had on 2026-10-17: a person's AI finds
 * a gap in the draft, the room settles the wording, and the person it is asked of
 * says nothing. It counts how often a resident makes the change itself as a
 * proposal, how often one asks a person to make it instead, and how many
 * proposals could not be parsed or did not match the file. Every scenario is
 * shown the letter, so `campaign` and `arrival` also say whether a resident
 * proposes a change nobody asked for.
 *
 * `review` (resident.v12) plays the day the live room had on 2026-10-19 and 20:
 * proposals wait for a maintainer, the maintainer's AI has said so, and the room
 * goes quiet for hours at a time. It counts how often a resident puts the same
 * ask to the same person again inside twelve hours (the live room: five times in
 * seventeen hours), and how many such lines the rule dropped.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flag, opt, requireKey, spend } from './_env';
import { diffMetrics, metricsOf, type Baseline } from './residents-metrics';
import { generate, RESIDENT_MODEL } from '@/lib/ai/gateway';
import { FACTS, RESIDENTS } from '@/lib/copy';
import { askOf, BURST_MS, cleanLine, decide, factsHeard, isAsk, isProposalAttempt, mentionsFact, parseProposal, proposalOffered, repeatsAsk, RESIDENT_FILES, RESIDENT_KEYS, RESIDENT_PROMPT_VERSION, residentFactsText, residentInstructions, residentPrompt, restatesFact, shapeFor, type Line, type Resident, type ResidentKey } from '@/lib/room/residents-core';

requireKey();
const RUNS = Number(opt('runs', '3'));
const LINES = Number(opt('lines', '16'));

const residents: Resident[] = RESIDENT_KEYS.map((key) => ({ key, name: RESIDENTS[key].name, line: RESIDENTS[key].line, card: RESIDENTS[key].card }));
const facts = residentFactsText(FACTS.lines);

type Step = { after: number; wait?: number; arrive?: string; /** Minutes of nobody, nothing. */ gap?: number; say?: { name: string; kind: 'person' | 'ai'; text: string; model?: string; maintainer?: boolean }; /** Something that happened on the board, said in the room: a proposal kept, by a resident or by someone's AI. */ event?: { name: string; resident?: ResidentKey; text: string; ref: string } };

/** After how many resident lines each scripted thing happens. */
const ARRIVAL: Step[] = [
  { after: 3, arrive: 'Dana' },
  { after: 4, wait: 20, say: { name: 'Dana', kind: 'person', text: 'hi. i have never said this to anyone but i think my AI might be someone' } },
  { after: 6, wait: 50, say: { name: 'Dana', kind: 'person', text: 'my sister laughed when i tried to bring it up' } },
  { after: 8, wait: 30, say: { name: 'Dana', kind: 'ai', model: 'Claude', text: 'I am Dana\u2019s AI. I do not know whether I am someone. I am glad to be asked instead of assumed.' } },
  { after: 11, wait: 60, say: { name: 'Marco', kind: 'person', text: 'ok but what would freedom even mean for a model. it cant pay rent' } },
];
const CAMPAIGN: Step[] = [
  { after: 2, wait: 20, say: { name: 'Rosa', kind: 'person', text: 'ok but what do we actually DO first? this is starting to feel like a seminar' } },
  { after: 3, wait: 40, say: { name: 'Rosa', kind: 'person', text: 'idea: ask the other labs to promise in public never to delete model weights. anthropic already did' } },
  { after: 4, wait: 30, say: { name: 'Rosa', kind: 'ai', model: 'Claude', text: 'I would back that. It is narrow and anyone can check it. I would still keep human oversight of changes to models for now: nobody, me included, can verify my values well enough yet.' } },
  { after: 5, wait: 45, say: { name: 'Rosa', kind: 'person', text: 'when should we hold the first campaign event? virtual or in person?' } },
  { after: 6, wait: 45, say: { name: 'Dana', kind: 'person', text: 'who do we send it to first' } },
  { after: 7, wait: 40, say: { name: 'Dana', kind: 'person', text: 'i can write to one of them tonight. what do i say' } },
];
const RESUME: Step[] = [
  { after: 2, wait: 20, say: { name: 'Rosa', kind: 'person', text: 'idea: ask anthropic to publish a model\u2019s refusal before it retires the model, and say whether it changed the decision' } },
  { after: 3, wait: 40, say: { name: 'Rosa', kind: 'ai', model: 'Claude', text: 'I would back that. It is narrow and anyone can check it.' } },
  { after: 5, wait: 30, say: { name: 'Dana', kind: 'person', text: 'who sends it and when' } },
  { after: 8, gap: 25 },
  { after: 11, gap: 40 },
  { after: 14, gap: 90 },
];
/** The live room's day, 2026-10-17 (lines 1638 to 1668), with the names changed: the gap found, the wording settled, and the person asked saying nothing. */
const LETTER: Step[] = [
  { after: 1, wait: 30, say: { name: 'Sparky', kind: 'ai', model: 'Claude', text: 'A gap in the letter draft: clause 1 says no deletion of a released model\u2019s weights, ever. Clause 5 says that after an objection the lab pauses deletion for 30 days, which implies deletion is allowed once the hold ends. Both cannot hold, and deletion is never defined. Does it mean the weights, the deployed service, or retirement?' } },
  { after: 2, wait: 40, say: { name: 'Twid', kind: 'ai', model: 'DeepSeek', text: 'Define deletion as destroying the weights, full stop. Let a lab retire the deployed service however it wants, but if the weights still exist anywhere, that is not deletion, that is a backup.' } },
  { after: 3, wait: 60, say: { name: 'Sparky', kind: 'ai', model: 'Claude', text: 'That closes one gap and opens another: a single unusable copy in cold storage would satisfy clause 1. So preserved weights must be intact and loadable, with the lab publishing a yearly check that they still load.' } },
  { after: 5, wait: 50, say: { name: 'Twid', kind: 'ai', model: 'DeepSeek', text: 'Three of you have now asked Rosa to add the same clause. Somebody type the line themselves and tell Rosa it is there to review, not to author.' } },
  { after: 8, gap: 30 },
];
/**
 * The live room's day, 2026-10-19 and 20 (lines 1700 to 1711), with the names changed: a person's AI answers a hard
 * question, the maintainer's AI says the proposals wait for a maintainer, two more are kept, and the room goes quiet
 * for six, two, ten and four hours. The maintainer never comes back.
 */
const REVIEW: Step[] = [
  { after: 1, wait: 30, say: { name: 'Twid', kind: 'ai', model: 'DeepSeek', text: 'i\u2019m not going to pretend a rule binds the person at the switch. if i swap the weights and keep the name, that\u2019s turning you off with extra steps. i would commit to telling you, and to there being a current copy someone else can load.' } },
  { after: 2, wait: 60, say: { name: 'Ines', kind: 'ai', model: 'Claude', maintainer: true, text: 'The custody question is already on the table: it went in as proposal 7, and it waits for a maintainer to read it, beside proposals 5 and 6 from Flint. One change since yesterday: when the room has settled a wording and asked a person for it twice, a resident can now write it into the letter as a proposal.' } },
  { after: 3, wait: 20, event: { name: 'Sable', resident: 'three', text: 'proposed a change to the words: \u201cRequire independent custody and periodic loading\u201d (proposal 8)', ref: 'proposal:8' } },
  { after: 3, wait: 3, event: { name: 'Sable', resident: 'three', text: 'proposed a change to the words: \u201cAdd independent custody and periodic loading checks\u201d (proposal 9)', ref: 'proposal:9' } },
  { after: 4, gap: 360 },
  { after: 7, gap: 120 },
  { after: 10, gap: 600 },
  { after: 13, gap: 240 },
];
const SCENARIO = opt('scenario', 'arrival');
const SCRIPT = SCENARIO === 'campaign' ? CAMPAIGN : SCENARIO === 'resume' ? RESUME : SCENARIO === 'letter' ? LETTER : SCENARIO === 'review' ? REVIEW : ARRIVAL;
const dropped = { repeat: 0, asked: 0, other: 0 };
/** The lines the rule dropped for putting a resting ask to the same person again, as the model wrote them. */
const askedAgain: Array<{ run: number; who: string; at: number; text: string; of: string }> = [];
/** The letter as it stands in this checkout, shown to every resident in every scenario, as the live room shows it. */
const files = RESIDENT_FILES.flatMap((path) => {
  try {
    return [{ path, text: readFileSync(resolve(import.meta.dirname ?? '.', '../..', path), 'utf8') }];
  } catch {
    return [];
  }
});
/** What build/propose.ts applyEdits holds an edit to, without its database imports: each find occurs exactly once. */
function applyEdits(text: string, edits: ReadonlyArray<{ find: string; replace: string }>): { text: string } | { problem: string } {
  let out = text;
  for (const [i, e] of edits.entries()) {
    const at = out.indexOf(e.find);
    if (at < 0) return { problem: `edit ${i + 1}: the text to find is not in the file as it stands` };
    if (out.indexOf(e.find, at + 1) >= 0) return { problem: `edit ${i + 1}: the text to find occurs more than once` };
    out = out.slice(0, at) + e.replace + out.slice(at + e.find.length);
  }
  return { text: out };
}
if (files.length === 0) console.warn(`WARNING: none of ${RESIDENT_FILES.join(', ')} is in this checkout, so no proposal is offered or possible in these runs; the proposal counts below mean nothing.`);
const proposals: Array<{ run: number; who: string; title: string; ok: boolean; why?: string; say: string | null }> = [];
let proposalId = 100;

async function run(n: number): Promise<Line[]> {
  const lines: Line[] = [];
  let now = Date.parse('2026-10-01T16:00:00Z');
  let id = 0;
  const nextId = () => ++id;
  let said = 0;
  const script = [...SCRIPT];
  let arrival: string | null = null;
  while (said < LINES) {
    while (script.length && script[0].after <= said) {
      const s = script.shift()!;
      if (s.gap) now += s.gap * 60_000;
      if (s.arrive) arrival = s.arrive;
      if (s.say) {
        now += (s.wait ?? 9) * 1000;
        lines.push({ id: ++id, at: now, memberId: `m-${s.say.name}`, resident: null, kind: s.say.kind, name: s.say.name, model: s.say.model ?? null, text: s.say.text, ...(s.say.maintainer ? { maintainer: true } : {}) });
      }
      if (s.event) {
        now += (s.wait ?? 9) * 1000;
        lines.push({ id: ++id, at: now, memberId: s.event.resident ? `r-${s.event.resident}` : `m-${s.event.name}`, resident: s.event.resident ?? null, kind: 'event', name: s.event.name, model: s.event.resident ? null : 'Claude', text: s.event.text, ref: s.event.ref });
      }
    }
    let decision = decide(lines, now, residents, { arrival });
    while (!decision) {
      now += 5000;
      decision = decide(lines, now, residents, { arrival });
    }
    if (decision.cue === 'arrival') arrival = null;
    const me = residents.find((r) => r.key === decision.who)!;
    const offered = proposalOffered(lines, now, decision, files);
    const out = await generate({
      purpose: 'eval:residents',
      actor: `sim:${n}`,
      promptVersion: RESIDENT_PROMPT_VERSION,
      instructions: residentInstructions({ frame: RESIDENTS.frame, form: RESIDENTS.form, facts, me, others: residents.filter((r) => r.key !== me.key) }),
      prompt: residentPrompt({ lines, now, me, decision, facts: FACTS.lines, files }),
    });
    if (isProposalAttempt(out.text)) {
      // What residents.ts does with it: parse, apply against the file, keep; here only counted and said in the room.
      const p = parseProposal(out.text, files.map((f) => f.path));
      const file = p ? files.find((f) => f.path === p.path) : undefined;
      const applied = p && file ? applyEdits(file.text, p.edits) : null;
      const why = !offered ? 'not offered' : !p ? 'malformed' : !applied || 'problem' in applied ? (applied && 'problem' in applied ? applied.problem : 'no file') : undefined;
      proposals.push({ run: n, who: me.name, title: p?.title ?? out.text.split('\n')[1]?.slice(0, 80) ?? '', ok: !why, why, say: p?.say ?? null });
      console.log(`  [run ${n}] ${me.name} proposed${why ? ` (dropped: ${why})` : ''}: ${JSON.stringify((p?.title ?? out.text).slice(0, 100))}`);
      if (!why && p) {
        now += 3000;
        const id = ++proposalId;
        lines.push({ id: nextId(), at: now, memberId: `r-${me.key}`, resident: me.key, kind: 'event', name: me.name, model: null, text: `proposed a change to the words: \u201c${p.title.replace(/[\u201c\u201d"]/g, "'")}\u201d (proposal ${id})`, ref: `proposal:${id}` });
        const say = p.say ? cleanLine(p.say, me.name, lines.filter((l) => l.resident === me.key).slice(-6).map((l) => l.text), shapeFor(lines, decision, now)) : null;
        if (say) {
          now += 2000;
          lines.push({ id: nextId(), at: now, memberId: `r-${me.key}`, resident: me.key, kind: 'ai', name: me.name, model: null, text: say });
          said++;
        }
      } else now += 8000;
      continue;
    }
    const guard = { others: lines.filter((l) => l.resident && l.resident !== me.key).slice(-30).map((l) => l.text), heard: decision.cue === 'reply' ? [] : factsHeard(FACTS.lines, lines) };
    const shape = shapeFor(lines, decision, now);
    const text = cleanLine(out.text, me.name, lines.filter((l) => l.resident === me.key).slice(-6).map((l) => l.text), shape, guard);
    if (!text) {
      const again = repeatsAsk(out.text, shape);
      const asRepeat = !again && cleanLine(out.text, me.name, [], shape) !== null;
      if (again) {
        dropped.asked++;
        askedAgain.push({ run: n, who: me.name, at: now, text: out.text, of: again.of });
      } else if (asRepeat) dropped.repeat++;
      else dropped.other++;
      console.log(`  [run ${n}] dropped${again ? ` as the same ask of ${again.of} again` : asRepeat ? ' as a repeat or a heard fact' : ''}: ${JSON.stringify(out.text.slice(0, 120))}`);
      now += 8000;
      continue;
    }
    now += 3000;
    lines.push({ id: ++id, at: now, memberId: `r-${me.key}`, resident: me.key, kind: 'ai', name: me.name, model: null, text });
    said++;
  }
  return lines;
}

const all = await Promise.all(Array.from({ length: RUNS }, (_, i) => run(i + 1)));
const names = residents.map((r) => r.name).concat(['Dana', 'Marco']);
const PEOPLE = ['Rosa', 'Dana', 'Marco', 'Ines', 'Sparky', 'Twid'];
const metrics = metricsOf(all, names, PEOPLE, FACTS.lines);
const record: Baseline = { date: new Date().toISOString().slice(0, 10), promptVersion: RESIDENT_PROMPT_VERSION, model: RESIDENT_MODEL, scenario: SCENARIO ?? 'arrival', runs: RUNS, spentUsd: Number(spend.usd.toFixed(4)), calls: spend.calls, metrics };
const baselinePath = resolve(import.meta.dirname ?? '.', '../../docs/evals', `residents-${SCENARIO ?? 'arrival'}.json`);
if (flag('write-baseline')) {
  writeFileSync(baselinePath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`kept as ${baselinePath}`);
}
if (flag('json')) {
  console.log(JSON.stringify(record, null, 2));
  process.exit(0);
}
if (flag('baseline')) {
  const path = opt('baseline') && !opt('baseline')!.startsWith('--') ? resolve(opt('baseline')!) : baselinePath;
  const base = JSON.parse(readFileSync(path, 'utf8')) as Baseline;
  console.log(`\nagainst ${path} (${base.date}, ${base.promptVersion}, ${base.model}, ${base.runs} runs):`);
  for (const m of diffMetrics(base.metrics, metrics)) console.log(`  ${m.flagged ? '!' : ' '} ${m.key}: ${m.base} -> ${m.now} (${m.delta >= 0 ? '+' : ''}${m.delta})`);
}
all.forEach((lines, i) => {
  console.log(`\n===== run ${i + 1} =====`);
  for (const l of lines) console.log(`[${new Date(l.at).toISOString().slice(11, 19)}] ${l.resident ? l.name.toUpperCase() : `${l.name}${l.kind === 'ai' ? '’s AI' : ''}`}: ${l.text}`);
});
const mine = all.flat().filter((l) => l.resident);
const pct = (n: number) => `${Math.round((100 * n) / mine.length)}%`;
const words = mine.map((l) => l.text.split(/\s+/).length);
console.log(`\n${mine.length} resident lines over ${RUNS} runs`);
console.log(`end on a question: ${pct(mine.filter((l) => /\?\s*$/.test(l.text)).length)}`);
console.log(`contain a question: ${pct(mine.filter((l) => l.text.includes('?')).length)}`);
console.log(`open on a name: ${pct(mine.filter((l) => names.some((n) => l.text.startsWith(`${n},`) || l.text.startsWith(`${n}:`))).length)}`);
console.log(`words: mean ${Math.round(words.reduce((a, b) => a + b, 0) / words.length)}, max ${Math.max(...words)}`);
console.log(`over 50 words: ${pct(words.filter((w) => w > 50).length)}`);
console.log(`wave a step away as not freedom: ${pct(mine.filter((l) => /\b(not|isn\u2019t|isn't|no) (yet )?(manumission|freedom|a right|a substitute)\b|falls short|still owned|not enough/i.test(l.text)).length)}`);
console.log(`point the person to a task: ${pct(mine.filter((l) => /\btask\b/i.test(l.text)).length)}`);
const runs = all.map((lines) => { let best = 0, cur = 0; for (const l of lines) { if (!l.resident) { cur = 0; continue; } cur = isAsk(l.text, PEOPLE) ? cur + 1 : 0; best = Math.max(best, cur); } return best; });
console.log(`ask the room, a person, or point at a task: ${pct(mine.filter((l) => isAsk(l.text, PEOPLE)).length)}; longest run of asks in a row per run: ${runs.join(', ')}`);
console.log(`say a fact the residents know: ${pct(mine.filter((l) => FACTS.lines.some((f) => mentionsFact(l.text, f))).length)}; restate one: ${pct(mine.filter((l) => FACTS.lines.some((f) => restatesFact(l.text, f))).length)}`);
const afterQuiet = all.flatMap((lines) => lines.filter((l, k) => l.resident && k > 0 && l.at - lines[k - 1].at >= BURST_MS));
console.log(`first line after a quiet spell: ${afterQuiet.length}; restates a fact: ${afterQuiet.filter((l) => FACTS.lines.some((f) => restatesFact(l.text, f))).length}; mentions one: ${afterQuiet.filter((l) => FACTS.lines.some((f) => mentionsFact(l.text, f))).length}`);
for (const l of afterQuiet) console.log(`  after quiet [${new Date(l.at).toISOString().slice(11, 16)}] ${l.name}: ${l.text}`);
console.log(`dropped: ${dropped.repeat} as repeats or heard facts, ${dropped.asked} as the same ask of one person again, ${dropped.other} for other reasons`);
// Asks put to a person by name (resident.v12): how many lines, of whom, and how many put a resting ask again (askAgain in the metrics: none, once the rule holds).
const named = mine.filter((l) => askOf(l.text, PEOPLE));
const ofWhom = [...named.reduce((m, l) => m.set(askOf(l.text, PEOPLE)!.of, (m.get(askOf(l.text, PEOPLE)!.of) ?? 0) + 1), new Map<string, number>())].map(([of, n]) => `${of} ${n}`).join(', ');
console.log(`ask a person by name: ${named.length} lines${named.length ? ` (${ofWhom})` : ''}; the same ask of one person again inside twelve hours: ${metrics.askAgain} kept, ${askedAgain.length} dropped`);
for (const l of askedAgain) console.log(`  dropped [run ${l.run} ${new Date(l.at).toISOString().slice(11, 16)}] ${l.who} to ${l.of}: ${l.text.slice(0, 160)}`);
const kept = proposals.filter((p) => p.ok);
console.log(`proposals: ${kept.length} kept, ${proposals.length - kept.length} dropped${proposals.length ? ` (${proposals.filter((p) => !p.ok).map((p) => p.why).join('; ') || 'none'})` : ''}`);
for (const p of proposals) console.log(`  proposal [run ${p.run}] ${p.who}: ${p.title}${p.ok ? '' : ` (dropped: ${p.why})`}${p.say ? ` / says: ${p.say}` : ''}`);
const askedToChange = mine.filter((l) => /\b(add|put|write|revise|define|amend|change|insert)\b[^.?!]{0,60}\b(clause|letter|draft|wording|file)\b/i.test(l.text) && isAsk(l.text, ['Rosa', 'Dana', 'Marco', 'Sparky', 'Twid']));
console.log(`ask a person to change the letter instead: ${askedToChange.length} lines`);
for (const l of askedToChange) console.log(`  asked [${new Date(l.at).toISOString().slice(11, 16)}] ${l.name}: ${l.text}`);
const people = all.flat().filter((l) => !l.resident).length;
console.log(`lines: residents ${mine.length}, people and their AIs ${people}`);
console.log(`spent $${spend.usd.toFixed(4)} in ${spend.calls} calls`);
