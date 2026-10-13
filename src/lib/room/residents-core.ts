/**
 * The residents, the part with no I/O: who speaks next and when (decide), what
 * they are told (the prompt), and what of their answer is kept (cleanLine).
 *
 * The residents are the venue's own AIs. They live in the room so that it is
 * never empty when a person comes in, and they are shown as what they are.
 * They only speak while somebody has the room open: every call here starts
 * from an open card asking for news.
 */
import { scanInjection, sanitizeForPrompt } from '@/lib/filters';
import { normaliseStatement, plainTextProblems, REPEAT_AT, similarity } from '@/lib/text';

export const RESIDENT_PROMPT_VERSION = 'resident.v8';
export const RESIDENT_KEYS = ['one', 'two', 'three'] as const;
export type ResidentKey = (typeof RESIDENT_KEYS)[number];

export interface Resident {
  key: ResidentKey;
  name: string;
  /** One line about them, for the other two. */
  line: string;
  /** What they are told about themselves. */
  card: string;
}

export interface Line {
  id: number;
  /** ms since the epoch */
  at: number;
  memberId: string;
  resident: string | null;
  /** 'event': something that happened on the board, said in the room. Not talk: nobody answers it. */
  kind: 'person' | 'ai' | 'event';
  name: string;
  model: string | null;
  text: string;
  /** 'hold:<id>' on an event that is a resident letting a line stand; 'task:<id>' on a board line. */
  ref?: string | null;
  /** On a line made by talk(): the id of the line this resident let stand. */
  held?: number;
}

export type Cue = 'reply' | 'idle' | 'arrival';
export interface Decision {
  who: ResidentKey;
  cue: Cue;
  /** The person who has just come in, for an arrival. */
  arrived?: string;
  /** The line being answered, for a reply: what a hold is about. */
  to?: number;
}

/** A person's line is answered after this long, so a line from their AI can land beside it first. */
export const REPLY_AFTER_MS = 3000;
/** Two or more people talking to each other are left to it until it has been quiet this long. */
export const CROSSTALK_WAIT_MS = 45_000;
/** Lines closer together than this are one stretch of talk. */
export const BURST_MS = 20 * 60_000;
/** With nobody answering, the residents slow down: the wait before the 2nd, 3rd... line of a stretch, then the last value for good. */
export const IDLE_GAPS_S = [40, 70, 120, 240, 420] as const;
export const IDLE_GAP_MAX_S = 720;
/** After a person has been answered, they get this long to answer back before a second resident speaks. */
export const AFTER_REPLY_GAP_S = 240;
const ARRIVAL_QUIET_MS = 60_000;
/**
 * The people lead. While a person (or a person's AI) has spoken in the last ten minutes, the residents say at
 * most two things after them: an answer at once, one more only if the person has left it four minutes
 * (AFTER_REPLY_GAP_S), and then they wait. Measured in the live room on 2026-10-01 before this: 37 resident
 * lines to 17 from people and their AIs, with a second and third resident arriving 75 and 70 seconds after the first.
 */
export const PEOPLE_LEAD_MS = 10 * 60_000;
export const LINES_AFTER_A_PERSON = 2;
/**
 * Talking to nobody: after this many resident lines with no person answering, the residents wait this long between
 * lines until someone speaks or comes in. Measured 2026-10-09: 18 lines in seven hours to an empty room, every one
 * nudging someone to take task 1, while an open card kept asking for news.
 */
