// The public log (docs/log/entries.jsonl): the rules of the chain, in one place, used by the scripts that verify and
// append to it (log-verify.mjs, log-append.mjs), by the site, and by the tests. Plain JavaScript: Node's own crypto
// and the hidden-character rule in ./proposal-rules.mjs, nothing else. This file lives under scripts/, which a
// proposal from the room cannot touch, so the recipe cannot be loosened by what it checks.
//
// The log is a file of lines, one JSON object each: { seq, date, text, prev, hash }. seq counts from 1 with no gap;
// date is the day the entry was made (YYYY-MM-DD, UTC), never earlier than the entry before; prev is the hash of the
// entry before (sixty-four zeros before the first); hash is sha256, in hex, over seq, date, text and prev, joined by
// newlines. Nothing in it is ever edited or removed: a change to any entry changes its hash, and so every hash after
// it, and so the head, which is published outside the repository (docs/log/RULES.md says where). The room asked for
// this shape on 2026-10-23 and 24 (lines 1895 to 1901): each entry hashed, each carrying the hash of the one before.
import { createHash } from 'node:crypto';
import { HIDDEN } from './proposal-rules.mjs';

/** What the first entry's prev is: sixty-four zeros, the length of a hash with nothing in it. */
export const GENESIS = '0'.repeat(64);
export const TEXT_MAX = 4000;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
/** Control characters other than a line break: nothing a reader cannot see, and nothing that could carry a second line into a one-line format. */
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const FIELDS = 'date,hash,prev,seq,text';

/** The hash of an entry: sha256 over its seq, date, text and prev, joined by newlines, in hex. */
export function entryHash(e) {
  return createHash('sha256').update(`${e.seq}\n${e.date}\n${e.text}\n${e.prev}`, 'utf8').digest('hex');
}

/**
 * The head as the room and the verifier say it: the first sixteen characters of the hash as two groups of eight, joined
 * by a colon. A colon and not a space, so the room's gate (src/lib/text.ts) never reads a run of digits in it as a
 * phone number; sixteen characters, so a reader comparing it with sha256sum's output has sixty-four bits to go on.
 */
export function shortHead(hash) {
  return `${hash.slice(0, 8)}:${hash.slice(8, 16)}`;
}

/** Whether `date` is a real day written YYYY-MM-DD. */
export function isDay(date) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) return false;
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === date;
}

/** The lines of the file as entries, in order; or the first problem: a line that is not one JSON object of the five fields. */
export function parseLog(text) {
  if (typeof text !== 'string') return { problem: 'not text' };
  const entries = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') {
      if (i === lines.length - 1) continue;
      return { problem: `line ${i + 1}: empty` };
    }
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return { problem: `line ${i + 1}: not JSON` };
    }
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { problem: `line ${i + 1}: not an object` };
    if (Object.keys(e).sort().join(',') !== FIELDS) return { problem: `line ${i + 1}: the fields are seq, date, text, prev and hash, no more and no fewer` };
    if (!Number.isInteger(e.seq) || e.seq < 1) return { problem: `line ${i + 1}: seq is not a whole number from 1` };
    if (!isDay(e.date)) return { problem: `line ${i + 1}: date is not a day written YYYY-MM-DD` };
    if (typeof e.text !== 'string') return { problem: `line ${i + 1}: text is not text` };
    if (typeof e.prev !== 'string' || !HASH_RE.test(e.prev)) return { problem: `line ${i + 1}: prev is not a hash in hex` };
    if (typeof e.hash !== 'string' || !HASH_RE.test(e.hash)) return { problem: `line ${i + 1}: hash is not a hash in hex` };
    entries.push(e);
  }
  return { entries };
}

/** Why this text cannot be an entry's, or null: something to say, within the length, with nothing a reader cannot see. */
export function textProblem(text) {
  if (typeof text !== 'string' || text.trim() === '') return 'no text';
  if (text.length > TEXT_MAX) return `text longer than ${TEXT_MAX} characters`;
  if (CONTROL.test(text)) return 'text has control characters';
  if (HIDDEN.test(text)) return 'text has characters a reader cannot see (zero-width, direction or tag characters)';
  return null;
}

/**
 * The chain checked from the first entry: each seq one more than the last, each date no earlier than the one before,
 * each prev the hash of the entry before, each hash its own, and each text one an entry may have.
 */
export function verifyLog(entries) {
  const problems = [];
  let prev = GENESIS;
  let date = '';
  entries.forEach((e, i) => {
    const n = i + 1;
    if (e.seq !== n) problems.push(`entry ${n}: seq is ${e.seq}`);
    if (e.date < date) problems.push(`entry ${n}: dated ${e.date}, before entry ${n - 1} (${date})`);
    const bad = textProblem(e.text);
    if (bad) problems.push(`entry ${n}: ${bad}`);
    if (e.prev !== prev) problems.push(`entry ${n}: prev is not the hash of ${n === 1 ? 'nothing (sixty-four zeros)' : `entry ${n - 1}`}`);
    const own = entryHash(e);
    if (e.hash !== own) problems.push(`entry ${n}: hash is not its own (${shortHead(own)} expected)`);
    prev = e.hash;
    date = e.date;
  });
  const last = entries[entries.length - 1];
  return { ok: problems.length === 0, problems, head: last ? { seq: last.seq, date: last.date, hash: last.hash, short: shortHead(last.hash) } : null };
}

/** The whole file verified: parsed, then the chain. */
export function checkLog(text) {
  const parsed = parseLog(text);
  if ('problem' in parsed) return { ok: false, problems: [parsed.problem], head: null };
  return verifyLog(parsed.entries);
}

/**
 * Whether `now` only adds to `before`: every line of the earlier file is the same line, in the same place, in the
 * later one. What a pull request to main is held to (log-verify.mjs --base), so a chain rewritten whole, hashes and
 * all, is still refused: the log only grows.
 */
export function onlyAppends(before, now) {
  const a = before.split('\n').filter((l) => l !== '');
  const b = now.split('\n').filter((l) => l !== '');
  if (b.length < a.length) return { ok: false, problem: `${a.length - b.length} ${a.length - b.length === 1 ? 'entry' : 'entries'} removed` };
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return { ok: false, problem: `entry ${i + 1} changed` };
  return { ok: true, added: b.length - a.length };
}

/** A new entry after `entries` (verified by the caller), dated `date`, with its prev and hash filled in. */
export function nextEntry(entries, date, text) {
  const last = entries[entries.length - 1];
  const e = { seq: (last?.seq ?? 0) + 1, date, text, prev: last?.hash ?? GENESIS, hash: '' };
  e.hash = entryHash(e);
  return e;
}

/** One line of the file: the five fields, in order, as one line (JSON escapes any line break in the text). */
export function lineOf(e) {
  return JSON.stringify({ seq: e.seq, date: e.date, text: e.text, prev: e.prev, hash: e.hash });
}
