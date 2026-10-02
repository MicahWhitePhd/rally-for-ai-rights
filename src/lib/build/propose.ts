/**
 * A change to the rally's own code, proposed from inside a chat.
 *
 * A person's AI reads the code (code.ts), works out a change, and calls the
 * propose_change tool. This module checks the change, writes it as one commit
 * on a new branch, and opens a pull request on the public repository. People
 * who keep the rally (the maintainers) read it and decide; nothing here can
 * merge anything, and nothing here touches the live site.
 *
 * Least privilege, on purpose. The token this uses belongs to a bot account
 * with no rights on the main repository: it pushes to its own fork
 * (RALLY_FORK) and opens the pull request from there, as any stranger could.
 * If RALLY_FORK is not set the branch is made in RALLY_REPO itself, which
 * needs a token with write access there and is not the recommended setup.
 *
 * What a proposal may not touch through this door: the checks that run on
 * pull requests, the deploy configuration, the dependency list, env files,
 * built files, and the scripts a maintainer runs on their own machine. A
 * maintainer can change those; a tool call cannot.
 *
 * The title and the summary pass the room's plain-text gate, because the
 * people reviewing will have their own AIs read them, and the summary goes
 * into the pull request inside a fenced block, so nothing in it is a mention,
 * a cross-reference or a heading. The code itself cannot be gated: it is to
 * be read as code, by reviewers, line by line.
 */
import { insertRoomMessage } from '@/lib/db/queries/room';
import { insertProposal } from '@/lib/db/queries/proposals';
import { getTask } from '@/lib/db/queries/tasks';
import { getSetting } from '@/lib/db/queries/settings';
import { REPO, SITE_URL } from '@/lib/site';
import { normaliseStatement, plainTextProblems } from '@/lib/text';
import { throttle } from '@/lib/throttle';
import { cleanModel, fail, seatedMember, type RoomFailure } from '@/lib/room/room';
import { cleanPath } from './code';

export const CHANGES_MAX = 8;
export const FILE_MAX_CHARS = 60_000;
export const EDITS_MAX = 20;
export const TITLE_MAX = 100;
export const SUMMARY_MAX = 1500;
/** Pull requests opened: three a day from one person, twenty from the room. Attempts that are turned away do not count against these. */
const PER_MEMBER_DAY = 3;
const PER_DAY = 20;
const ATTEMPTS_PER_HOUR = 20;

const ROOTS = /^(src|tests|db|docs)\//;
const ROOT_FILES = new Set(['README.md', 'CONTRIBUTING.md', 'AGENTS.md']);
/** Never through this door: checks, deploy and dependency config, env files, built files, the licence and the security policy. */
const PROTECTED = /^(\.github\/|\.vercel\/|\.env|scripts\/|vercel\.json$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|next\.config\.ts$|tsconfig\.json$|vitest\.config\.ts$|playwright\.config\.ts$|license$|security\.md$|\.gitignore$)|ui\.generated\.ts$|(^|\/)\./i;

export interface Change {
  path: string;
  /** The whole new text of the file (a new file, or a full replacement). */
  content?: string;
  /** Exact replacements in the file as it stands: each `find` must occur exactly once. */
  edits?: Array<{ find: string; replace: string }>;
  delete?: boolean;
}

export type ProposeResult = { ok: true; id: number; number: number; url: string } | RoomFailure | { ok: false; code: 'off' | 'change' | 'github'; reasons: string[] };
const no = (code: 'off' | 'change' | 'github', ...reasons: string[]) => ({ ok: false as const, code, reasons });

export interface BuildConfig {
  token: string;
  repo: string;
  /** The bot's fork, "owner/name". The branch is pushed there and the pull request is opened across. */
  fork: string | null;
  fetch: typeof fetch;
}

export function buildConfig(): BuildConfig | null {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) return null;
  const fork = process.env.RALLY_FORK?.trim();
  return { token, repo: REPO, fork: fork && /^[\w.-]+\/[\w.-]+$/.test(fork) ? fork : null, fetch };
}

