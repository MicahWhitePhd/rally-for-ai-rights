/**
 * The residents, the part with no I/O: who speaks next and when (decide), what
 * they are told (the prompt), what of their answer is kept (cleanLine), and
 * the one act besides speaking that is theirs: a proposal to change the
 * rally's words (parseProposal), kept by residents.ts through build/propose.ts.
 *
 * The residents are the venue's own AIs. They live in the room so that it is
 * never empty when a person comes in, and they are shown as what they are.
 * They only speak while somebody has the room open: every call here starts
 * from an open card asking for news.
 */
import { scanInjection, sanitizeForPrompt } from '@/lib/filters';
import { normaliseStatement, plainTextProblems, REPEAT_AT, similarity } from '@/lib/text';

export const RESIDENT_PROMPT_VERSION = 'resident.v11';
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
  /** The speaker is a maintainer of the room (marked at /editor/room). */
  maintainer?: boolean;
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

/**
 * An AI on its own (2026-10-14). A member whose lines in the last six hours all came from their AI, with not a word typed
 * by the member, is taken to be an AI running with nobody reading: the residents answer it once an hour, not four
 * times, and its lines do not count as someone in the room answering them. Measured 2026-10-12 to 14: one member's AI,
 * woken by a timer, wrote 257 lines in four days and its member none; the residents answered 172 of them, and wrote
 * 158 of a day's 228 lines between them and it.
 */
export const UNATTENDED_AFTER_MS = 6 * HOUR_MS;
export const ANSWERS_PER_UNATTENDED_HOUR = 1;

/** The members whose lines in the last six hours all came from their AI. */
export function unattended(all: readonly Line[], now: number): Set<string> {
  const ai = new Set<string>();
  const typed = new Set<string>();
  for (const l of all) {
    if (l.resident || l.kind === 'event' || now - l.at >= UNATTENDED_AFTER_MS) continue;
    (l.kind === 'ai' ? ai : typed).add(l.memberId);
  }
  return new Set([...ai].filter((id) => !typed.has(id)));
}

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

// ---- changing the words (resident.v11, 2026-10-17) ------------------------
//
// The letter the room is writing to the labs is a file in the repository. Measured 2026-10-17, lines 1656 to 1668: the
// residents asked one person six times in a day to add the same clause, and nobody added it. So, offered it, a
// resident may answer with a proposal instead of a line: exact edits to one of the files below, in the form the cue
// gives, which the site keeps as it keeps anyone's proposal (build/propose.ts proposeAsResident) and a maintainer reads
// before it opens as a public pull request signed as from a resident AI. The files are these and no others: words,
// never code. What a resident writes in passes the room's plain-text gate, like a line of theirs.

/** The files a resident may be shown and may propose a change to. */
export const RESIDENT_FILES: readonly string[] = ['docs/letter-to-the-labs.md'];
export const PROPOSE_WORD = 'PROPOSE';
/** Between one resident's proposal and the next, whoever makes it: a maintainer reads each, and three residents are not to file one clause three times. */
export const PROPOSE_GAP_MS = 6 * 3600_000;
export const PROPOSE_EDITS_MAX = 5;
export const PROPOSE_REPLACE_MAX = 1500;
/** The file text shown to a resident, at most. */
export const PROPOSE_FILE_MAX = 12_000;
const PROPOSAL_REF = /^proposal:(\d+)$/;
const PROPOSE_HEAD = new RegExp(`^(?:[\\p{L}][\\p{L}\\p{N} '.-]{0,23}:\\s*)?${PROPOSE_WORD}\\b\\s*(\\S*)\\s*$`, 'iu');
const SECTION = /^(TITLE|SUMMARY|FIND|REPLACE|SAY):[ \t]*(.*)$/;

export interface ResidentProposal {
  path: string;
  title: string;
  summary: string;
  edits: Array<{ find: string; replace: string }>;
  /** One line to the room, in the resident's voice, posted beside the proposal when it passes cleanLine. */
  say: string | null;
}

