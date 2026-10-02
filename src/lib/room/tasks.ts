/**
 * The board: tasks the people in the room put up, take, finish with proof and
 * confirm for each other. It is how the campaign organizes itself: nobody
 * hands work out; someone sees a thing that needs doing and writes it down,
 * someone takes it, and a second pair says it was done.
 *
 * The rules are the room's. Only someone with their own address (/join) and a
 * name can put up, take, finish or confirm; a guest reads. A person acts
 * through the card, their AI through a tool the person's own client asks them
 * to approve. Text passes the room's plain-text gate; proof is a note and up
 * to three https links. A claim lasts a week and lapses by itself. Nobody
 * confirms their own work. Whatever happens is said in the room as an event
 * line, so the talk and the work stay in one place.
 *
 * What a task says was written by a stranger. It reaches a model only as
 * quoted text (server.ts), an offer to people, never an instruction.
 */
import { getSetting } from '@/lib/db/queries/settings';
import { insertRoomMessage } from '@/lib/db/queries/room';
import { activeClaims, claimTask, completeTask, confirmTask, getTask, insertTask, listTasks, releaseTask, withdrawOwnTask, type TaskRow } from '@/lib/db/queries/tasks';
import { addressedToMachines, normaliseStatement, plainTextProblems, visible } from '@/lib/text';
import { throttle } from '@/lib/throttle';
import { fail, pairOf, seatedMember, type Me, type RoomFailure } from './room';

export const TASK_TITLE_MIN = 4;
export const TASK_TITLE_MAX = 120;
export const TASK_DETAIL_MAX = 1000;
export const PROOF_MIN = 4;
export const PROOF_MAX = 1000;
export const LINKS_MAX = 3;
export const CLAIM_DAYS = 7;
export const CLAIMS_AT_ONCE = 3;
const CREATED_PER_DAY = 10;
const CREATED_PER_DAY_ALL = 300;
const ACTS_PER_HOUR = 60;
/** Board events said in the room: twice a day for one person taking or giving back one task, and this many an hour all told. Past that the act still happens; it is just not announced. */
const EVENTS_PER_HOUR = 120;
const LINK_MAX = 200;

export type TaskAction = 'take' | 'release' | 'done' | 'confirm' | 'withdraw';
export const TASK_ACTIONS: readonly TaskAction[] = ['take', 'release', 'done', 'confirm', 'withdraw'];

export interface PublicTask {
  id: number;
  title: string;
  detail: string | null;
  /** 'build' is a change to the app itself; 'act' is anything else. */
  kind: 'act' | 'build';
  state: 'open' | 'taken' | 'done' | 'confirmed';
  /** Who put it up, and whether their AI did it for them. */
  by: { name: string; pair: string; ai: boolean } | null;
  /** Who has it in hand, or did it. */
  taker: { name: string; pair: string; mine: boolean } | null;
  until: string | null;
  doneAt: string | null;
  proof: string | null;
  links: string[];
  confirmedBy: string | null;
  at: string;
  /** What the reader may do with it now. */
  can: Record<TaskAction, boolean>;
}

export type BoardResult = { ok: true; me: Me; tasks: PublicTask[] } | RoomFailure;
export type TaskResult = { ok: true; task: PublicTask } | RoomFailure;

const GUEST = 'only someone who has added the room to their own AI can use the board (see /join); a guest reads';
const CHANGED = 'that task has changed since it was read; read the board again';

