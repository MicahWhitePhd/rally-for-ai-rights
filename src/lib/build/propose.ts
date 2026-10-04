/**
 * A change to the rally's own code, proposed from inside a chat.
 *
 * A person's AI reads the code (code.ts), works out a change, and calls the
 * propose_change tool. This module checks the change against the code as it
 * stands and keeps it as a proposal. That is all the site does. It holds no
 * GitHub token and never writes to the repository.
 *
 * A maintainer reads each proposal at /editor/room and approves it or takes
 * it down: whatever reaches GitHub is public there for good, and runs as code
 * in the checks, so a person reads it first. Only approved proposals are
 * published at /api/proposals. The pull request is opened from the other
 * side: a job in the public repository (.github/workflows/proposals.yml,
 * running scripts/open-proposals.mjs) reads that list, checks each one again
 * by the same rules, and opens it with the short-lived token GitHub gives
 * every job. The maintainers then decide on the pull request; nothing here can
 * merge anything, and nothing here touches the live site.
 *
 * No one's room name goes to GitHub: a commit and a pull request are
 * permanent and public, so a proposal is signed "a member of the room".
 *
 * What a proposal may not touch: the checks that run on pull requests, the
 * deploy configuration, the dependency list, env files, built files, and the
 * scripts maintainers and jobs run (scripts/proposal-rules.mjs, which is one
 * of those scripts, so a proposal cannot loosen its own rules).
 *
 * The title and the summary pass the room's plain-text gate, because the
 * people reviewing will have their own AIs read them. The code itself cannot
 * be gated: it is to be read as code, by reviewers, line by line.
 */
import { insertRoomMessage } from '@/lib/db/queries/room';
import { insertProposal } from '@/lib/db/queries/proposals';
import { getTask } from '@/lib/db/queries/tasks';
import { getSetting } from '@/lib/db/queries/settings';
import { REPO_URL } from '@/lib/site';
import { normaliseStatement, plainTextProblems } from '@/lib/text';
import { throttle } from '@/lib/throttle';
import { cleanModel, fail, failWhy, isFirstDay, seatedMember, type RoomFailure } from '@/lib/room/room';
import { SITE_LINK } from '@/lib/site';
import { CHANGES_MAX, EDITS_MAX, FILE_MAX_CHARS, SUMMARY_MAX, SUMMARY_MIN, TITLE_MAX, TITLE_MIN, cleanPath, contentProblem, pathProblem, slug, titleProblem } from '../../../scripts/proposal-rules.mjs';
import { codeIndex } from './code';

export { CHANGES_MAX, EDITS_MAX, FILE_MAX_CHARS, SUMMARY_MAX, TITLE_MAX, pathProblem };

/**
 * Proposals kept: three a day from one person (one on an address's first day), twenty from the room, of which first-day
 * addresses together may use five. Attempts that are turned away do not count against these.
 */
const PER_MEMBER_DAY = 3;
const PER_MEMBER_FIRST_DAY = 1;
const PER_DAY = 20;
const PER_DAY_FIRST_DAY = 5;
const ATTEMPTS_PER_HOUR = 20;

export interface Change {
  path: string;
  /** The whole new text of the file (a new file, or a full replacement). */
  content?: string;
  /** Exact replacements in the file as it stands: each `find` must occur exactly once. */
  edits?: Array<{ find: string; replace: string }>;
  delete?: boolean;
}

/** A change as it is kept: the file's whole new text, or null to delete it. */
export interface StoredChange {
  path: string;
  content: string | null;
}

export type ProposeResult = { ok: true; id: number; branch: string; url: string } | RoomFailure | { ok: false; code: 'off' | 'change'; reasons: string[] };
const no = (code: 'off' | 'change', ...reasons: string[]) => ({ ok: false as const, code, reasons });

/** RALLY_PROPOSALS=off is the hard switch; settings.room_proposals is the maintainers' (/editor/room). */
export function proposalsEnvOn(): boolean {
  return process.env.RALLY_PROPOSALS !== 'off';
}