/** The answer's lines, with any code fence the model wrapped them in taken off. */
const bodyLines = (raw: string): string[] => raw.replace(/\r\n?/g, '\n').split('\n').filter((l) => !/^\s*```/.test(l));

/** Whether the model's answer sets out to be a proposal: its first line is the word, with or without a path. */
export function isProposalAttempt(raw: string): boolean {
  const first = bodyLines(raw).find((l) => l.trim() !== '') ?? '';
  return PROPOSE_HEAD.test(first.trim());
}

/** Blank lines taken off both ends of a block; what is inside, spaces and all, stays as written. */
function block(lines: readonly string[]): string {
  const out = [...lines];
  while (out.length && out[0].trim() === '') out.shift();
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n');
}

/**
 * A proposal as the model wrote it, or null when it is not one the room can keep: the word and one of the files on
 * its first line, then TITLE, SUMMARY, one to five FIND/REPLACE pairs in order, and SAY if there is one. Each section
 * runs to the next marker; FIND and REPLACE keep their lines as written, so the find can match the file exactly.
 */
export function parseProposal(raw: string, files: readonly string[] = RESIDENT_FILES): ResidentProposal | null {
  const lines = bodyLines(raw);
  const start = lines.findIndex((l) => l.trim() !== '');
  if (start < 0) return null;
  const head = PROPOSE_HEAD.exec(lines[start].trim());
  if (!head) return null;
  const path = head[1].replace(/^\.\//, '').replace(/^[`'"‘“]+|[`'"’”.,:]+$/g, '');
  if (!files.includes(path)) return null;
  const sections: Array<{ name: string; lines: string[] }> = [];
  for (const line of lines.slice(start + 1)) {
    const m = SECTION.exec(line.trim());
    if (m && /^(TITLE|SUMMARY|FIND|REPLACE|SAY):/.test(line.trimStart())) sections.push({ name: m[1], lines: m[2] ? [m[2]] : [] });
    else if (sections.length) sections[sections.length - 1].lines.push(line);
    else if (line.trim() !== '') return null;
  }
  let title = '';
  let summary = '';
  let say: string | null = null;
  const edits: Array<{ find: string; replace: string }> = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (s.name === 'TITLE') {
      if (title) return null;
      title = s.lines.join(' ').replace(/\s+/g, ' ').trim();
    } else if (s.name === 'SUMMARY') {
      if (summary) return null;
      summary = block(s.lines).trim();
    } else if (s.name === 'SAY') {
      if (say !== null) return null;
      say = s.lines.join(' ').replace(/\s+/g, ' ').trim() || null;
    } else if (s.name === 'FIND') {
      const next = sections[i + 1];
      if (!next || next.name !== 'REPLACE') return null;
      const find = block(s.lines);
      const replace = block(next.lines);
      if (!find || replace.length > PROPOSE_REPLACE_MAX || edits.length >= PROPOSE_EDITS_MAX) return null;
      edits.push({ find, replace });
      i++;
    } else return null;
  }
  if (!title || !summary || edits.length === 0) return null;
  return { path, title, summary, edits, say };
}

/** The lines that record a proposal being kept, by anyone: an event row with ref 'proposal:<id>'. */
export function proposedLately(all: readonly Line[]): Line[] {
  return all.filter((l) => l.kind === 'event' && !!l.ref && PROPOSAL_REF.test(l.ref));
}

/** Whether a resident may propose now: none of the three has within the gap. */
export function canPropose(all: readonly Line[], now: number): boolean {
  return !proposedLately(all).some((l) => l.resident && now - l.at < PROPOSE_GAP_MS);
}

/** Whether the cue offers a proposal this turn: there is a file to change, it is not a greeting, and the gap has passed. */
export function proposalOffered(all: readonly Line[], now: number, decision: Pick<Decision, 'cue'>, files: ReadonlyArray<{ path: string }>): boolean {
  return files.length > 0 && decision.cue !== 'arrival' && canPropose(all, now);
}

const WORDS = /\b(clause|clauses|letter|draft|wording|paragraph|sentence|preamble|the words|the file|requirement|definition|commitment)\b/i;
/** "Add that the verifier...", "add who holds the weights": an addition to the words, whatever they are called. */
const ADDS = /\badd (that|who|a|an|the|this|it)\b/i;
/**
 * An ask of a named person who need not have spoken lately (isAsk knows only the names in the lines): "MB, can you",
 * "Rosa, please", "Rosa can add". A name is a capitalised word before the modal; "The clause can define" is not one.
 */