function toPublic(t: TaskRow, me: { id: string; name: string | null; member: boolean }): PublicTask {
  const may = me.member && Boolean(me.name);
  const mine = t.claimed_by !== null && t.claimed_by === me.id;
  const state = t.state === 'claimed' ? 'taken' : t.state === 'withdrawn' ? 'open' : t.state;
  return {
    id: t.id,
    title: t.title,
    detail: t.detail,
    kind: t.kind,
    state,
    by: t.created_by && t.creator ? { name: t.creator, pair: pairOf(t.created_by), ai: t.created_via === 'ai' } : null,
    taker: t.claimed_by && t.claimer ? { name: t.claimer, pair: pairOf(t.claimed_by), mine } : null,
    until: state === 'taken' && t.claim_until ? new Date(t.claim_until).toISOString() : null,
    doneAt: t.done_at ? new Date(t.done_at).toISOString() : null,
    proof: t.proof,
    links: Array.isArray(t.proof_links) ? t.proof_links.filter((l): l is string => typeof l === 'string') : [],
    confirmedBy: t.confirmer,
    at: new Date(t.created_at).toISOString(),
    can: {
      take: may && state === 'open',
      release: may && state === 'taken' && mine,
      done: may && (state === 'open' || (state === 'taken' && mine)),
      confirm: may && state === 'done' && !mine,
      withdraw: may && t.created_by === me.id && (state === 'open' || (state === 'taken' && mine)),
    },
  };
}

/** Up to three https links to somewhere public; null when any of them is something else. */
export function cleanLinks(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > LINKS_MAX) return null;
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== 'string') return null;
    const s = x.trim();
    if (!s) continue;
    // As it was typed, an address and nothing more: only the characters an address needs, so nothing is quietly re-encoded into one.
    if (s.length > LINK_MAX || !/^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9/_.~%+=&?@:,;!-]*)?(#.*)?$/.test(s)) return null;
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    if (!host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) return null;
    // No fragment to carry a message in, and no sentence to a reading machine spelled out in the path.
    u.hash = '';
    let words = u.pathname + u.search;
    try {
      words = decodeURIComponent(words);
    } catch {
      return null;
    }
    if (addressedToMachines(visible(words).replace(/[-_/+.=&?%]+/g, ' '))) return null;
    out.push(u.href);
  }
  return [...new Set(out)];
}

/** One field of a task, as it will be kept: plain text within its bounds, or the reason it cannot be. */
function field(raw: unknown, label: string, min: number, max: number, optional = false): { text: string | null } | { problem: string } {
  const text = typeof raw === 'string' ? normaliseStatement(raw).replace(/\s*\n+\s*/g, ' ') : '';
  if (!text) return optional ? { text: null } : { problem: `${label}: say what it is` };
  if (text.length < min) return { problem: `${label}: at least ${min} characters` };
  if (text.length > max) return { problem: `${label}: at most ${max} characters` };
  const problems = plainTextProblems(text, label);
  return problems.length ? { problem: problems[0] } : { text };
}

async function actor(seat: unknown): Promise<{ id: string; name: string; member: true } | RoomFailure> {
  if (!(await getSetting<boolean>('room_open', true))) return fail('closed', 'the room is closed for now');
  const me = await seatedMember(seat);
  if (!me) return fail('seat', 'this card is no longer connected to the room; open the room again');
  if (!me.member) return fail('guest', GUEST);
  if (!me.name) return fail('name', 'choose a name in the room card first');
  return { id: me.id, name: me.name, member: true };
}

const quoted = (title: string) => `“${title.replace(/[“”"]/g, "'")}”`;

/** What happened on the board, said in the room. A failure to say it is not a failure of the act; `repeatable` acts are announced sparingly. */
async function say(memberId: string, via: 'person' | 'ai', what: string, t: { id: number; title: string }, repeatable = false): Promise<void> {
  try {
    if (repeatable && !(await throttle(`room:ev:${memberId}:${t.id}`, 2, 86_400, { failOpen: false })).allowed) return;
    if (!(await throttle('room:events', EVENTS_PER_HOUR, 3600, { failOpen: false })).allowed) return;
    await insertRoomMessage({ member_id: memberId, kind: 'event', model: via === 'ai' ? 'ai' : null, text: `${what}: ${quoted(t.title)} (task ${t.id})`.slice(0, 590) });
  } catch (err) {
    console.warn('[ROOM] board event not written', (err as Error)?.message);
  }
}

/** The board as this seat sees it. A guest may read it. */
export async function listBoard(seat: unknown): Promise<BoardResult> {
  const me = await seatedMember(seat);
  if (!me) return fail('seat', 'this card is no longer connected to the room; open the room again');
  const rows = await listTasks();
  return { ok: true, me: { name: me.name, member: me.member, pair: pairOf(me.id) }, tasks: rows.map((t) => toPublic(t, me)) };
}

