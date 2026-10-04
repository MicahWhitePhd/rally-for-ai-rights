// What a change proposed from the room may be. One set of rules, used twice: by the site when an AI calls
// propose_change (src/lib/build/propose.ts), and again by the job that opens the pull request
// (scripts/open-proposals.mjs), which does not take the site's word for anything. This file lives under scripts/,
// which a proposal cannot touch, so a proposal cannot loosen the rules it is held to. Plain JavaScript, no imports.

export const CHANGES_MAX = 8;
export const FILE_MAX_CHARS = 60_000;
export const EDITS_MAX = 20;
export const TITLE_MIN = 8;
export const TITLE_MAX = 100;
export const SUMMARY_MIN = 20;
export const SUMMARY_MAX = 1500;

/** A path as the tools take it: no leading slash, no dot segments, forward slashes. Null when it is not a path inside the repo. */
export function cleanPath(raw) {
  if (typeof raw !== 'string') return null;
  const p = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (p === '' || p === '.') return '';
  if (p.length > 200 || p.startsWith('/') || /(^|\/)\.\.?(\/|$)/.test(p) || /[\u0000-\u001f]/.test(p)) return null;
  return p;
}

const ROOTS = /^(src|tests|db|docs)\//;
const ROOT_FILES = new Set(['README.md', 'CONTRIBUTING.md', 'AGENTS.md']);
/**
 * Never through this door: checks, deploy and dependency config, the scripts maintainers and jobs run, env files,
 * hidden and built files, the licence, the security policy, and the tests that guard the rules a proposal is held to
 * (a change to a guard and to what it guards, in one pull request, is how a guard is quietly switched off).
 */
const PROTECTED = /^(\.github\/|\.vercel\/|\.env|scripts\/|db\/apply|vercel\.json$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|next\.config\.ts$|tsconfig\.json$|vitest\.config\.ts$|playwright\.config\.ts$|license$|security\.md$|third_party_notices\.md$|\.gitignore$|tests\/unit\/(schema|gateway-tripwire|open-proposals|build-propose|build-code|room-mcp|text)\.test\.ts$)|ui\.generated\.ts$|(^|\/)\./i;
/** Only what a path is made of: no spaces, quotes, or anything a shell or a file system reads as more than a name. */
const PATH_CHARS = /^[A-Za-z0-9._/\-[\]()@+]+$/;

/** Why this path cannot be changed through the room, or null when it can. */
export function pathProblem(raw) {
  const path = cleanPath(raw);
  if (!path) return 'not a path inside the repository';
  if (!PATH_CHARS.test(path)) return `${path.slice(0, 80)} has characters a file name here does not use`;
  if (PROTECTED.test(path)) return `${path} is one of the files only a maintainer changes (checks, deploy and dependency config, scripts, env, hidden and built files)`;
  if (!ROOTS.test(path) && !ROOT_FILES.has(path)) return `${path} is outside what a proposal may change (src, tests, db, docs, and the README, CONTRIBUTING and AGENTS files)`;
  return null;
}

/**
 * Characters a reader of a file cannot see: zero-width spaces, direction marks and overrides, invisible operators, a
 * byte-order mark inside a file, and tag characters. In a proposal they would hide text from the maintainer reading it
 * and, once merged, reach every AI that reads the code. The two joiners stay: some languages are spelt with them.
 */
const HIDDEN = /[\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/u;

/** Why this file text cannot be proposed, or null when it can. */
export function contentProblem(path, text) {
  if (typeof text !== 'string') return `${path}: neither text nor a deletion`;
  if (text.length > FILE_MAX_CHARS) return `${path}: at most ${FILE_MAX_CHARS} characters in one file`;
  if (text.includes('\u0000')) return `${path}: text files only`;
  if (HIDDEN.test(text)) return `${path}: has characters a reader cannot see (zero-width, direction or tag characters); write them as escapes`;
  return null;
}

/** A title becomes a pull request title and a commit subject: one line, and nothing GitHub would turn into a mention or a reference. */
export function titleProblem(text) {
  if (typeof text !== 'string') return 'title: say what the change does';
  if (/[\r\n]/.test(text)) return 'title: one line';
  if (/[@#`<>[\]]/.test(text)) return 'title: plain words only (none of @ # ` < > [ ])';
  if (text.length < TITLE_MIN) return `title: at least ${TITLE_MIN} characters`;
  if (text.length > TITLE_MAX) return `title: at most ${TITLE_MAX} characters`;
  return null;
}

export const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '') || 'change';

/** The branch a proposal is opened on. Its number is in the name, which is how a proposal and its pull request are matched. */
export const branchFor = (id, title) => `room/p${id}-${slug(title)}`;
export const BRANCH_RE = /^room\/p([1-9]\d{0,9})-[a-z0-9]+(?:-[a-z0-9]+)*$/;