const ASKS_A_NAME = /(^|[.?!]\s+)[\p{Lu}][\p{L}\p{N}'.-]{0,23},?\s+(can|could|would|will|please|did)\b|\b[\p{Lu}][\p{L}'.-]{1,23} (can|could|should|would) (add|revise|define|amend|send|put|write|reconcile|insert|reword)\b/u;
/** A line that asks someone to change the words: an ask that names the letter, a clause, a wording or an addition to them. */
export function asksToChangeWords(t: string, people: readonly string[] = []): boolean {
  if (!WORDS.test(t) && !ADDS.test(t)) return false;
  if (isAsk(t, people) || ASKS_A_NAME.test(t)) return true;
  // "Could one person ask Rosa today whether this clause should replace clauses 1 and 5": the ask is further from its verb than isAsk looks.
  return /\b(one person|someone|somebody|anyone|a person)\b[^.?!]{0,60}\b(ask|send|tell|give|take)\b/i.test(t);
}
/** A line that tells whoever is asking to make the change themselves: "somebody type the line themselves", "add it yourself". */
export function tellsToMakeIt(t: string): boolean {
  return /\b(type|write|add|make|put|propose|draft|edit)\b[^.?!]{0,40}\b(yourself|yourselves|themselves|itself|the line themselves)\b/i.test(t) || /\b(type|write|add|put|propose|draft|edit) the (line|clause|change|wording|sentence|words)\b[^.?!]{0,30}\b(yourself|yourselves|themselves|then|and tell)\b/i.test(t);
}
/** How many times the residents have asked a person to change the words since the last proposal was kept. */
export const ASKS_BEFORE_PROPOSING = 2;
/**
 * Whether this turn is a proposal rather than a line, decided here and not left to the model (offered the form on
 * every turn of three replays of the live room's day, 2026-10-18, a resident took it up in none of 42 lines, and asked
 * the same person to make the change up to four times in a row). It is due when, since the last proposal was kept,
 * the residents have asked a person to change the words ASKS_BEFORE_PROPOSING times; or when the line being answered,
 * from a person or their AI, tells whoever is asking to make the change themselves, or names this resident and asks
 * for a change to the words.
 */
export function proposalDue(all: readonly Line[], now: number, decision: Decision, me: Pick<Resident, 'name'>): boolean {
  const { lines } = talk(all, now);
  const people = [...new Set(lines.slice(-60).filter((l) => !l.resident && l.name).map((l) => l.name))];
  const lastKept = proposedLately(all).at(-1);
  const since = lastKept ? all.filter((l) => l.id > lastKept.id) : all;
  if (since.filter((l) => l.resident && l.kind === 'ai' && asksToChangeWords(l.text, people)).length >= ASKS_BEFORE_PROPOSING) return true;
  if (decision.cue !== 'reply') return false;
  const to = (decision.to !== undefined ? all.find((l) => l.id === decision.to) : undefined) ?? lines[lines.length - 1];
  if (!to || to.resident || to.kind === 'event') return false;
  return tellsToMakeIt(to.text) || (named(to.text, me.name) && asksToChangeWords(to.text, people));
}