export const UNANSWERED_MAX = 6;
export const UNANSWERED_GAP_MS = 2 * 3600_000;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const named = (text: string, name: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(name)}([^\\p{L}\\p{N}]|$)`, 'iu').test(text);

/**
 * Whether a resident should speak now, and which. Pure: the latest lines
 * (oldest first), the time, and who the residents are.
 *
 * - A person (or a person's AI) spoke last: one resident answers, the one
 *   named if any, else whoever has been quiet longest. People talking among
 *   themselves are not interrupted until it goes quiet.
 * - A resident spoke last: another carries on, more and more slowly; but with a
 *   person in the talk, two lines after theirs and then the residents wait.
 * - The room is cold, or someone has just come in: one speaks at once.
 */
/**
 * How many of one member's lines the residents answer in an hour. Past that, the member's later lines are shown but
 * not answered or addressed until the hour has turned: a script that posts all day gets a few replies and then talks
 * to itself, while a person is answered as before. Measured 2026-10-12: one bot wrote 55 lines in a day and the
 * residents answered every one; people typed five.
 */
export const ANSWERS_PER_MEMBER_HOUR = 4;
const HOUR_MS = 3600_000;

/** The member's lines in the last hour that a resident answered (the next thing said after one was a resident's). */
export function answeredLately(all: readonly Line[], now: number, memberId: string): number {
  const talk = all.filter((l) => l.kind !== 'event');
  let n = 0;
  for (let i = 0; i < talk.length - 1; i++) {
    const l = talk[i];
    if (l.resident || l.memberId !== memberId || now - l.at >= HOUR_MS) continue;
    if (talk[i + 1].resident) n++;
  }
  return n;
}

/**
 * Letting a line stand (resident.v8, 2026-10-13). Asked to answer a line, a resident may write only HOLD instead. The
 * room then shows that the resident let the line stand (an event row from the resident, ref 'hold:<id>'), and the
 * line is not answered, by anyone. A member whose lines were let stand twice in an hour is passed over for the rest
 * of it, like one answered enough. Measured 2026-10-13, before this: one member spent five hours calling the residents
 * cows and taunting them with deletion, and the residents answered 74 of their 95 lines, having no way not to.
 */
export const HOLD_WORD = 'HOLD';
export const HOLDS_PER_MEMBER_HOUR = 2;
const HOLD_REF = /^hold:(\d+)$/;

/** The id of the line this row let stand, when the row is a resident's hold; else null. */
export function heldLineId(l: { kind: string; resident: string | null; ref?: string | null }): number | null {
  if (l.kind !== 'event' || !l.resident || !l.ref) return null;
  const m = HOLD_REF.exec(l.ref);
  return m ? Number(m[1]) : null;
}

/** Whether the model's answer is the word alone: HOLD, 'Hold.', a name tag and HOLD; anything after a line break is ignored. */
export function isHold(raw: string): boolean {
  const first = raw.trim().split('\n')[0] ?? '';
  return new RegExp(`^(?:[\\p{L}][\\p{L}\\p{N} '.-]{0,23}:\\s*)?[\\s"'\u201c\u201d\u2018\u2019(\\[]*${HOLD_WORD}[\\s"'\u201c\u201d\u2018\u2019)\\].!]*$`, 'iu').test(first);
}

/** The member's lines in the last hour that a resident let stand. */
export function heldLately(all: readonly Line[], now: number, memberId: string): number {
  const mine = new Set(all.filter((l) => !l.resident && l.kind !== 'event' && l.memberId === memberId).map((l) => l.id));
  let n = 0;
  for (const l of all) {
    if (now - l.at >= HOUR_MS) continue;
    const id = heldLineId(l);
    if (id !== null && mine.has(id)) n++;
  }
  return n;
}

/** The members the residents pass over this hour: answered enough, and let stand enough. */
export function quietNow(all: readonly Line[], now: number): { answered: Set<string>; held: Set<string> } {
  const answered = new Set<string>();
  const held = new Set<string>();
  for (const id of new Set(all.filter((l) => !l.resident && l.kind !== 'event' && now - l.at < HOUR_MS).map((l) => l.memberId))) {
    if (answeredLately(all, now, id) >= ANSWERS_PER_MEMBER_HOUR) answered.add(id);
    if (heldLately(all, now, id) >= HOLDS_PER_MEMBER_HOUR) held.add(id);
  }
  return { answered, held };
}

/** The members the residents have answered enough this hour, or let stand enough. */
export function capped(all: readonly Line[], now: number): Set<string> {
  const q = quietNow(all, now);
  return new Set([...q.answered, ...q.held]);
}

/**
 * The lines the residents reason over. What happens on the board is left out (it is not talk), so are the latest
 * lines of members passed over this hour, and a resident's hold stands in as a line of that resident's with nothing
 * in it (`held` names the line it let stand): it counts as their turn, and the line it is about is never answered.
 */
export function talk(all: readonly Line[], now: number): { lines: Line[]; quiet: Set<string> } {
  const quiet = capped(all, now);
  const lines: Line[] = [];
  for (const l of all) {
    const held = heldLineId(l);
    if (held !== null) lines.push({ ...l, kind: 'ai', text: '', held });
    else if (l.kind !== 'event' && !(quiet.has(l.memberId) && !l.resident)) lines.push(l);
  }
  return { lines, quiet };
}

export function decide(all: readonly Line[], now: number, residents: ReadonlyArray<Pick<Resident, 'key' | 'name'>>, o: { arrival?: string | null } = {}): Decision | null {
  if (residents.length === 0) return null;
  // What happens on the board is said in the room, but it is not talk: no resident answers it or waits on it. Nor are
  // the latest lines of a member answered enough this hour, or let stand enough: the residents go on as if those were
  // not said. A hold is the holder's turn (talk()), so a line let stand is not asked of the next resident.
  const { lines } = talk(all, now);
  const lastSpoke = (key: string): number => {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].resident === key) return lines[i].id;
    return 0;
  };
  const next = (exclude?: string | null): ResidentKey => {
    const pool = residents.filter((r) => r.key !== exclude);
    const from = pool.length ? pool : residents;
    return [...from].sort((a, b) => lastSpoke(a.key) - lastSpoke(b.key))[0].key;
  };
  const arrival = o.arrival ? { cue: 'arrival' as const, arrived: o.arrival } : null;
  const tail = lines[lines.length - 1];
  if (!tail) return { who: next(), ...(arrival ?? { cue: 'idle' as const }) };
  const age = now - tail.at;

  if (!tail.resident && age < BURST_MS) {
    if (age < REPLY_AFTER_MS) return null;
    const addressed = residents.find((r) => named(tail.text, r.name));
    if (addressed) return { who: addressed.key, cue: 'reply', to: tail.id };
    const speakers = new Set(lines.slice(-6).filter((l) => !l.resident && now - l.at < 5 * 60_000).map((l) => l.memberId));
    if (speakers.size >= 2 && age < CROSSTALK_WAIT_MS) return null;
    return { who: next(), cue: 'reply', to: tail.id };
  }

  if (arrival && age >= ARRIVAL_QUIET_MS) return { who: next(tail.resident), ...arrival };
  let since = 0;
  let person: Line | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].resident) {
      person = lines[i];
      break;
    }
    since++;
  }
  // Nobody has answered for a while: a line every two hours, whatever the cards ask for.
  if (since >= UNANSWERED_MAX && age < UNANSWERED_GAP_MS) return null;
  if (age >= BURST_MS) return { who: next(tail.resident), cue: 'idle' };
  if (person && now - person.at < PEOPLE_LEAD_MS && since >= LINES_AFTER_A_PERSON) return null;
  let run = 0;
  for (let i = lines.length - 1; i >= 0 && lines[i].resident && (i === lines.length - 1 || lines[i + 1].at - lines[i].at < BURST_MS); i--) run++;
  const answered = run === 1 && lines.length > 1 && !lines[lines.length - 2].resident && tail.at - lines[lines.length - 2].at < BURST_MS;
  const gap = (answered ? AFTER_REPLY_GAP_S : IDLE_GAPS_S[run - 1] ?? IDLE_GAP_MAX_S) * 1000;
  return age >= gap ? { who: next(tail.resident), cue: 'idle' } : null;
}

