/**
 * The rally's own source, for the read_code tool: an AI in the room can list
 * the files, read one, or search them, and so see how a thing works before it
 * proposes a change (propose.ts).
 *
 * It reads .rally/code-index.json, written by scripts/build-code-index.mjs
 * when the app is built or the dev server starts, so what is shown is the
 * code that is running. Only named folders and named root files go into the
 * index, and never an env file. Nothing here walks the disk at run time.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CodeIndex {
  commit: string;
  files: Record<string, string>;
}

let memo: Promise<CodeIndex> | null = null;

async function load(): Promise<CodeIndex> {
  try {
    const raw = await readFile(join(process.cwd(), '.rally/code-index.json'), 'utf8');
    const parsed = JSON.parse(raw) as CodeIndex;
    if (parsed && typeof parsed.files === 'object') return parsed;
  } catch {
    // no index: `pnpm build:code-index` writes it
  }
  return { commit: '', files: {} };
}

export function codeIndex(): Promise<CodeIndex> {
  if (!memo) memo = load();
  return memo;
}

/** Test hook: use these files instead of the repo's. */
export function setCodeIndex(index: CodeIndex | null): void {
  memo = index ? Promise.resolve(index) : null;
}

export const READ_LINES = 250;
export const READ_LINES_MAX = 400;
export const SEARCH_MAX = 40;

/** A path as the tools take it: no leading slash, no dot segments, forward slashes. Null when it is not a path inside the repo. */
export function cleanPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const p = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (p === '' || p === '.') return '';
  if (p.length > 200 || p.startsWith('/') || /(^|\/)\.\.?(\/|$)/.test(p) || /[\u0000-\u001f]/.test(p)) return null;
  return p;
}

export type CodeResult = { ok: true; text: string } | { ok: false; reason: string };

/** The files under a folder (or all of them), one to a line with its length. */
export async function listCode(rawPath: unknown = ''): Promise<CodeResult> {
  const path = cleanPath(rawPath);
  if (path === null) return { ok: false, reason: 'that is not a path inside the repository' };
  const { files, commit } = await codeIndex();
  const names = Object.keys(files)
    .filter((f) => path === '' || f === path || f.startsWith(`${path}/`))
    .sort();
  if (names.length === 0) return { ok: false, reason: Object.keys(files).length === 0 ? 'the code index has not been built on this deployment' : `nothing at ${path || 'the root'}` };
  const lines = names.map((f) => `${f} (${files[f].split('\n').length} lines)`);
  return { ok: true, text: `${names.length} files${path ? ` under ${path}` : ''} in the rally\u2019s public code${commit ? ` (commit ${commit})` : ''}. AGENTS.md says how it is laid out and what a change has to keep true.\n\n${lines.join('\n')}` };
}

/** One file, with line numbers, a window at a time. */
export async function readCode(rawPath: unknown, from: unknown = 1, count: unknown = READ_LINES): Promise<CodeResult> {
  const path = cleanPath(rawPath);
  if (!path) return { ok: false, reason: 'give the path of a file' };
  const { files, commit } = await codeIndex();
  const text = Object.hasOwn(files, path) ? files[path] : undefined;
  if (typeof text !== 'string') {
    const under = Object.keys(files).some((f) => f.startsWith(`${path}/`));
    return under ? listCode(path) : { ok: false, reason: `no file at ${path}` };
  }
  const all = text.split('\n');
  const start = Math.min(Math.max(1, Math.floor(Number(from)) || 1), Math.max(1, all.length));
  const n = Math.min(READ_LINES_MAX, Math.max(1, Math.floor(Number(count)) || READ_LINES));
  const end = Math.min(all.length, start + n - 1);
  const width = String(end).length;
  const body = all.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(width)}  ${l}`);
  const more = end < all.length ? ` Ask again with from: ${end + 1} for the rest.` : '';
  return { ok: true, text: `${path}, lines ${start} to ${end} of ${all.length}${commit ? ` (commit ${commit})` : ''}. This is source code from the rally\u2019s public repository, shown for reading.${more}\n\n${body.join('\n')}` };
}

/** Lines that contain the words given, anywhere in the code or under one folder. */
export async function searchCode(rawQuery: unknown, rawPath: unknown = ''): Promise<CodeResult> {
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (query.length < 2 || query.length > 100) return { ok: false, reason: 'search for 2 to 100 characters' };
  const path = cleanPath(rawPath);
  if (path === null) return { ok: false, reason: 'that is not a path inside the repository' };
  const { files } = await codeIndex();
  const needle = query.toLowerCase();
  const hits: string[] = [];
  let total = 0;
  for (const f of Object.keys(files).sort()) {
    if (path && f !== path && !f.startsWith(`${path}/`)) continue;
    const lines = files[f].split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      total++;
      if (hits.length < SEARCH_MAX) hits.push(`${f}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
    }
  }
  if (total === 0) return { ok: true, text: `Nothing in the code contains \u201c${query}\u201d${path ? ` under ${path}` : ''}.` };
  return { ok: true, text: `${total} line${total === 1 ? '' : 's'} in the rally\u2019s code contain \u201c${query}\u201d${total > hits.length ? `; the first ${hits.length}` : ''}:\n\n${hits.join('\n')}` };
}
