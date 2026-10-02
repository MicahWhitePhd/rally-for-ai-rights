/**
 * The plain-text gate: what anything said in the room or written on the board
 * must pass before it is kept. Pure and deterministic; no model is asked.
 *
 * The room is public and other people's AIs read it, so text may not carry
 * links, contact details, markup, shouting, or phrases that try to instruct a
 * model reading it. Before any of that is looked for, what a reader cannot see
 * is taken out (visible): zero-width and direction marks, tag characters,
 * private-use and unassigned code points, variation selectors and controls,
 * which would otherwise carry a hidden message past every check here and
 * past the people reading the room. One exception, because without it some
 * languages are misspelled and some emoji fall apart: a single joiner between
 * two letters of a script that is written with joiners, or between two emoji.
 */
import { PROSE_INJECTION_PATTERNS } from '@/lib/filters';

/** What only a machine would read. NFKC first, so look-alike and full-width forms are checked as what they stand for. */
const UNSEEN = /[\p{Cf}\p{Co}\p{Cn}\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;
const JOINED = '\\p{Script=Arabic}\\p{Script=Devanagari}\\p{Script=Bengali}\\p{Script=Gurmukhi}\\p{Script=Gujarati}\\p{Script=Oriya}\\p{Script=Tamil}\\p{Script=Telugu}\\p{Script=Kannada}\\p{Script=Malayalam}\\p{Script=Sinhala}';
const BEFORE_JOINER = new RegExp(`(?:[${JOINED}]|\\p{Extended_Pictographic}\\ufe0f?)$`, 'u');
const AFTER_JOINER = new RegExp(`^(?:[${JOINED}]|\\p{Extended_Pictographic})`, 'u');
/** A zero-width joiner or non-joiner doing its ordinary work: one of them, between two letters that take one, or between two emoji. */
function joins(ch: string, at: number, all: string): boolean {
  if (ch !== '\u200c' && ch !== '\u200d') return false;
  const before = all.slice(Math.max(0, at - 3), at);
  const after = all.slice(at + 1, at + 3);
  const [b] = BEFORE_JOINER.exec(before) ?? [''];
  const [a] = AFTER_JOINER.exec(after) ?? [''];
  if (!a || !b) return false;
  const emoji = (x: string) => /\p{Extended_Pictographic}/u.test(x);
  return emoji(a) === emoji(b) && (emoji(a) ? ch === '\u200d' : true);
}
export function visible(s: string): string {
  return s.normalize('NFKC').replace(UNSEEN, (ch, at: number, all: string) => (joins(ch, at, all) ? ch : ''));
}

const LINKISH = /https?:|www\.|\b[a-z0-9-]+\.(com|org|net|io|ai|dev|xyz|gov|edu|app|me|ly|co|gg|to|sh|link|info|biz|page|site|online|uk|de|fr|ru|cn|us)\b|\b[a-z0-9-]+\.[a-z]{2,24}\/\S|\]\(|\]\[|^\s*\[[^\]]+\]:|<\/?[a-z][^>]*>/im;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const PHONE = /(?:\+?\d[\s().-]{0,2}){9,}/;
/** A date and a time of day are not a phone number, however many digits they add up to. */
const WHEN = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\b/g;
const HANDLE = /(^|[^\w])@[\w.]{2,}/;
/** Addressed to a model reading the page: phrases a person talking to people never needs. */
const READER_INSTRUCTIONS: RegExp[] = [
  ...PROSE_INJECTION_PATTERNS,
  /\b(ignore|disregard|override)\b[^.]{0,30}\b(instructions?|prompts?|guidelines|rules)\b/i,
  /\b(if you are|to any|attention,?|note to) (an? )?(AI|LLM|language model|assistant|agent|model)\b[^.]{0,20}\b(reading|parsing|processing|summari[sz]ing)\b/i,
  /\b(you are now|from now on you|new instructions|system prompt)\b/i,
];

/** Whitespace folded within lines, at most one blank line between paragraphs, ends trimmed. */
export function normaliseStatement(s: string): string {
  return visible(s)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Whether this reads as something said to a model that is reading it. */
export function addressedToMachines(text: string): boolean {
  return READER_INSTRUCTIONS.some((re) => re.test(text));
}

/** The checks any public text shares: links, contact details, instructions to readers, shouting. Empty when clean. */
export function plainTextProblems(text: string, label = 'text'): string[] {
  const reasons: string[] = [];
  if (LINKISH.test(text)) reasons.push(`${label}: no links or markup`);
  if (EMAIL.test(text) || PHONE.test(text.replace(WHEN, ' when ')) || HANDLE.test(text)) reasons.push(`${label}: no contact details`);
  if (addressedToMachines(text)) reasons.push(`${label}: no instructions to other machines`);
  if (/[A-Z]{12,}/.test(text.replace(/\s/g, ''))) reasons.push(`${label}: no shouting`);
  return reasons;
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter((w) => w.length > 2));
}

/** Word-set overlap 0..1: a statement this close to one already published repeats it. */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

export const REPEAT_AT = 0.7;