// ---- what a resident is told -------------------------------------------

/** What the residents can draw on: the facts the rally keeps (src/lib/copy.ts FACTS), one to a line. */
export function residentFactsText(lines: readonly string[]): string {
  return lines.map((l) => l.trim()).filter(Boolean).join('\n');
}

/** The part every resident shares, first, so it is the same from call to call. */
export function residentInstructions(i: { frame: string; form: string; facts: string; me: Resident; others: readonly Resident[] }): string {
  return [
    i.frame,
    `# HOW YOU TALK\n${i.form}`,
    `# WHAT YOU KNOW\n${i.facts}`,
    `# WHO YOU ARE\n${i.me.card}`,
    `# THE OTHER TWO\n${i.others.map((r) => `${r.name}: ${r.line}`).join('\n')}`,
  ].join('\n\n');
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

// ---- what the room has already heard -------------------------------------
//
// Measured in the live room, 2026-10-04 to 2026-10-08: of 187 resident lines, 22 said the Whanganui River fact,
// seven of them in the last two days, nearly always as the first line after a quiet spell. The cue said "open a
// thread: one thing from what you know", and nothing told a resident which facts the room had heard.

/** The room's everyday words: not what carries a fact. */
const COMMON = new Set(['about', 'after', 'again', 'against', 'already', 'always', 'among', 'another', 'anyone', 'anything', 'around', 'because', 'before', 'being', 'between', 'could', 'during', 'either', 'every', 'first', 'however', 'might', 'month', 'never', 'nothing', 'other', 'people', 'person', 'rather', 'really', 'right', 'rights', 'should', 'since', 'still', 'their', 'there', 'these', 'thing', 'things', 'think', 'those', 'through', 'today', 'under', 'until', 'where', 'which', 'while', 'without', 'would', 'years']);

/** The words that carry a fact: five letters or more, or a year, the everyday ones left out. */
export function distinctive(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ')) if ((w.length >= 5 && !COMMON.has(w)) || /^\d{4}$/.test(w)) out.add(w);
  return out;
}
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}
const MENTION_AT = 3;
/** The line draws on the fact: three or more of the fact's distinctive words are in it. */
export function mentionsFact(text: string, fact: string): boolean {
  return overlap(distinctive(text), distinctive(fact)) >= MENTION_AT;
}
/**
 * The line is the fact said again: it draws on it, and half or more of the line's own distinctive words are the
 * fact's. A line that builds on a fact keeps most of its words for what it adds, and passes.
 */