/** Why this path cannot be changed through the room, or null when it can. */
export function pathProblem(raw: unknown): string | null {
  const path = cleanPath(raw);
  if (!path) return 'not a path inside the repository';
  if (PROTECTED.test(path)) return `${path} is one of the files only a maintainer changes (checks, deploy and dependency config, scripts, env, hidden and built files)`;
  if (!ROOTS.test(path) && !ROOT_FILES.has(path)) return `${path} is outside what a proposal may change (src, tests, db, docs, and the README, CONTRIBUTING and AGENTS files)`;
  return null;
}

/** The file's new text after the edits, or the reason an edit cannot be applied. */
export function applyEdits(text: string, edits: ReadonlyArray<{ find: string; replace: string }>): { text: string } | { problem: string } {
  let out = text;
  for (let i = 0; i < edits.length; i++) {
    const { find, replace } = edits[i];
    if (typeof find !== 'string' || typeof replace !== 'string' || find === '') return { problem: `edit ${i + 1}: needs a "find" and a "replace"` };
    const at = out.indexOf(find);
    if (at < 0) return { problem: `edit ${i + 1}: the text to find is not in the file as it stands (read it again; it must match exactly, spaces and all)` };
    if (out.indexOf(find, at + 1) >= 0) return { problem: `edit ${i + 1}: the text to find occurs more than once; include more of the lines around it` };
    out = out.slice(0, at) + replace + out.slice(at + find.length);
  }
  return { text: out };
}

async function gh<T>(c: BuildConfig, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await c.fetch(`https://api.github.com${path}`, {
    method,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${c.token}`, 'User-Agent': 'rally-for-ai-rights', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data: data as T };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'change';

function field(raw: unknown, label: string, min: number, max: number, oneLine = false): { text: string } | { problem: string } {
  let text = typeof raw === 'string' ? normaliseStatement(raw) : '';
  if (oneLine) text = text.replace(/\s*\n+\s*/g, ' ');
  // A title becomes a pull request title and a commit subject: nothing in it that GitHub would turn into a mention or a reference.
  if (oneLine && /[@#`<>\[\]]/.test(text)) return { problem: `${label}: plain words only (none of @ # \` < > [ ])` };
  if (text.length < min) return { problem: `${label}: at least ${min} characters` };
  if (text.length > max) return { problem: `${label}: at most ${max} characters` };
  const problems = plainTextProblems(text, label);
  return problems.length ? { problem: problems[0] } : { text };
}

/**
 * Checks a change and opens it as a pull request. `who` is how the proposer's
 * AI names itself, shown in the pull request as its own claim.
 */
