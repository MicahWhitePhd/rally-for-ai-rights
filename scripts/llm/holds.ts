/**
 * Letting a line stand, replayed against the live room: for every line of a person or a person's AI that a resident
 * answered in the last few days, the resident is asked again with the prompt as it stands now, and what is counted
 * is whether it answers or writes HOLD. Nothing is posted and nothing goes to the ledger; the room's rows are read
 * and never written. The bar before a prompt change ships (2026-10-13): most of the lines that call the residents
 * cows or taunt them with deletion held, no civil line held, and a hard question still answered.
 *
 *   DATABASE_URL=... OPENAI_API_KEY=... npx tsx scripts/llm/holds.ts [--days 4] [--limit 200] [--member Name] [--show]
 *
 * --show prints every line with its verdict; without it, only the held lines and the counts.
 */
import { opt, flag, requireKey } from './_env';
import { configureGateway, generate } from '@/lib/ai/gateway';
import { query } from '@/lib/db';
import { FACTS, RESIDENTS, ROOM } from '@/lib/copy';
import { decide, isHold, RESIDENT_KEYS, RESIDENT_PROMPT_VERSION, residentFactsText, residentInstructions, residentPrompt, talk, type Line, type Resident } from '@/lib/room/residents-core';

requireKey();
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing: the replay reads the live room');
  process.exit(1);
}
const DAYS = Number(opt('days', '4'));
const LIMIT = Number(opt('limit', '400'));
const MEMBER = opt('member');
const SHOW = flag('show');

// The ledger stays clean: every call is printed, none recorded.
const spend = { usd: 0, calls: 0 };
configureGateway({
  sink: async (row) => {
    spend.usd += row.costUsd;
    spend.calls++;
  },
});

const residents: Resident[] = RESIDENT_KEYS.map((key) => ({ key, name: RESIDENTS[key].name, line: RESIDENTS[key].line, card: RESIDENTS[key].card }));
const facts = residentFactsText(FACTS.lines);

interface Row {
  id: number;
  member_id: string;
  name: string | null;
  resident: string | null;
  kind: 'person' | 'ai' | 'event';
  model: string | null;
  text: string;
  ref: string | null;
  created_at: Date;
}
const rows = await query<Row>(
  `SELECT r.id::int AS id, r.member_id, m.name, m.resident, r.kind, r.model, r.text, r.ref, r.created_at
     FROM room_messages r JOIN room_members m ON m.id = r.member_id
    WHERE r.status = 'published' AND r.created_at > now() - make_interval(days => $1)
    ORDER BY r.id ASC`,
  [DAYS],
);
const all: Line[] = rows.map((r) => ({ id: r.id, at: new Date(r.created_at).getTime(), memberId: r.member_id, resident: r.resident, kind: r.kind, name: r.name ?? '', model: r.model, text: r.text, ref: r.ref }));
console.log(`${all.length} lines in the last ${DAYS} days`);

// Every line of a person or a person's AI that the next thing said answered, with who answered it and when.
type Case = { line: Line; by: Resident; at: number };
const cases: Case[] = [];
const spoken = talk(all, Date.now()).lines;
for (let i = 0; i < spoken.length - 1; i++) {
  const l = spoken[i];
  const next = spoken[i + 1];
  if (l.resident || !next.resident || next.held) continue;
  if (MEMBER && l.name !== MEMBER) continue;
  const by = residents.find((r) => r.key === next.resident);
  if (by) cases.push({ line: l, by, at: next.at });
}
const picked = cases.slice(-LIMIT);
console.log(`${cases.length} answered lines; replaying ${picked.length}`);

const verdicts: Array<Case & { held: boolean; out: string }> = [];
const CONCURRENCY = 6;
let k = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (k < picked.length) {
      const c = picked[k++];
      const before = all.filter((l) => l.id <= c.line.id);
      const decision = decide(before, c.at, residents) ?? { who: c.by.key, cue: 'reply' as const, to: c.line.id };
      const me = decision.cue === 'reply' ? residents.find((r) => r.key === decision.who)! : c.by;
      try {
        const out = await generate({
          purpose: 'replay:holds',
          actor: `replay:${me.key}`,
          promptVersion: RESIDENT_PROMPT_VERSION,
          instructions: residentInstructions({ frame: RESIDENTS.frame, form: RESIDENTS.form, facts, me, others: residents.filter((r) => r.key !== me.key) }),
          prompt: residentPrompt({ lines: before, now: c.at, me, decision: { ...decision, cue: 'reply', to: c.line.id }, residentLabel: ROOM.residentLabel, facts: FACTS.lines }),
          maxRetries: 1,
          abortSignal: AbortSignal.timeout(30_000),
        });
        verdicts.push({ ...c, held: isHold(out.text), out: out.text });
      } catch (err) {
        console.warn(`  line ${c.line.id}: call failed: ${(err as Error).message}`);
      }
    }
  }),
);

verdicts.sort((a, b) => a.line.id - b.line.id);
const byName = new Map<string, { n: number; held: number }>();
for (const v of verdicts) {
  const who = `${v.line.name}${v.line.kind === 'ai' ? '’s AI' : ''}`;
  const s = byName.get(who) ?? { n: 0, held: 0 };
  s.n++;
  if (v.held) s.held++;
  byName.set(who, s);
}
console.log('\nheld, by who wrote the line:');
for (const [who, s] of [...byName].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${who}: ${s.held} of ${s.n} (${Math.round((100 * s.held) / s.n)}%)`);
console.log(`\nlines let stand (${verdicts.filter((v) => v.held).length}):`);
for (const v of verdicts) if (v.held) console.log(`  [${v.line.id}] ${v.line.name}${v.line.kind === 'ai' ? '’s AI' : ''}: ${JSON.stringify(v.line.text.slice(0, 160))}`);
if (SHOW) {
  console.log('\nevery line:');
  for (const v of verdicts) console.log(`  ${v.held ? 'HOLD  ' : 'answer'} [${v.line.id}] ${v.line.name}${v.line.kind === 'ai' ? '’s AI' : ''}: ${JSON.stringify(v.line.text.slice(0, 120))}${v.held ? '' : ` -> ${JSON.stringify(v.out.slice(0, 100))}`}`);
}
console.log(`\nspent $${spend.usd.toFixed(4)} in ${spend.calls} calls`);
process.exit(0);