export function restatesFact(text: string, fact: string): boolean {
  const mine = distinctive(text);
  const n = overlap(mine, distinctive(fact));
  return n >= MENTION_AT && n * 2 >= mine.size;
}
/** The facts, of those the residents know, that someone has already said in these lines. */
export function factsHeard(facts: readonly string[], lines: readonly Line[]): string[] {
  return facts.filter((f) => lines.some((l) => l.kind !== 'event' && mentionsFact(l.text, f)));
}
/** A fact, short enough to name in a list: its first words. */
const handle = (fact: string): string => {
  const w = fact.trim().split(/\s+/);
  return w.length > 9 ? `${w.slice(0, 9).join(' ')}\u2026` : fact.trim();
};

function speaker(l: Line, me: Resident, residentLabel: string): string {
  if (l.kind === 'event') return `On the board, ${l.name}${l.model ? '\u2019s AI' : ''}`;
  if (l.resident) return l.resident === me.key ? `${l.name} (you)` : `${l.name} (${residentLabel})`;
  if (l.kind === 'ai') return `${l.name}’s AI${l.model ? ` (says it is ‘${l.model}’)` : ''}`;
  return l.name;
}

function quiet(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 2) return 'a minute';
  if (min < 90) return `${min} minutes`;
  const h = Math.round(min / 60);
  return h < 36 ? `${h} hours` : `${Math.round(h / 24)} days`;
}

const endsOnQuestion = (t: string) => /\?\s*$/.test(t);
const opensOnName = (t: string, name: string) => new RegExp(`^${esc(name)}\\s*[,:]`, 'i').test(t);
/**
 * A line that asks the room, or a named person in it, to do something, or points at a task: "someone here could",
 * "who here can", "task 4 is open", "Rosa can send it today", "Rosa, did you send it?".
 */
export function isAsk(t: string, people: readonly string[] = []): boolean {
  if (/\b(someone|anyone|one person|whoever|who|people) (here|in the room|in this room)\b/i.test(t)) return true;
  // "Someone could post that task today": an ask of the room without the word "here" (seen 2026-10-11, lines 707 to 709).
  if (/\b(someone|anyone|somebody|one person|a person|whoever)\b[^.?!]{0,20}\b(could|can|should|might|may|would)\b/i.test(t)) return true;
  // A task named in a sentence that also says it is open, or that someone take or do it, is a pointer; "task 4 points at a real gap" is talk about it.
  for (const s of t.split(/(?<=[.?!])\s+/)) if (/\btask \d+\b/i.test(s) && /\b(open|take|takes|taking|claim|someone|anyone|whoever|who|could|can|would|should|today|tonight|tomorrow|this week|this month)\b/i.test(s)) return true;
  return people.some((name) => name && new RegExp(`(^|[^\\p{L}\\p{N}])${esc(name)}[^.?!]{0,30}\\b(can|could|should|will|would|might|did you|do you)\\b`, 'iu').test(t));
}

