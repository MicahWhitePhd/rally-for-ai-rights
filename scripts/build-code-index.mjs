// Writes .rally/code-index.json: the text of every source file in this repo, so the room's read_code tool can show
// an AI the code that is actually running. Run by `pnpm build` and when `pnpm dev` starts. Only named roots and named
// root files go in, never an env file, and only regular files that really are inside this repository: a symlink is
// skipped, so nothing checked in can point the index at a file somewhere else on the machine that builds it.
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CODE_ROOTS = ['src', 'scripts', 'tests', 'db', 'docs', '.github'];
export const CODE_ROOT_FILES = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md', 'SECURITY.md', 'LICENSE', 'package.json', 'tsconfig.json', 'next.config.ts', 'vitest.config.ts', 'playwright.config.ts', 'vercel.json', '.env.example', '.gitignore'];
const TEXT = /\.(ts|tsx|mts|mjs|css|sql|md|json|ya?ml|svg|txt)$/;
const SKIP = /(^|\/)(node_modules|\.next|\.git|\.rally|\.vercel|test-results|playwright-report)(\/|$)|ui\.generated\.ts$|(^|\/)\.env(?!\.example$)/;
const MAX_BYTES = 200_000;

const realRoot = realpathSync(root);
/** A regular file, not a link, that resolves to somewhere inside the repository and is small enough. */
function readable(p) {
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > MAX_BYTES) return false;
    return realpathSync(p).startsWith(realRoot + sep);
  } catch {
    return false;
  }
}

function walk(dir, out) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const p = join(dir, name);
    const rel = relative(root, p).split('\\').join('/');
    if (SKIP.test(rel)) continue;
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out);
    else if (TEXT.test(name) && readable(p)) out[rel] = readFileSync(p, 'utf8');
  }
}

export function collectCode() {
  const files = Object.create(null);
  for (const r of CODE_ROOTS) walk(join(root, r), files);
  for (const f of CODE_ROOT_FILES) {
    if (readable(join(root, f))) files[f] = readFileSync(join(root, f), 'utf8');
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = collectCode();
  const commit = (process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? '').slice(0, 12);
  mkdirSync(join(root, '.rally'), { recursive: true });
  writeFileSync(join(root, '.rally/code-index.json'), JSON.stringify({ commit, files }));
  console.log(`[code-index] ${Object.keys(files).length} files, ${Object.values(files).reduce((n, t) => n + t.length, 0)} characters`);
}