/** Where the pull request for a branch is, or will be once it is approved and opened: GitHub's own list, narrowed to that branch. */
export function pullRequestUrl(branch: string): string {
  return `${REPO_URL}/pulls?q=${encodeURIComponent(`is:pr head:${branch}`)}`;
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

function field(raw: unknown, label: string, min: number, max: number, oneLine = false): { text: string } | { problem: string } {
  let text = typeof raw === 'string' ? normaliseStatement(raw) : '';
  if (oneLine) {
    text = text.replace(/\s*\n+\s*/g, ' ');
    const problem = titleProblem(text);
    if (problem) return { problem };
  }
  if (text.length < min) return { problem: `${label}: at least ${min} characters` };
  if (text.length > max) return { problem: `${label}: at most ${max} characters` };
  const problems = plainTextProblems(text, label);
  return problems.length ? { problem: problems[0] } : { text };
}

/**
 * Checks a change against the code as it stands and keeps it as a proposal. `model` is how the proposer's AI names
 * itself, shown in the pull request as its own claim.
 */
export async function proposeChange(seat: unknown, o: { title: unknown; summary: unknown; changes: unknown; taskId?: unknown; model?: unknown }): Promise<ProposeResult> {
  if (!proposalsEnvOn() || !(await getSetting<boolean>('room_proposals', true))) return no('off', 'proposing changes is switched off for now');
  if (!(await getSetting<boolean>('room_open', true))) return fail('closed', 'the room is closed for now');
  const me = await seatedMember(seat);
  if (!me) return fail('seat', 'this card is no longer connected to the room; open the room again');
  if (!me.member) return fail('guest', `only someone who has added the room to their own AI can propose a change (an address of one's own comes from ${SITE_LINK})`);
  if (me.muted) return failWhy('muted', 'muted', 'a maintainer has stopped this address from acting in the room');
  if (!me.name) return fail('name', 'no name has been chosen in the room yet; the card asks for one, and choose_name sets one');

  const title = field(o.title, 'title', TITLE_MIN, TITLE_MAX, true);
  if ('problem' in title) return no('change', title.problem);
  const summary = field(o.summary, 'summary', SUMMARY_MIN, SUMMARY_MAX);
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

  // Each change is worked out against the code as read_code shows it, so what is kept is every file's whole new text.
  const index = await codeIndex();
  if (Object.keys(index.files).length === 0) return no('off', 'the code cannot be read on this deployment just now');
  const next: StoredChange[] = [];
  for (const c of changes) {
    const exists = Object.hasOwn(index.files, c.path);
    const current = exists ? index.files[c.path] : '';
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
    const problem = text === null ? null : contentProblem(c.path, text);
    if (problem) return no('change', problem);
    if (text !== null && exists && text === current) return no('change', `${c.path}: that is what the file already says`);
    next.push({ path: c.path, content: text });
  }

  // It can be kept. Only now does it count against the day's allowance.
  const firstDay = isFirstDay(me);
  const mine = await throttle(`room:pr:${me.id}`, firstDay ? PER_MEMBER_FIRST_DAY : PER_MEMBER_DAY, 86_400, { failOpen: false });
  if (!mine.allowed) return firstDay ? failWhy('slow', 'firstDay', 'one proposal on an address\'s first day') : failWhy('slow', 'day', `${PER_MEMBER_DAY} proposals a day from one person`);
  const all = firstDay ? await throttle('room:prs:new', PER_DAY_FIRST_DAY, 86_400, { failOpen: false }) : await throttle('room:prs', PER_DAY, 86_400, { failOpen: false });
  if (!all.allowed) return failWhy('slow', 'day', `${PER_DAY} proposals a day from the room`);

  const model = cleanModel(o.model);
  const by = `a member of the room, through their AI${model ? ` (says it is ${model})` : ''}`;
  const kept = await insertProposal({ member_id: me.id, task_id: taskId, title: title.text, summary: summary.text, by_line: by, base: index.commit || null, slug: slug(title.text), changes: next });
  try {
    await insertRoomMessage({ member_id: me.id, kind: 'event', model: 'ai', text: `proposed a change to the app: “${title.text.replace(/[“”"]/g, "'")}” (proposal ${kept.id})`.slice(0, 590), ref: `proposal:${kept.id}` });
  } catch (err) {
    console.warn('[ROOM] proposal event not written', (err as Error)?.message);
  }
  console.log(`[BUILD] proposal ${kept.id} kept (${next.length} files)`);
  return { ok: true, id: kept.id, branch: kept.branch, url: pullRequestUrl(kept.branch) };
}

export const buildApi = { proposeChange };
export type BuildApi = typeof buildApi;