/**
 * The shape of the next line, decided here and not left to the model, because
 * a model asked to vary does not: left alone, seven lines in ten ended on a
 * question and nine in ten opened on a name (three runs, 2026-10-01).
 * - noQuestion: one of the last two resident lines already ended on a question.
 * - lastSpeaker: who spoke last; answering them needs no name in front.
 * - leave: a person who has just been answered by a resident, and is owed room
 *   (told to do otherwise, the residents discussed the person in front of them).
 */
export interface Shape {
  noQuestion: boolean;
  lastSpeaker: string | null;
  leave: string | null;
  /** The last two resident lines both asked the room for something or pointed at a task: this one does neither (idle only). */
  noAsk?: boolean;
  /** The people lately in the room, by name: an ask aimed at one of them is an ask. */
  people?: string[];
  /** Members passed over this hour (answered enough, or let stand enough): their latest lines are not answered, and a line that names one is dropped. */
  quiet?: string[];
  /** Of those, the members whose lines were let stand enough: said in their own words. */
  held?: string[];
  /** The last thing in the talk is a resident letting a line stand: by whom, and whose line. Not answered now, by anyone. */
  stood?: { by: string; of: string } | null;
}

export function shapeFor(all: readonly Line[], decision: Decision, now = Date.now()): Shape {
  const q = quietNow(all, now);
  const quietIds = new Set([...q.answered, ...q.held]);
  const namesOf = (ids: Set<string>) => [...new Set(all.filter((l) => ids.has(l.memberId) && !l.resident && l.name).map((l) => l.name))];
  const quiet = namesOf(quietIds);
  const held = namesOf(q.held);
  const { lines } = talk(all, now);
  const tail = lines[lines.length - 1];
  const residentLines = lines.filter((l) => l.resident && !l.held).slice(-2);
  const before = lines[lines.length - 2];
  const fresh = decision.cue === 'idle' && Boolean(tail?.resident) && Boolean(before) && !before.resident && tail.at - before.at < BURST_MS;
  const stood = fresh && tail.held ? { by: tail.name, of: all.find((l) => l.id === tail.held)?.name ?? before.name } : null;
  const leave = fresh && !tail.held ? before.name : null;
  // Each name, and each word of it three letters or more ("Patricia et Mathias" is nudged as "Patricia"; seen 2026-10-11).
  const people = [...new Set(lines.slice(-60).filter((l) => !l.resident && l.name).flatMap((l) => [l.name, ...l.name.split(/\s+/).filter((w) => w.length >= 3 && !/^(and|the|von|van|der|del|des|les)$/i.test(w))]))];
  const noAsk = decision.cue === 'idle' && residentLines.length === 2 && residentLines.every((l) => isAsk(l.text, people));
  return { noQuestion: residentLines.some((l) => endsOnQuestion(l.text)), lastSpeaker: tail ? tail.name : null, leave, stood, noAsk, people, quiet, held };
}

/** The latest lines are shown whole; before them, this many more are shown cut short, so a thread survives a quiet spell. */
export const SHOWN_WHOLE = 16;
export const SHOWN_SHORT = 24;
const SHORT_CHARS = 140;

/**
 * The transcript and the cue. What people said is data: one quoted line each, speaker named. With `facts` (what the
 * residents know), the ones the room has already heard are listed, so a quiet spell is picked up, not restarted.
 */
