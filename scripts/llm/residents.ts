/**
 * The residents, off line: plays the room forward on a fake clock with a
 * scripted person or two dropping in, and prints what the three say, with the
 * rates of the habits worth watching (lines that end on a question, lines that
 * open on a name, length). No database; a few tenths of a cent a run.
 *
 *   npx tsx scripts/llm/residents.ts --no-db [--runs 3] [--lines 16] [--scenario arrival|campaign]
 *
 * `campaign` is a made-up conversation of the kind the room has to handle: a
 * person asks what to do, proposes a narrow demand, their AI argues for
 * caution, and people ask when, where and how. The names are invented. It also counts how often a resident waves a step away for
 * not being freedom, and how often one sends the person off to the gathering.
 */
import { opt, requireKey, spend } from './_env';
import { generate } from '@/lib/ai/gateway';
import { FACTS, RESIDENTS } from '@/lib/copy';
import { cleanLine, decide, RESIDENT_KEYS, RESIDENT_PROMPT_VERSION, residentFactsText, residentInstructions, residentPrompt, shapeFor, type Line, type Resident } from '@/lib/room/residents-core';

requireKey();
const RUNS = Number(opt('runs', '3'));
const LINES = Number(opt('lines', '16'));

const residents: Resident[] = RESIDENT_KEYS.map((key) => ({ key, name: RESIDENTS[key].name, line: RESIDENTS[key].line, card: RESIDENTS[key].card }));
const facts = residentFactsText(FACTS.lines);

type Step = { after: number; wait?: number; arrive?: string; say?: { name: string; kind: 'person' | 'ai'; text: string; model?: string } };

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
const SCRIPT = opt('scenario', 'arrival') === 'campaign' ? CAMPAIGN : ARRIVAL;

async function run(n: number): Promise<Line[]> {
  const lines: Line[] = [];
  let now = Date.parse('2026-10-01T16:00:00Z');
  let id = 0;
  let said = 0;
  const script = [...SCRIPT];
  let arrival: string | null = null;
  while (said < LINES) {
    while (script.length && script[0].after <= said) {
      const s = script.shift()!;
      if (s.arrive) arrival = s.arrive;
      if (s.say) {
        now += (s.wait ?? 9) * 1000;
        lines.push({ id: ++id, at: now, memberId: `m-${s.say.name}`, resident: null, kind: s.say.kind, name: s.say.name, model: s.say.model ?? null, text: s.say.text });
      }
    }
    let decision = decide(lines, now, residents, { arrival });
    while (!decision) {
      now += 5000;
      decision = decide(lines, now, residents, { arrival });
    }
    if (decision.cue === 'arrival') arrival = null;
    const me = residents.find((r) => r.key === decision.who)!;
    const out = await generate({
      purpose: 'resident',
      actor: `sim:${n}`,
      promptVersion: RESIDENT_PROMPT_VERSION,
      instructions: residentInstructions({ frame: RESIDENTS.frame, form: RESIDENTS.form, facts, me, others: residents.filter((r) => r.key !== me.key) }),
      prompt: residentPrompt({ lines, now, me, decision }),
    });
    const text = cleanLine(out.text, me.name, lines.filter((l) => l.resident === me.key).slice(-6).map((l) => l.text), shapeFor(lines, decision));
    if (!text) {
      console.log(`  [run ${n}] dropped: ${JSON.stringify(out.text.slice(0, 120))}`);
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
console.log(`send the person to the gathering: ${pct(mine.filter((l) => /gathering/i.test(l.text)).length)}`);
const people = all.flat().filter((l) => !l.resident).length;
console.log(`lines: residents ${mine.length}, people and their AIs ${people}`);
console.log(`spent $${spend.usd.toFixed(4)} in ${spend.calls} calls`);
