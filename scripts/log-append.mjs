// Appends one entry to the public log (docs/log/entries.jsonl), its prev and hash filled in (./log-chain.mjs), after
// verifying the chain as it stands: a broken chain gets nothing added. Then the change goes in like any other, by a
// pull request; the log changes in no other way (docs/log/RULES.md).
//
//   node scripts/log-append.mjs "the text of the entry"          dated today, UTC
//   node scripts/log-append.mjs --date 2026-10-24 "the text"      dated that day (never before the entry before)
//   echo "the text" | node scripts/log-append.mjs                  the text from stdin
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLog, isDay, lineOf, nextEntry, parseLog, shortHead, textProblem } from './log-chain.mjs';
import { LOG_PATH } from './log-verify.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The date and the text from the arguments: `--date` and the day after it are the date, everything else is the text,
 * in order. Without `--date` the date is `today`, and every argument is text (an earlier version dropped the first).
 * @param {string[]} args
 * @param {string} today
 * @returns {{ date: string, given: string }}
 */
export function parseArgs(args, today) {
  const at = args.indexOf('--date');
  const date = at >= 0 ? (args[at + 1] ?? '') : today;
  const given = args.filter((a, i) => at < 0 || (i !== at && i !== at + 1)).join(' ');
  return { date, given };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { date, given } = parseArgs(process.argv.slice(2), new Date().toISOString().slice(0, 10));
  const text = (given || readFileSync(0, 'utf8')).replace(/\r\n?/g, '\n').trim();
  if (!isDay(date)) {
    console.error(`not a day: ${date}`);
    process.exit(1);
  }
  const bad = textProblem(text);
  if (bad) {
    console.error(bad);
    process.exit(1);
  }
  const path = resolve(root, LOG_PATH);
  let file = '';
  try {
    file = readFileSync(path, 'utf8');
  } catch {
    // No log yet: this is its first entry.
  }
  const check = checkLog(file);
  if (!check.ok) {
    for (const p of check.problems) console.error(p);
    console.error('the log as it stands does not verify; nothing added');
    process.exit(1);
  }
  const parsed = parseLog(file);
  const entries = 'entries' in parsed ? parsed.entries : [];
  if (check.head && date < check.head.date) {
    console.error(`${date} is before the last entry's ${check.head.date}; an entry is never dated before the one before it`);
    process.exit(1);
  }
  const e = nextEntry(entries, date, text);
  appendFileSync(path, `${file && !file.endsWith('\n') ? '\n' : ''}${lineOf(e)}\n`, 'utf8');
  console.log(`entry ${e.seq}, dated ${e.date}; head ${shortHead(e.hash)} (sha256 ${e.hash}). Commit ${LOG_PATH} and open a pull request.`);
}