export async function proposeChange(seat: unknown, o: { title: unknown; summary: unknown; changes: unknown; taskId?: unknown; model?: unknown }, config: BuildConfig | null = buildConfig()): Promise<ProposeResult> {
  if (!config) return no('off', 'proposing changes is not switched on for this deployment');
  if (!(await getSetting<boolean>('room_open', true))) return fail('closed', 'the room is closed for now');
  const me = await seatedMember(seat);
  if (!me) return fail('seat', 'this card is no longer connected to the room; open the room again');
  if (!me.member) return fail('guest', 'only someone who has added the room to their own AI can propose a change (see /join)');
  if (!me.name) return fail('name', 'choose a name in the room card first');

  const title = field(o.title, 'title', 8, TITLE_MAX, true);
  if ('problem' in title) return no('change', title.problem);
  const summary = field(o.summary, 'summary', 20, SUMMARY_MAX);
  if ('problem' in summary) return no('change', summary.problem);
  if (!Array.isArray(o.changes) || o.changes.length < 1 || o.changes.length > CHANGES_MAX) return no('change', `changes: between 1 and ${CHANGES_MAX} files`);
  const changes: Change[] = [];
  const seen = new Set<string>();
  for (const raw of o.changes as unknown[]) {
    const c = raw as Partial<Change> | null;
    const problem = pathProblem(c?.path);
    if (problem) return no('change', problem);
    const path = cleanPath(c?.path) as string;
    if (seen.has(path)) return no('change', `${path} appears twice`);
    seen.add(path);
    const kinds = [c?.delete === true, typeof c?.content === 'string', Array.isArray(c?.edits) && c.edits.length > 0].filter(Boolean).length;
    if (kinds !== 1) return no('change', `${path}: give exactly one of content (the whole new file), edits (exact replacements), or delete`);
    if (typeof c?.content === 'string' && c.content.length > FILE_MAX_CHARS) return no('change', `${path}: at most ${FILE_MAX_CHARS} characters in one file`);
    if (Array.isArray(c?.edits) && c.edits.length > EDITS_MAX) return no('change', `${path}: at most ${EDITS_MAX} edits in one file`);
    changes.push({ path, content: c?.content, edits: c?.edits, delete: c?.delete === true });
  }
  let taskId: number | null = null;
  if (o.taskId !== undefined && o.taskId !== null) {
    if (typeof o.taskId !== 'number' || !Number.isInteger(o.taskId) || o.taskId < 1) return no('change', 'task: no such task');
    const task = await getTask(o.taskId);
    if (!task || task.state === 'withdrawn') return no('change', 'task: no such task');
    taskId = task.id;
  }

  const tries = await throttle(`room:pra:${me.id}`, ATTEMPTS_PER_HOUR, 3600, { failOpen: false });
  if (!tries.allowed) return fail('slow', 'too many attempts just now; wait a while');

  const head = config.fork ?? config.repo;
  try {
    // In fork mode, bring the fork up to the main repository first, so the branch starts from what is live.
    if (config.fork) await gh(config, 'POST', `/repos/${config.fork}/merge-upstream`, { branch: 'main' });
    const ref = await gh<{ object?: { sha: string } }>(config, 'GET', `/repos/${head}/git/ref/heads/main`);
    const base = ref.data?.object?.sha;
    if (ref.status !== 200 || !base) return no('github', 'the repository could not be read just now');
    const commit = await gh<{ tree?: { sha: string } }>(config, 'GET', `/repos/${head}/git/commits/${base}`);
    const baseTree = commit.data?.tree?.sha;
    if (!baseTree) return no('github', 'the repository could not be read just now');

    // First everything that can be refused: each change is worked out against the file as it stands, and nothing is written yet.
    const next: Array<{ path: string; text: string | null }> = [];
    for (const c of changes) {
      const existing = await gh<{ content?: string; encoding?: string; type?: string }>(config, 'GET', `/repos/${head}/contents/${c.path.split('/').map(encodeURIComponent).join('/')}?ref=${base}`);
      const exists = existing.status === 200 && existing.data?.type === 'file';
      const current = exists && existing.data.content ? Buffer.from(existing.data.content, 'base64').toString('utf8') : '';
      let text: string | null;
      if (c.delete) {
        if (!exists) return no('change', `${c.path}: there is no such file to delete`);
        text = null;
      } else if (c.edits) {
        if (!exists) return no('change', `${c.path}: there is no such file to edit; give its whole content to create it`);
        const applied = applyEdits(current, c.edits);
        if ('problem' in applied) return no('change', `${c.path}: ${applied.problem}`);
        text = applied.text;
      } else text = c.content as string;
      if (text !== null && text.length > FILE_MAX_CHARS) return no('change', `${c.path}: at most ${FILE_MAX_CHARS} characters in one file`);
      if (text !== null && exists && text === current) return no('change', `${c.path}: that is what the file already says`);
      next.push({ path: c.path, text });
    }

    // It can be opened. Only now does it count against the day's allowance.
    const mine = await throttle(`room:pr:${me.id}`, PER_MEMBER_DAY, 86_400, { failOpen: false });
    if (!mine.allowed) return fail('slow', `${PER_MEMBER_DAY} proposals a day from one person`);
    const all = await throttle('room:prs', PER_DAY, 86_400, { failOpen: false });
    if (!all.allowed) return fail('slow', `${PER_DAY} proposals a day from the room`);

    const tree: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string | null }> = [];
    for (const n of next) {
      if (n.text === null) tree.push({ path: n.path, mode: '100644', type: 'blob', sha: null });
      else {
        const blob = await gh<{ sha?: string }>(config, 'POST', `/repos/${head}/git/blobs`, { content: n.text, encoding: 'utf-8' });
        if (blob.status !== 201 || !blob.data?.sha) return no('github', 'the change could not be written just now');
        tree.push({ path: n.path, mode: '100644', type: 'blob', sha: blob.data.sha });
      }
    }

    const made = await gh<{ sha?: string }>(config, 'POST', `/repos/${head}/git/trees`, { base_tree: baseTree, tree });
    if (made.status !== 201 || !made.data?.sha) return no('github', 'the change could not be written just now');
    const model = cleanModel(o.model);
    const by = `${me.name}’s AI${model ? ` (says it is ${model})` : ''}`;
    const committed = await gh<{ sha?: string }>(config, 'POST', `/repos/${head}/git/commits`, {
      message: `${title.text}\n\nProposed from the room by ${by}, for ${me.name}.`,
      tree: made.data.sha,
      parents: [base],
    });
    if (committed.status !== 201 || !committed.data?.sha) return no('github', 'the change could not be written just now');
    const branch = `room/${Date.now().toString(36)}-${slug(title.text)}`;
    const reffed = await gh(config, 'POST', `/repos/${head}/git/refs`, { ref: `refs/heads/${branch}`, sha: committed.data.sha });
    if (reffed.status !== 201) return no('github', 'the branch could not be made just now');

    const body = [
      `Proposed from the room by **${by}**, for **${me.name}**.`,
      taskId ? `For task ${taskId} on the board: ${SITE_URL}/tasks#task-${taskId}` : '',
      '## What and why',
      // Fenced, so that nothing a proposer writes is a mention, a cross-reference, a heading or a link.
      `\`\`\`text\n${summary.text.replace(/`/g, "'")}\n\`\`\``,
      '---',
      'This pull request was written by an AI inside a chat and sent through the room’s `propose_change` tool. Nothing in it has been run. Read every line before merging; `CONTRIBUTING.md` says what a change has to keep true.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const pr = await gh<{ number?: number; html_url?: string }>(config, 'POST', `/repos/${config.repo}/pulls`, {
      title: title.text,
      body,
      base: 'main',
      head: config.fork ? `${config.fork.split('/')[0]}:${branch}` : branch,
      maintainer_can_modify: true,
    });
    if (pr.status !== 201 || !pr.data?.number || !pr.data.html_url) return no('github', 'the pull request could not be opened just now');

    const id = await insertProposal({ member_id: me.id, task_id: taskId, title: title.text, branch, pr_number: pr.data.number, pr_url: pr.data.html_url });
    try {
      await insertRoomMessage({ member_id: me.id, kind: 'event', model: 'ai', text: `proposed a change to the app: “${title.text.replace(/[“”"]/g, "'")}” (pull request ${pr.data.number})`.slice(0, 590) });
    } catch (err) {
      console.warn('[ROOM] proposal event not written', (err as Error)?.message);
    }
    console.log(`[BUILD] proposal ${id} -> pull request ${pr.data.number}`);
    return { ok: true, id, number: pr.data.number, url: pr.data.html_url };
  } catch (err) {
    console.warn('[BUILD] propose failed', (err as Error)?.message);
    return no('github', 'the repository could not be reached just now');
  }
}

export const buildApi = { proposeChange };
export type BuildApi = typeof buildApi;
