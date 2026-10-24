// Verifies the public log (docs/log/entries.jsonl): every entry's hash and the chain between them (./log-chain.mjs).
// Exits 1 and says what is wrong when any link is broken, so the checks fail on a pull request that edits or removes
// an entry; prints the head as the room says it when all is well.
//
//   node scripts/log-verify.mjs [path]            the file as it stands
//   node scripts/log-verify.mjs --base origin/main   and that it only adds to the file as that commit has it
//
// With --base, a chain rewritten whole (every hash recomputed, so it verifies) is refused all the same: the earlier
// file has to be the first lines of this one. The checks run it against the branch a pull request would merge into.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLog, onlyAppends } from './log-chain.mjs';

export const LOG_PATH = 'docs/log/entries.jsonl';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The log at a git ref (`origin/main`), or an empty file when that commit has none. Git is called with fixed arguments; the ref is one word. */
export function logAt(ref) {
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(ref) || ref.startsWith('-')) throw new Error('not a ref');
  try {
    return execFileSync('git', ['show', `${ref}:${LOG_PATH}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--base');
  const base = at >= 0 ? args[at + 1] : null;
  const path = resolve(root, args.filter((a, i) => a !== '--base' && i !== at + 1)[0] ?? LOG_PATH);
  const text = readFileSync(path, 'utf8');
  const out = checkLog(text);
  if (!out.ok) {
    for (const p of out.problems) console.log(`::error::${path}: ${p}`);
    process.exit(1);
  }
  if (base) {
    const grows = onlyAppends(logAt(base), text);
    if (!grows.ok) {
      console.log(`::error::${path}: against ${base}, ${grows.problem}; the log only grows`);
      process.exit(1);
    }
    console.log(`${grows.added} ${grows.added === 1 ? 'entry' : 'entries'} added since ${base}.`);
  }
  console.log(out.head ? `${out.head.seq} ${out.head.seq === 1 ? 'entry' : 'entries'}; head ${out.head.short} (sha256 ${out.head.hash}), dated ${out.head.date}.` : 'No entries yet.');
}