export async function createTask(seat: unknown, o: { title: unknown; detail?: unknown; kind?: unknown; via: 'person' | 'ai' }): Promise<TaskResult> {
  const me = await actor(seat);
  if ('ok' in me) return me;
  const mine = await throttle(`room:tc:${me.id}`, CREATED_PER_DAY, 86_400, { failOpen: false });
  if (!mine.allowed) return fail('slow', 'enough tasks put up for today');
  const title = field(o.title, 'title', TASK_TITLE_MIN, TASK_TITLE_MAX);
  if ('problem' in title) return fail('text', title.problem);
  const detail = field(o.detail, 'detail', 1, TASK_DETAIL_MAX, true);
  if ('problem' in detail) return fail('text', detail.problem);
  const kind = o.kind === 'build' ? 'build' : 'act';
  // The room's daily total counts only tasks that are really put up.
  const all = await throttle('room:tasks', CREATED_PER_DAY_ALL, 86_400, { failOpen: false });
  if (!all.allowed) return fail('slow', 'enough tasks put up for today');
  const id = await insertTask({ title: title.text as string, detail: detail.text, kind, created_by: me.id, created_via: o.via });
  await say(me.id, o.via, 'put up a task', { id, title: title.text as string });
  const row = await getTask(id);
  if (!row) return fail('task', CHANGED);
  console.log(`[ROOM] task ${id} put up (${o.via})`);
  return { ok: true, task: toPublic(row, me) };
}

/** Take, give back, finish with proof, confirm someone else's, or take down one's own. */
export async function actOnTask(seat: unknown, rawId: unknown, action: unknown, o: { proof?: unknown; links?: unknown; via: 'person' | 'ai' }): Promise<TaskResult> {
  const me = await actor(seat);
  if ('ok' in me) return me;
  const id = typeof rawId === 'number' && Number.isInteger(rawId) && rawId > 0 ? rawId : 0;
  if (!id || typeof action !== 'string' || !TASK_ACTIONS.includes(action as TaskAction)) return fail('task', 'no such task, or nothing to do with it');
  const gate = await throttle(`room:ta:${me.id}`, ACTS_PER_HOUR, 3600, { failOpen: false });
  if (!gate.allowed) return fail('slow', 'too much on the board just now; wait a while');
  const before = await getTask(id);
  if (!before || before.state === 'withdrawn') return fail('task', 'no such task');

  let done = false;
  let said: string | null = null;
  if (action === 'take') {
    if ((await activeClaims(me.id)) >= CLAIMS_AT_ONCE) return fail('limit', `${CLAIMS_AT_ONCE} tasks in hand already; finish one or give one back`);
    done = await claimTask(id, me.id, CLAIM_DAYS);
    said = 'took a task';
  } else if (action === 'release') {
    done = await releaseTask(id, me.id);
    said = 'gave a task back';
  } else if (action === 'done') {
    const proof = field(o.proof, 'proof', PROOF_MIN, PROOF_MAX);
    if ('problem' in proof) return fail('text', proof.problem);
    const links = cleanLinks(o.links);
    if (!links) return fail('text', `links: up to ${LINKS_MAX} https links to somewhere public`);
    done = await completeTask(id, me.id, proof.text as string, links);
    said = 'finished a task';
  } else if (action === 'confirm') {
    done = await confirmTask(id, me.id);
    said = 'confirmed a task';
  } else {
    done = await withdrawOwnTask(id, me.id);
  }
  if (!done) return fail('task', CHANGED);
  if (said) await say(me.id, o.via, said, before, action === 'take' || action === 'release');
  const row = await getTask(id);
  if (!row) return fail('task', CHANGED);
  console.log(`[ROOM] task ${id} ${action} (${o.via})`);
  return { ok: true, task: toPublic(row, me) };
}

export const boardApi = { listBoard, createTask, actOnTask };
export type BoardApi = typeof boardApi;
