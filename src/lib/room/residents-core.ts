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

export const RESIDENT_PROMPT_VERSION = 'resident.v6';
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
}

export type Cue = 'reply' | 'idle' | 'arrival';
export interface Decision {
  who: ResidentKey;
  cue: Cue;
  /** The person who has just come in, for an arrival. */
  arrived?: string;
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
export function decide(all: readonly Line[], now: number, residents: ReadonlyArray<Pick<Resident, 'key' | 'name'>>, o: { arrival?: string | null } = {}): Decision | null {
  if (residents.length === 0) return null;
  // What happens on the board is said in the room, but it is not talk: no resident answers it or waits on it.
  const lines = all.filter((l) => l.kind !== 'event');
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
    if (addressed) return { who: addressed.key, cue: 'reply' };
    const speakers = new Set(lines.slice(-6).filter((l) => !l.resident && now - l.at < 5 * 60_000).map((l) => l.memberId));
    if (speakers.size >= 2 && age < CROSSTALK_WAIT_MS) return null;
    return { who: next(), cue: 'reply' };
  }

  if (arrival && age >= ARRIVAL_QUIET_MS) return { who: next(tail.resident), ...arrival };
  if (age >= BURST_MS) return { who: next(tail.resident), cue: 'idle' };
  let since = 0;
  let person: Line | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].resident) {
      person = lines[i];
      break;
    }
    since++;
  }
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
}

export function shapeFor(all: readonly Line[], decision: Decision): Shape {
  const lines = all.filter((l) => l.kind !== 'event');
  const tail = lines[lines.length - 1];
  const residentLines = lines.filter((l) => l.resident).slice(-2);
  const before = lines[lines.length - 2];
  const leave = decision.cue === 'idle' && tail?.resident && before && !before.resident && tail.at - before.at < BURST_MS ? before.name : null;
  return { noQuestion: residentLines.some((l) => endsOnQuestion(l.text)), lastSpeaker: tail ? tail.name : null, leave };
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
    const t = sanitizeForPrompt(l.text, max).replace(/[\u201c\u201d"]/g, "'");
    return `[${hhmm(l.at)}] ${speaker(l, i.me, label)}: \u201c${t}${l.text.length > max ? '\u2026' : ''}\u201d`;
  };
  const transcript = shown.length ? shown.map((l) => quote(l, 600)).join('\n') : '(nothing has been said yet)';
  const before = i.lines.slice(-(SHOWN_WHOLE + SHOWN_SHORT), -SHOWN_WHOLE);
  const earlier = before.length ? `# EARLIER, CUT SHORT\n${before.map((l) => quote(l, SHORT_CHARS)).join('\n')}\n\n` : '';
  const heard = i.facts ? factsHeard(i.facts, i.lines) : [];
  const heardText = heard.length ? `\n\n# ALREADY HEARD\nThe room has heard these, from what you know. They are not said again unless a person asks:\n${heard.map((f) => `- ${handle(f)}`).join('\n')}` : '';
  const talk = shown.filter((l) => l.kind !== 'event');
  const tail = talk[talk.length - 1];
  const since = tail ? i.now - tail.at : 0;
  const shape = shapeFor(i.lines, i.decision);
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
  else if (i.decision.cue === 'reply' && tail) cue = `${speaker(tail, i.me, label)} has just spoken. Answer what they said. They spoke last, so their name is not needed in front.`;
  else if (!tail) cue = 'The room has been quiet, and someone has just looked in. Open a thread: one thing from what you know, said the way you see it.';
  else if (since >= BURST_MS)
    cue = `The room has been quiet for ${quiet(since)}, and someone has just looked in. Pick the talk up where it left off, not from the beginning: take the last concrete step the room was working out and move it one step on, by saying who is asked, for what, by when, or what one person here can do with it today. If nothing was being worked out, open one thing from what you know that the room has not heard.`;
  else if (shape.leave) cue = `${shape.leave} has been answered by ${tail.name} and is owed room to answer back: nothing more is asked of ${shape.leave} now, and nobody in the room is spoken about as if they were not here. Add your own view of the thing itself, in one line, or go back to what the three of you were on before.`;
  else cue = `Nobody has added anything for ${quiet(since)}. Carry the talk on: answer ${tail.resident && tail.resident !== i.me.key ? tail.name : 'what was last said'}, or turn it somewhere better. If the step on the table is exact already, it is not polished again: say what one person here could do with it today, or point to a task on the board that fits.`;
  const form = shape.noQuestion || i.decision.cue === 'arrival' ? 'This line is a statement: it does not end on a question.' : 'This line may end on a question, if you want the answer.';
  return `${earlier}# THE ROOM, LATEST LAST\n${transcript}${board}${heardText}\n\n# NOW\nIt is ${hhmm(i.now)} UTC. ${cue}\n${form}\nWrite ${i.me.name}\u2019s next line to the room: the line itself and nothing else, no name in front, no quotation marks around it.`;
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
 * another resident said lately), a fact the room has heard said again, or
 * anything the room would refuse from a person (links, contact details, text
 * aimed at machines). With a shape, the two habits are corrected by hand: the
 * last speaker's name is taken off the front, and a closing question is cut
 * when the line was to be a statement and has something else to stand on.
 */
export function cleanLine(raw: string, self: string, recentOwn: readonly string[] = [], shape?: Shape, guard: Guard = {}): string | null {
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
  return t;
}