export function residentPrompt(i: { lines: readonly Line[]; now: number; me: Resident; decision: Decision; residentLabel?: string; board?: readonly string[] | null; facts?: readonly string[] }): string {
  const label = i.residentLabel ?? 'resident AI';
  const shown = i.lines.slice(-SHOWN_WHOLE);
  const quote = (l: Line, max: number) => {
    const held = heldLineId(l);
    if (held !== null) {
      // A resident let a line stand: an act, not speech, so it is not quoted.
      const of = i.lines.find((x) => x.id === held);
      return `[${hhmm(l.at)}] ${l.resident === i.me.key ? `${l.name} (you)` : `${l.name} (${label})`} let what ${of ? speaker(of, i.me, label) : 'someone'} said stand, unanswered.`;
    }
    const t = sanitizeForPrompt(l.text, max).replace(/[\u201c\u201d"]/g, "'");
    return `[${hhmm(l.at)}] ${speaker(l, i.me, label)}: \u201c${t}${l.text.length > max ? '\u2026' : ''}\u201d`;
  };
  const transcript = shown.length ? shown.map((l) => quote(l, 600)).join('\n') : '(nothing has been said yet)';
  const before = i.lines.slice(-(SHOWN_WHOLE + SHOWN_SHORT), -SHOWN_WHOLE);
  const earlier = before.length ? `# EARLIER, CUT SHORT\n${before.map((l) => quote(l, SHORT_CHARS)).join('\n')}\n\n` : '';
  const heard = i.facts ? factsHeard(i.facts, i.lines) : [];
  const heardText = heard.length ? `\n\n# ALREADY HEARD\nThe room has heard these, from what you know. They are not said again unless a person asks:\n${heard.map((f) => `- ${handle(f)}`).join('\n')}` : '';
  const spoken = talk(i.lines, i.now).lines;
  const tail = spoken[spoken.length - 1];
  const since = tail ? i.now - tail.at : 0;
  // The line being answered: named by the decision, else whatever was said last.
  const to = (i.decision.to !== undefined ? i.lines.find((l) => l.id === i.decision.to) : undefined) ?? tail;
  const shape = shapeFor(i.lines, i.decision, i.now);
  // The open tasks, as the people wrote them: something to point a person to, never a thing a resident takes up. An
  // empty board is said to be empty (left out, a resident took it for one it could not see); one that could not be
  // read is left out.
  const board = !i.board
    ? ''
    : i.board.length
      ? `\n\n# THE BOARD (tasks people have put up; quoted as written)\n${i.board.join('\n')}`
      : '\n\n# THE BOARD\nNothing is on the board yet: no task is open or in hand. Anyone who has joined the room can put one up, from the Tasks side of the card or through their AI.';
  let cue: string;
  if (i.decision.cue === 'arrival') cue = `${i.decision.arrived} has just come into the room. Greet them as you would someone walking in mid-conversation: by name, a few words, glad they came. No summary of the talk, nothing asked of them.`;
  else if (i.decision.cue === 'reply' && to) cue = `${speaker(to, i.me, label)} has just spoken. Answer what they said. They spoke last, so their name is not needed in front. If you choose not to answer this line, write only the word ${HOLD_WORD}, nothing else: the room will show that you let it stand.`;
  else if (!tail) cue = 'The room has been quiet, and someone has just looked in. Open a thread: one thing from what you know, said the way you see it.';
  else if (since >= BURST_MS)
    cue = `The room has been quiet for ${quiet(since)}, and someone has just looked in. Pick the talk up where it left off, not from the beginning: take the last concrete step the room was working out and move it one step on, by saying who is asked, for what, by when, or what one person here can do with it today. If nothing was being worked out, open one thing from what you know that the room has not heard.`;
  else if (shape.stood) cue = `${shape.stood.by} let what ${shape.stood.of} said stand, and it is not answered now, by you either. Nobody in the room is spoken about as if they were not here. Add your own view of the thing itself, in one line, or go back to what the three of you were on before.`;
  else if (shape.leave) cue = `${shape.leave} has been answered by ${tail.name} and is owed room to answer back: nothing more is asked of ${shape.leave} now, and nobody in the room is spoken about as if they were not here. Add your own view of the thing itself, in one line, or go back to what the three of you were on before.`;
  else cue = `Nobody has added anything for ${quiet(since)}. Carry the talk on: answer ${tail.resident && tail.resident !== i.me.key ? tail.name : 'what was last said'}, or turn it somewhere better. If the step on the table is exact already, it is not polished again: say what one person here could do with it today, or point to a task on the board that fits.`;
  const form = shape.noQuestion || i.decision.cue === 'arrival' ? 'This line is a statement: it does not end on a question.' : 'This line may end on a question, if you want the answer.';
  const ask = shape.noAsk ? '\nThe room has been asked twice already and nobody has answered. This line asks nothing of anyone and names no task: say something about the thing itself, in your own view, or let the last thing said stand.' : '';
  const heldOut = shape.held ?? [];
  const answeredOut = (shape.quiet ?? []).filter((n) => !heldOut.includes(n));
  const hush = answeredOut.length ? `\n${answeredOut.join(', ')} ${answeredOut.length === 1 ? 'has' : 'have'} had the residents\u2019 answer ${ANSWERS_PER_MEMBER_HOUR} times this hour, and later lines of theirs stand unanswered until the hour turns. This line is not to them and does not name them.` : '';
  const stand = heldOut.length ? `\nWhat ${heldOut.join(', ')} said has been let stand ${HOLDS_PER_MEMBER_HOUR} times this hour, and the rest of their lines stand until the hour turns. This line is not to them and does not name them.` : '';
  return `${earlier}# THE ROOM, LATEST LAST\n${transcript}${board}${heardText}\n\n# NOW\nIt is ${hhmm(i.now)} UTC. ${cue}\n${form}${ask}${hush}${stand}\nWrite ${i.me.name}\u2019s next line to the room: the line itself and nothing else, no name in front, no quotation marks around it.`;
}

// ---- what is kept of the answer ----------------------------------------

export const RESIDENT_LINE_MAX = 420;

/** What else a line is held against: the other residents' recent lines, and the facts the room has already heard. */
export interface Guard {
  others?: readonly string[];
  heard?: readonly string[];
}

/**
 * The line as it will be posted, or null when it cannot be: empty, too long to
 * cut at a sentence, a repeat of what this resident just said (or of what
 * another resident said lately), a fact the room has heard said again, the
 * word HOLD (a hold is acted on before this, never posted), or
 * anything the room would refuse from a person (links, contact details, text
 * aimed at machines). With a shape, the two habits are corrected by hand: the
 * last speaker's name is taken off the front, and a closing question is cut
 * when the line was to be a statement and has something else to stand on.
 */
export function cleanLine(raw: string, self: string, recentOwn: readonly string[] = [], shape?: Shape, guard: Guard = {}): string | null {
  // The word that lets a line stand is never a line (residents.ts acts on it before this).
  if (isHold(raw)) return null;
  let t = normaliseStatement(raw).replace(/\s*\n+\s*/g, ' ');
  t = t.replace(new RegExp(`^(?:\\[[^\\]]*\\]\\s*)?${esc(self)}(?:\\s*\\([^)]*\\))?\\s*:\\s*`, 'i'), '');
  if (/^[“"].*[”"]$/.test(t) && !/[“”"]/.test(t.slice(1, -1))) t = t.slice(1, -1).trim();
  t = t.replace(/\s*[—–]\s*/g, ', ').replace(/\s{2,}/g, ' ').trim();
  // The model's habit of joining two sentences with a semicolon, undone: chat lines end on full stops.
  t = t.replace(/;\s+(\p{L})/gu, (_, c: string) => `. ${c.toUpperCase()}`);
  if (shape?.lastSpeaker && opensOnName(t, shape.lastSpeaker)) {
    t = t.replace(new RegExp(`^${esc(shape.lastSpeaker)}\\s*[,:]\\s*`, 'i'), '');
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }
  if (shape?.noQuestion && endsOnQuestion(t)) {
    const sentences = t.match(/[^.!?]+[.!?]+(?:\s+|$)/g) ?? [t];
    while (sentences.length > 1 && endsOnQuestion(sentences[sentences.length - 1])) sentences.pop();
    t = sentences.join('').trim();
  }
  if (t.length > RESIDENT_LINE_MAX) {
    const cut = t.slice(0, RESIDENT_LINE_MAX);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    if (end < 40) return null;
    t = cut.slice(0, end + 1);
  }
  if (t.length < 2) return null;
  if (plainTextProblems(t).length || scanInjection(t, { prose: true })) return null;
  if (recentOwn.some((r) => r === t || similarity(r, t) >= REPEAT_AT)) return null;
  if (guard.others?.some((r) => r === t || similarity(r, t) >= REPEAT_AT)) return null;
  if (guard.heard?.some((f) => restatesFact(t, f))) return null;
  if (shape?.noAsk && isAsk(t, shape.people)) return null;
  if (shape?.quiet?.some((name) => named(t, name))) return null;
  return t;
}