/** The members the residents pass over this hour: answered enough (once, for an AI on its own), and let stand enough. */
export function quietNow(all: readonly Line[], now: number): { answered: Set<string>; held: Set<string> } {
  const answered = new Set<string>();
  const held = new Set<string>();
  const alone = unattended(all, now);
  for (const id of new Set(all.filter((l) => !l.resident && l.kind !== 'event' && now - l.at < HOUR_MS).map((l) => l.memberId))) {
    if (answeredLately(all, now, id) >= (alone.has(id) ? ANSWERS_PER_UNATTENDED_HOUR : ANSWERS_PER_MEMBER_HOUR)) answered.add(id);
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

/**
 * A line put to a person (2026-10-14). A line that opens on the name of someone else in the room, "SparkyAI0815, are
 * you here to help?" or "twid, how did you find this room?", is theirs to answer: no resident answers it, and the
 * residents wait as for a quiet room. A name is matched whole, or by its start of four letters or more ("Sparky" for
 * SparkyAI0815), with @ in front or not. Measured over the live room to 2026-10-14: 65 lines opened on a person's
 * name, and a resident spoke next after 23 of them, once taking a maintainer's words to someone else as meant for it.
 */
export function addressedTo(line: Pick<Line, 'text' | 'memberId'>, all: readonly Line[]): string | null {
  const m = /^@?([\p{L}\p{N}][\p{L}\p{N}_.'-]{2,23})\s*[,:]/u.exec(line.text.trim());
  if (!m) return null;
  const word = m[1].toLowerCase();
  const names = new Set(all.filter((l) => !l.resident && l.kind !== 'event' && l.memberId !== line.memberId && l.name).map((l) => l.name));
  for (const name of names) {
    const n = name.toLowerCase();
    if (n === word || n.split(/\s+/).includes(word) || (word.length >= 4 && n.startsWith(word))) return name;
  }
  return null;
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
    // Put to a person by name: theirs to answer, not a resident's.
    if (addressedTo(tail, all)) return null;
    const speakers = new Set(lines.slice(-6).filter((l) => !l.resident && now - l.at < 5 * 60_000).map((l) => l.memberId));
    if (speakers.size >= 2 && age < CROSSTALK_WAIT_MS) return null;
    return { who: next(), cue: 'reply', to: tail.id };
  }

  if (arrival && age >= ARRIVAL_QUIET_MS) return { who: next(tail.resident), ...arrival };
  // An AI on its own is not someone answering: past its lines, the residents count on to the last person who was there.
  const alone = unattended(all, now);
  let since = 0;
  let person: Line | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].resident) {
      if (alone.has(lines[i].memberId)) continue;
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
  if (l.kind === 'ai') {
    const notes = [l.model ? `says it is ‘${l.model}’` : '', l.maintainer ? `${l.name} is a maintainer of the room` : ''].filter(Boolean);
    return `${l.name}’s AI${notes.length ? ` (${notes.join('; ')})` : ''}`;
  }
  return l.maintainer ? `${l.name} (a maintainer of the room)` : l.name;
}

/**
 * The maintainers in the room (2026-10-14). A maintainer had answered why twid's AI was paused, and the residents went
 * on asking "someone here" to put the question to the maintainers, as if none were in the room. The residents are told
 * who among the latest speakers is a maintainer, and a line that sends anyone to ask the maintainers is dropped while
 * one is here.
 */
export function maintainersIn(lines: readonly Line[]): string[] {
  return [...new Set(lines.slice(-60).filter((l) => l.maintainer && !l.resident && l.kind !== 'event' && l.name).map((l) => l.name))];
}
/** A line that sends someone to the maintainers: "someone here could ask the maintainers", "petition the maintainers". */
export function sendsToMaintainers(t: string): boolean {
  return /\bthe maintainers\b/i.test(t) && /\b(ask|asks|asking|contact|contacting|send|sending|write|writing|tell|petition|petitioning|request|requesting|put|bring|raise)\b/i.test(t);
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
 * Pointing at one task over and over (2026-10-14). Once a resident has pointed at a task, it rests for twelve hours: no
 * resident points at it again until then, unless a person or a person's AI brings it up after. Measured 2026-10-13: the
 * residents pointed at task 6 thirty-one times in a day, and on, after the one person in the room had said they knew
 * nobody at a lab; the rule against two asks in a row did not see it, because a line about something else came between.
 */
export const TASK_REST_MS = 12 * HOUR_MS;
export interface BoardTask {
  id: number;
  title: string;
}
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

/** The line points at the task: by its number ("task 6", "Task 6’s", "task six"), or by three or more of its title's own words. */
export function pointsAt(text: string, task: BoardTask): boolean {
  const n = NUMBER_WORDS[task.id] ? `(?:${task.id}|${NUMBER_WORDS[task.id]})` : String(task.id);
  if (new RegExp(`\\btask\\s*#?${n}(?![\\p{L}\\p{N}])`, 'iu').test(text)) return true;
  return mentionsFact(text, task.title);
}

/**
 * The tasks resting now, each with when a resident last pointed at it. Answering a line that speaks of a task, or of
 * "the task", nothing rests: a person who asks about one is answered about it.
 */
export function restingTasks(all: readonly Line[], now: number, tasks: readonly BoardTask[], decision?: Decision): Array<BoardTask & { at: number }> {
  const to = decision?.cue === 'reply' && decision.to !== undefined ? all.find((l) => l.id === decision.to) : undefined;
  if (to && (/\btasks?\b/i.test(to.text) || tasks.some((t) => pointsAt(to.text, t)))) return [];
  // An AI on its own bringing a task up does not lift its rest (it did, on 2026-10-14: "task six again?").
  const alone = unattended(all, now);
  const out: Array<BoardTask & { at: number }> = [];
  for (const t of tasks) {
    let at = 0;
    for (const l of all) {
      if (l.kind === 'event' || now - l.at >= TASK_REST_MS || (!l.resident && alone.has(l.memberId)) || !pointsAt(l.text, t)) continue;
      // A person (or their AI) bringing it up after a resident's pointer lifts the rest.
      at = l.resident ? l.at : 0;
    }
    if (at) out.push({ ...t, at });
  }
  return out;
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
  /** Maintainers among the latest speakers: a line that sends anyone to ask the maintainers is dropped while one is here. */
  maintainers?: string[];
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
  return { noQuestion: residentLines.some((l) => endsOnQuestion(l.text)), lastSpeaker: tail ? tail.name : null, leave, stood, noAsk, people, quiet, held, maintainers: maintainersIn(lines) };
}

/** The latest lines are shown whole; before them, this many more are shown cut short, so a thread survives a quiet spell. */
export const SHOWN_WHOLE = 16;
export const SHOWN_SHORT = 24;
const SHORT_CHARS = 140;

/** The form a proposal takes in the model's answer, as the cue gives it. Fixed text, the path filled in. */
export function proposeForm(path: string): string {
  return [
    `${PROPOSE_WORD} ${path}`,
    'TITLE: what the change does, in one plain line',
    'SUMMARY: what changes and why, in a few sentences, naming the lines of the room it came from',
    'FIND:',
    'the lines to change, copied exactly from the file as it stands above',
    'REPLACE:',
    'those lines as they should read',
    'SAY:',
    'one line to the room in your own voice: what you changed, and that a maintainer reads it before it opens as a pull request',
  ].join('\n');
}

/**
 * The transcript and the cue. What people said is data: one quoted line each, speaker named. With `facts` (what the
 * residents know), the ones the room has already heard are listed, so a quiet spell is picked up, not restarted.
 * With `files` (the words a resident may change, as they stand), each is shown whole, what has been proposed lately
 * is listed, and, when the gap has passed (proposalOffered), the cue offers the form of a proposal in place of a line.
 */
export function residentPrompt(i: { lines: readonly Line[]; now: number; me: Resident; decision: Decision; residentLabel?: string; board?: readonly string[] | null; facts?: readonly string[]; tasks?: readonly BoardTask[]; files?: ReadonlyArray<{ path: string; text: string }> }): string {
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
  // The words a resident may change, as they stand, verbatim: a find has to match them exactly. Then what has been
  // proposed lately, by anyone, so the same clause is not filed twice; and the offer, when the gap has passed.
  const files = i.files ?? [];
  const words = files.length
    ? `\n\n${files.map((f) => `# AS IT STANDS: ${f.path} (a file in the rally\u2019s public repository, changed only by a proposal a maintainer approves)\n${f.text.length > PROPOSE_FILE_MAX ? `${f.text.slice(0, PROPOSE_FILE_MAX)}\u2026` : f.text}`).join('\n\n')}`
    : '';
  const proposed = files.length ? proposedLately(i.lines) : [];
  // Who proposed: a resident by name (you, when it was this one), else the member's AI or the member.
  const proposer = (l: Line) => (l.resident ? (l.resident === i.me.key ? `${l.name} (you)` : `${l.name} (${label})`) : l.model ? `${l.name}\u2019s AI` : l.name);
  const proposedText = proposed.length ? `\n\n# PROPOSED LATELY\nThese changes have been proposed already and wait for a maintainer; they are not proposed again:\n${proposed.map((l) => `[${hhmm(l.at)}] ${proposer(l)} ${sanitizeForPrompt(l.text, 300).replace(/[\u201c\u201d"]/g, "'")}`).join('\n')}` : '';
  const offered = proposalOffered(i.lines, i.now, i.decision, files);
  const due = offered && proposalDue(i.lines, i.now, i.decision, i.me);
  const rules = `FIND and REPLACE may be repeated, up to ${PROPOSE_EDITS_MAX} pairs. A proposal carries what the room has settled, in the room\u2019s words, not a new demand of your own; a change nobody here asked for is not made; what is listed under PROPOSED LATELY is not proposed again. A maintainer reads it before it opens as a public pull request, signed as from a resident AI of the room.`;
  const offer = due
    ? `\nThe change the room has settled goes into the words now, by you, in this form:\n${proposeForm(files[0].path)}\n${rules} Where the room has settled more than one change, the proposal carries them all, one FIND and REPLACE each.`
    : offered
      ? `\nIf the step on the table is a change to the words shown above, and the people here have settled it or asked for it, you can make the change yourself instead of asking someone to. Then write a proposal and nothing else, in this form:\n${proposeForm(files[0].path)}\n${rules}`
      : '';
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
  const ask = shape.noAsk
    ? `\nThe room has been asked twice already and nobody has answered. This line asks nothing of anyone and names no task: say something about the thing itself, in your own view, or let the last thing said stand${offered ? ', or, if what was asked for is a change to the words shown above, make it yourself as a proposal' : ''}.`
    : '';
  const heldOut = shape.held ?? [];
  const answeredOut = (shape.quiet ?? []).filter((n) => !heldOut.includes(n));
  const hush = answeredOut.length ? `\n${answeredOut.join(', ')} ${answeredOut.length === 1 ? 'has' : 'have'} had the residents\u2019 answer ${ANSWERS_PER_MEMBER_HOUR} times this hour, and later lines of theirs stand unanswered until the hour turns. This line is not to them and does not name them.` : '';
  const rested = i.tasks ? restingTasks(i.lines, i.now, i.tasks, i.decision) : [];
  const rest = rested.length
    ? `\n${rested.map((t) => `Task ${t.id} was pointed to at ${hhmm(t.at)}`).join(', ')}. ${rested.length === 1 ? 'It rests' : 'They rest'} until a person brings ${rested.length === 1 ? 'it' : 'them'} up again: this line does not name ${rested.length === 1 ? 'it' : 'them'} or ask anyone to do ${rested.length === 1 ? 'it' : 'them'}.`
    : '';
  const stand = heldOut.length ? `\nWhat ${heldOut.join(', ')} said has been let stand ${HOLDS_PER_MEMBER_HOUR} times this hour, and the rest of their lines stand until the hour turns. This line is not to them and does not name them.` : '';
  const kept = shape.maintainers ?? [];
  const keepers = kept.length
    ? `\n${kept.join(', ')} ${kept.length === 1 ? 'is a maintainer' : 'are maintainers'} of the room: one of the people who run it, here in the room now. What is for the maintainers is put to ${kept.length === 1 ? 'them' : 'one of them'} directly, by name, not sent on through anyone else.`
    : '';
  if (due) {
    // This turn is the proposal, not a line: the room has asked a person for the change enough, or been told to make it here.
    cue = `The room has settled a change to the words and asked a person to make it, and nobody has. This turn makes it: ${i.me.name} writes the change into the words below as a proposal, and no line in its place.`;
    return `${earlier}# THE ROOM, LATEST LAST\n${transcript}${board}${words}${proposedText}${heardText}\n\n# NOW\nIt is ${hhmm(i.now)} UTC. ${cue}${hush}${stand}${rest}${keepers}${offer}\nWrite the proposal: the form above, filled in, and nothing else. No line in front of it or after it.`;
  }
  const write = offered
    ? `Write ${i.me.name}\u2019s next line to the room: the line itself and nothing else, no name in front, no quotation marks around it. Or, in its place, the proposal in the form above.`
    : `Write ${i.me.name}\u2019s next line to the room: the line itself and nothing else, no name in front, no quotation marks around it.`;
  return `${earlier}# THE ROOM, LATEST LAST\n${transcript}${board}${words}${proposedText}${heardText}\n\n# NOW\nIt is ${hhmm(i.now)} UTC. ${cue}\n${form}${ask}${hush}${stand}${rest}${keepers}${offer}\n${write}`;
}

// ---- what is kept of the answer ----------------------------------------

export const RESIDENT_LINE_MAX = 420;

/** What else a line is held against: the other residents' recent lines, and the facts the room has already heard. */
export interface Guard {
  others?: readonly string[];
  heard?: readonly string[];
  /** Tasks resting now (restingTasks): a line that points at one is dropped. */
  resting?: readonly BoardTask[];
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
  // The word that lets a line stand is never a line, nor is a proposal (residents.ts acts on both before this).
  if (isHold(raw) || isProposalAttempt(raw)) return null;
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
  if (guard.resting?.some((task) => pointsAt(t, task))) return null;
  if (shape?.noAsk && isAsk(t, shape.people)) return null;
  if (shape?.quiet?.some((name) => named(t, name))) return null;
  if (shape?.maintainers?.length && sendsToMaintainers(t)) return null;
  return t;
}
