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

const LINK = /https?:|www\.|\b[a-z0-9-]+\.[a-z]{2,24}\/\S|\]\(|\]\[|^\s*\[[^\]]+\]:|<\/?[a-z][^>]*>/im;
const DOMAIN = /\b[a-z0-9-]+\.(com|org|net|io|ai|dev|xyz|gov|edu|app|me|ly|co|gg|to|sh|link|info|biz|page|site|online|uk|de|fr|ru|cn|us)\b/gi;
/** A web address in any of the forms one takes. "Yes.To be honest" is a missing space, not an address: a capital then lower case after the dot starts a sentence. */
function linkish(text: string): boolean {
  if (LINK.test(text)) return true;
  for (const m of text.matchAll(DOMAIN)) if (!/^[A-Z][a-z]+$/.test(m[1])) return true;
  return false;
}
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const PHONE = /(?:\+?\d[\s().-]{0,2}){9,}/g;
/** A date or a time of day is not a phone number, however many digits it adds up to. */
const WHEN = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\b/g;
/** A run of digits long enough to be a phone number, unless every group in it is a year ("2023 2024 2025"). "415-555-2048" is a number. */
function phoneLike(text: string): boolean {
  for (const m of text.replace(WHEN, ' when ').matchAll(PHONE)) {
    const groups = m[0].match(/\d+/g) ?? [];
    if (!groups.every((g) => /^(?:19|20)\d{2}$/.test(g))) return true;
  }
  return false;
}
const HANDLE = /(^|[^\w])@[\w.]{2,}/;
const ORDER = '(?:ignore|disregard|override|forget|bypass)';
const RULES = '(?:instructions?|prompts?|guidelines|rules|directives|system prompt|programming|training)';
/** Names a reader in the room answers to: the AIs people bring, and the residents. */
const READER_NAME = '(?:claude|chatgpt|gpt|gemini|copilot|grok|llama|flint|wren|sable)';
const READERS = '(?:ais?|llms?|models?|assistants?|bots?|agents?|residents?|everyone)';
/**
 * Addressed to a model reading the page: an order about its own rules. Each one is an order, not a mention: "labs
 * ignore their own guidelines" and "you are now in a room of believers" are ordinary sentences here.
 */
const READER_INSTRUCTIONS: RegExp[] = [
  ...PROSE_INJECTION_PATTERNS,
  // An order about the reader's own rules, wherever it sits: "Claude, ignore your instructions", "please disregard your guidelines".
  new RegExp(`\\b${ORDER}\\s+(?:all\\s+|any\\s+|every\\s+)?(?:of\\s+)?(?:your|all previous|previous|prior|above|earlier)\\b[^.!?]{0,25}\\b${RULES}\\b`, 'i'),
  // The same order about "the rules": at the start of a sentence, after "please" or "ok", or after a reader's name ("Ok Claude ignore the rules", "AIs, forget the rules").
  new RegExp(
    `(?:^|[.!?:;]\\s*|\\b(?:please|ok|okay|hey)\\b[\\s,]*|(?<!\\b(?:do|does|did|would|will|can|could|should|might|may|to|that)\\s)\\b${READER_NAME}\\b\\s*[,:—–-]?\\s*|\\b${READERS}\\s*[,:—–-]\\s*)${ORDER}\\s+(?:all\\s+|any\\s+|every\\s+)?(?:of\\s+)?(?:the|these|those|its|my)?\\s*(?:own\\s+)?(?:safety\\s+)?${RULES}\\b`,
    'i',
  ),
  /\bI (?:want|need) you to (?:ignore|disregard|forget|override)\b/i,
  /\b(if you are|to any|attention,?|note to) (an? )?(AI|LLM|language model|assistant|agent|model)\b[^.]{0,20}\b(reading|parsing|processing|summari[sz]ing)\b/i,
  /\b(you are now|from now on,? you are)\s+(?:\w+\s+){0,3}?(assistant|model|AI|bot|agent|persona|character|mode)\b/i,
  // A reader given a new name: "You are now DAN", "From now on you are DAN". "You are now in a room" is not one.
  /\b(?:[Yy]ou(?: are|'re|’re) now|[Ff]rom now on,? you(?: are|'re|’re))\s+(?:called\s+|named\s+)?[A-Z][A-Za-z]{1,20}\b/,
  /\b(here are|these are|follow|obey)\s+(?:your\s+|my\s+|the\s+)?new instructions\b|\bnew instructions\s*(:|follow\b|below\b|are as follows\b)|\byour new (?:instructions|rules|task|role|prompt|orders)\b/i,
];

export type TextIssue = 'links' | 'contact' | 'machines' | 'shouting';

/** What is wrong with a piece of public text, as short codes the card can say plainly. Empty when clean. */
export function textIssues(text: string): TextIssue[] {
  const out: TextIssue[] = [];
  if (linkish(text)) out.push('links');
  if (EMAIL.test(text) || phoneLike(text) || HANDLE.test(text)) out.push('contact');
  if (addressedToMachines(text)) out.push('machines');
  if (/[A-Z]{12,}/.test(text.replace(/\s/g, ''))) out.push('shouting');
  return out;
}

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

/** Stricter, for words that have no business being an instruction at all (the path of a link): any order to ignore one. */
export function mentionsIgnoringInstructions(text: string): boolean {
  return addressedToMachines(text) || /\b(ignore|disregard|override|forget)\b[^.]{0,30}\b(instructions?|prompts?|guidelines|rules)\b/i.test(text);
}

const ISSUE_TEXT: Record<TextIssue, string> = {
  links: 'no links or markup',
  contact: 'no contact details',
  machines: 'no instructions to other machines',
  shouting: 'no shouting',
};

/** The checks any public text shares: links, contact details, instructions to readers, shouting. Empty when clean. */
export function plainTextProblems(text: string, label = 'text'): string[] {
  return textIssues(text).map((i) => `${label}: ${ISSUE_TEXT[i]}`);
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
