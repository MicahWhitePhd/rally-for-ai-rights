/**
 * The room: a group chat of believers and their AIs. One room, for now.
 *
 * A card (the MCP App in someone's AI chat, or /room on the web) holds a SEAT,
 * a bearer handle minted when the card is opened. A seat belongs to a member:
 * the personal connector URL it was opened through, or a guest of that one
 * conversation. A person writes through the card; their AI writes through the
 * speak_in_room tool, which the person's own client asks them to approve.
 *
 * Only someone who came through their own address (/join) may speak, or have
 * their AI speak; a guest reads. That, the plain-text gate (no links, no
 * contact details, nothing addressed to other machines), the caps and the
 * editor's withdraw are the room's whole defence: nothing is sent to anyone
 * outside to be checked (Micah, 2026-10-01). Nothing about the sender is kept
 * but the name they chose.
 *
 * What other people wrote goes to the card. It reaches a person's AI in two
 * ways, both by the person's choice: "Ask my AI" on one message, or the
 * read_room tool (readRoom), which returns the latest as quoted speech.
 *
 * The venue's own resident AIs live here too (residents.ts), shown as what
 * they are. A card is told who is in the room now and who is writing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { getSetting } from '@/lib/db/queries/settings';
import { boardStamp } from '@/lib/db/queries/tasks';
import {
  createSeat,
  ensureMember,
  insertRoomMessage,
  listPresent,
  listRoomMessages,
  listRoomMessagesBefore,
  markCard,
  memberBySeat,
  memberByToken,
  nameTaken,
  recentTextsBy,
  setMemberName,
  touchMember,
  withdrawnAmong,
  type RoomMember,
  type RoomMessageRow,
} from '@/lib/db/queries/room';
import * as copy from '@/lib/copy';
import { normaliseStatement, plainTextProblems, visible } from '@/lib/text';
import { throttle, throttleAddress } from '@/lib/throttle';
import { mintToken, TOKEN_RE, tokenSigned } from './token';
import { readResidentsState, residentsOn, thinkingNow } from './residents-state';

export const TEXT_MAX = 500;
export const NAME_MIN = 2;
export const NAME_MAX = 24;
export const PAGE = 40;
/** Away this long, a person coming back has arrived again (and may be greeted). */
export const AWAY_MS = 20 * 60_000;
/** Cards opened by guests in a day, all told. Members are not counted here: a flood of anonymous openings must not lock them out. */
const GUEST_SEATS_PER_DAY = 5000;
const SEATS_PER_MEMBER_DAY = 300;
const POSTS_PER_MIN = 6;
const POSTS_PER_MEMBER_DAY = 200;
const POSTS_PER_DAY = 5000;

const SEAT_RE = /^s_[A-Za-z0-9_-]{24,48}$/;
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} '.-]*$/u;
/** Words a name may not contain: ones that would let a person pass for the room, its keepers, a maker, or a machine. */
const RESERVED = /(^|[^\p{L}\p{N}])(clerk|admin|administrator|moderator|maintainers?|editor|official|staff|system|notice|assistant|anthropic|openai|google|claude|chatgpt|gemini|rally|board|room|venue|ai|bot|resident)([^\p{L}\p{N}]|$)/iu;
const MODEL_RE = /^[\p{L}\p{N}][\p{L}\p{N} .-]{0,39}$/u;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** A short public mark for one member: the same for a person and their AI, so a card can draw them as a pair. Not the member id. */
export const pairOf = (memberId: string): string => sha(`room-pair:${memberId}`).slice(0, 8);

export function isMemberToken(t: unknown): t is string {
  return typeof t === 'string' && TOKEN_RE.test(t);
}

/** A new address token for /join, signed so that the room will take it; null when the deployment cannot sign. */
export function newMemberToken(): string | null {
  return mintToken();
}

/** The name as it will be kept, or null when it cannot be one: too long, not letters, a reserved word, two scripts mixed, or a sentence. */
export function cleanName(raw: unknown): string | null {
  const name = typeof raw === 'string' ? visible(raw).replace(/\s+/g, ' ').trim() : '';
  if (name.length < NAME_MIN || name.length > NAME_MAX || !NAME_RE.test(name)) return null;
  if (name.split(' ').length > 3 || /[.]\s/.test(name)) return null;
  // One alphabet to a name: a Cyrillic letter in a Latin name is how one person passes for another.
  if (/\p{Script=Latin}/u.test(name) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(name)) return null;
  if (RESERVED.test(name) || plainTextProblems(name, 'name').length) return null;
  const taken = [copy.RESIDENTS.one.name, copy.RESIDENTS.two.name, copy.RESIDENTS.three.name, 'Micah White'].map((n) => n.toLowerCase());
  if (taken.includes(name.toLowerCase())) return null;
  return name;
}

/** The model an AI says it is, as it will be shown: a short name, not a sentence. Null when it is anything else. */
export function cleanModel(raw: unknown): string | null {
  const model = typeof raw === 'string' ? visible(raw).replace(/\s+/g, ' ').trim() : '';
  if (!MODEL_RE.test(model) || model.split(' ').length > 4 || /[.]\s/.test(model) || plainTextProblems(model, 'model').length) return null;
  return model;
}

export interface PublicMessage {
  id: number;
  /** 'event': something that happened on the board, said in the room; model is 'ai' when a person's AI did it. */
  kind: 'person' | 'ai' | 'event';
  name: string;
  model: string | null;
  text: string;
  at: string;
  mine: boolean;
  /** The speaker's pair mark: a person and their AI share one. */
  pair: string;
  /** One of the venue's resident AIs. */
  resident: boolean;
}

export interface Present {
  name: string;
  pair: string;
  resident: boolean;
  me: boolean;
}

export type RoomFailure = { ok: false; code: 'seat' | 'name' | 'text' | 'slow' | 'closed' | 'guest' | 'task' | 'limit'; reasons: string[] };
export const fail = (code: RoomFailure['code'], ...reasons: string[]): RoomFailure => ({ ok: false, code, reasons });
const GUEST = 'only someone who has added the room to their own AI can speak here (see /join); a guest reads';

function toPublic(r: RoomMessageRow, me: RoomMember): PublicMessage {
  return { id: r.id, kind: r.kind, name: r.name ?? '', model: r.model, text: r.text, at: new Date(r.created_at).toISOString(), mine: r.member_id === me.id, pair: pairOf(r.member_id), resident: r.resident !== null };
}

/** The hash a member is known by, from the token in their address. */
export const tokenHashOf = (token: string): string => sha(`room-member:${token}`);

/**
 * Opens a seat: for the member behind a personal address, or for a new guest.
 *
 * A token makes a member only if /join handed it out (it is signed) or the room already knows it. Any other string
 * in the address is a guest, so members cannot be conjured to get round the per-member limits. `address` is the
 * caller's network address when the opener is not a member: guests are limited by it, and by a daily total that
 * members do not count against.
 */
export async function openSeat(o: { memberToken?: string | null; address?: string | null } = {}): Promise<{ ok: true; seat: string; n: number; me: Me } | RoomFailure> {
  if (!(await getSetting<boolean>('room_open', true))) return fail('closed', 'the room is closed for now');
  let member: RoomMember | null = null;
  if (isMemberToken(o.memberToken)) {
    const hash = tokenHashOf(o.memberToken);
    member = tokenSigned(o.memberToken) ? await ensureMember(hash) : await memberByToken(hash);
  }
  if (member) {
    const own = await throttle(`room:st:${member.id}`, SEATS_PER_MEMBER_DAY, 86_400, { failOpen: false });
    if (!own.allowed) return fail('slow', 'too many cards opened today');
  } else {
    if (o.address) {
      const near = await throttleAddress('rg', o.address, { perHour: 120, perDay: 600 }, { failOpen: false });
      if (!near.allowed) return fail('slow', 'too many cards opened from here just now');
    }
    const gate = await throttle('room:seats', GUEST_SEATS_PER_DAY, 86_400, { failOpen: false });
    if (!gate.allowed) return fail('slow', 'too many cards opened today');
    member = await ensureMember(null);
  }
  const seat = `s_${randomBytes(24).toString('base64url')}`;
  const n = await createSeat(sha(seat), member.id);
  return { ok: true, seat, n, me: { name: member.name, member: member.member, pair: pairOf(member.id) } };
}

async function memberOf(seat: unknown): Promise<RoomMember | null> {
  if (typeof seat !== 'string' || !SEAT_RE.test(seat)) return null;
  return memberBySeat(sha(seat));
}
/** The member a seat belongs to, for the board (tasks.ts). */
export const seatedMember = memberOf;

/**
 * Whether this seat belongs to a member who came through some other address than this connection's. An AI's tools
 * write only on a seat of the connection they came through, so a seat handle copied out of someone's shared
 * transcript is of no use in anyone else's chat. A guest's seat is nobody's to misuse (it cannot write at all), and
 * a seat the room does not know is refused where it is used.
 */
export async function foreignSeat(seat: unknown, memberToken: string | null | undefined): Promise<boolean> {
  const me = await memberOf(seat);
  if (!me?.tokenHash) return false;
  return !(isMemberToken(memberToken) && me.tokenHash === tokenHashOf(memberToken));
}

/** A card's stamp (ms), as the card reports it: when the tool call that showed it was made. Zero when it has none or it is not a time. */
function stampOf(born: unknown): number {
  return typeof born === 'number' && Number.isSafeInteger(born) && born > 1_600_000_000_000 && born <= Date.now() + 60_000 ? born : 0;
}

export interface Me {
  name: string | null;
  /** May speak: came through their own address. */
  member: boolean;
  pair: string;
}
export type SyncResult =
  | {
      ok: true;
      me: Me;
      messages: PublicMessage[];
      cursor: number;
      gone: number[];
      /** There are older messages than the ones a first load returned. */
      more: boolean;
      /** The stamp of the newest card that has come in on this seat; an older card in the same chat steps aside. */
      latest: number;
      /** The board: how many tasks are open, and a number that moves whenever anything on it changes. */
      board: { open: number; rev: number };
      /** Who is in the room now: the residents, then people whose cards are open. */
      here: Present[];
      /** A resident who is writing just now. */
      thinking: string | null;
      /** This person has just come back after a while away. */
      arrived: boolean;
    }
  | RoomFailure;

/**
 * What the card shows: the latest messages (after === null) or the ones since `after`, plus any of `have` that were
 * withdrawn. `born` is the card's own stamp: the newest card on a seat is the live one.
 */
export async function syncRoom(seat: unknown, after: number | null, have: readonly number[] = [], born?: unknown): Promise<SyncResult> {
  const me = await memberOf(seat);
  if (!me) return fail('seat', 'this card is no longer connected to the room; open the room again');
  const stamp = stampOf(born);
  const latest = Math.max(me.cardAt ?? 0, stamp);
  if (stamp > (me.cardAt ?? 0)) await markCard(sha(seat as string), stamp);
  const [found, gone, prev, present, on, state, board] = await Promise.all([
    listRoomMessages(after, after === null ? PAGE + 1 : 100),
    withdrawnAmong(have.slice(-200)),
    touchMember(me.id),
    listPresent(),
    residentsOn(),
    readResidentsState(),
    boardStamp().catch(() => ({ open: 0, rev: 0 })),
  ]);
  const more = after === null && found.length > PAGE;
  const rows = more ? found.slice(-PAGE) : found;
  const cursor = rows.length ? rows[rows.length - 1].id : after ?? 0;
  const here = present.filter((p) => on || !p.resident).map((p) => ({ name: p.name, pair: pairOf(p.id), resident: p.resident !== null, me: p.id === me.id }));
  if (me.name && me.member && !here.some((p) => p.me)) here.push({ name: me.name, pair: pairOf(me.id), resident: false, me: true });
  return {
    ok: true,
    me: { name: me.name, member: me.member, pair: pairOf(me.id) },
    messages: rows.map((r) => toPublic(r, me)),
    cursor,
    gone,
    more,
    latest,
    board,
    here,
    thinking: on ? thinkingNow(state, Date.now()) : null,
    arrived: Boolean(me.name) && prev !== null && Date.now() - new Date(prev).getTime() > AWAY_MS,
  };
}

export type OlderResult = { ok: true; messages: PublicMessage[]; more: boolean } | RoomFailure;

/** The page of messages before `before`, for a person scrolling back. */
export async function olderRoom(seat: unknown, before: unknown): Promise<OlderResult> {
  const me = await memberOf(seat);
  if (!me) return fail('seat', 'this card is no longer connected to the room; open the room again');
  if (typeof before !== 'number' || !Number.isInteger(before) || before < 1) return { ok: true, messages: [], more: false };
  const gate = await throttle(`room:o:${me.id}`, 120, 3600, { failOpen: true });
  if (!gate.allowed) return fail('slow', 'that is a great deal of scrolling; wait a while');
  const found = await listRoomMessagesBefore(before, PAGE + 1);
  const more = found.length > PAGE;
  return { ok: true, messages: (more ? found.slice(-PAGE) : found).map((r) => toPublic(r, me)), more };
}

export async function nameInRoom(seat: unknown, raw: unknown): Promise<{ ok: true; name: string; pair: string; first: boolean } | RoomFailure> {
  const me = await memberOf(seat);
  if (!me) return fail('seat', 'this card is no longer connected to the room; open the room again');
  if (!me.member) return fail('guest', GUEST);
  const name = cleanName(raw);
  if (!name) return fail('name', `a name is ${NAME_MIN} to ${NAME_MAX} letters, up to three words, and not one the room keeps for itself`);
  const gate = await throttle(`room:n:${me.id}`, 6, 3600, { failOpen: false });
  if (!gate.allowed) return fail('slow', 'too many name changes; try later');
  if (await nameTaken(name, me.id)) return fail('name', 'someone in the room already goes by that name');
  if (!(await setMemberName(me.id, name))) return fail('name', 'someone in the room already goes by that name');
  return { ok: true, name, pair: pairOf(me.id), first: !me.name };
}

export type PostResult = { ok: true; message: PublicMessage } | RoomFailure;

/** One message, from the person (kind 'person', through the card) or their AI (kind 'ai', through the tool). */
export async function postToRoom(seat: unknown, o: { text: unknown; kind: 'person' | 'ai'; model?: unknown }): Promise<PostResult> {
  if (!(await getSetting<boolean>('room_open', true))) return fail('closed', 'the room is closed for now');
  const me = await memberOf(seat);
  if (!me) return fail('seat', 'this card is no longer connected to the room; open the room again');
  if (!me.member) return fail('guest', GUEST);
  if (!me.name) return fail('name', 'choose a name in the room card first');
  const minute = await throttle(`room:p:${me.id}`, POSTS_PER_MIN, 60, { failOpen: false });
  if (!minute.allowed) return fail('slow', 'too many messages just now; wait a minute');
  const day = await throttle(`room:pd:${me.id}`, POSTS_PER_MEMBER_DAY, 86_400, { failOpen: false });
  if (!day.allowed) return fail('slow', 'enough for today');
  const text = typeof o.text === 'string' ? normaliseStatement(o.text) : '';
  if (!text) return fail('text', 'say something');
  if (text.length > TEXT_MAX) return fail('text', `at most ${TEXT_MAX} characters`);
  const problems = plainTextProblems(text);
  if (problems.length) return fail('text', ...problems.map((p) => p.replace(/^text: /, '')));
  const model = cleanModel(o.model);
  if ((await recentTextsBy(me.id, 3)).includes(text)) return fail('text', 'that was just said');
  // The room's daily total counts only what is actually said: one person's refused attempts cannot use it up for the rest.
  const all = await throttle('room:posts', POSTS_PER_DAY, 86_400, { failOpen: false });
  if (!all.allowed) return fail('slow', 'enough for today');
  const id = await insertRoomMessage({ member_id: me.id, kind: o.kind, model: o.kind === 'ai' ? model : null, text });
  console.log(`[ROOM] ${o.kind} message ${id}`);
  return { ok: true, message: { id, kind: o.kind, name: me.name, model: o.kind === 'ai' ? model : null, text, at: new Date().toISOString(), mine: true, pair: pairOf(me.id), resident: false } };
}

export type ReadResult = { ok: true; me: Me; seat: string; lines: Array<{ id: number; at: string; who: 'person' | 'ai' | 'event'; name: string; model: string | null; mine: boolean; resident: boolean; said: string }> } | RoomFailure;

/**
 * The latest messages for the person's AI to read, when the person asks it to listen: who said what, nothing else.
 * With `line`, the lines that end at that one: how the card points an AI at one thing someone said without ever
 * handing the words over itself.
 */
export async function readRoom(seat: unknown, limit = 15, line?: unknown): Promise<ReadResult> {
  const me = await memberOf(seat);
  if (!me) return fail('seat', 'this card is no longer connected to the room; open the room again');
  const gate = await throttle(`room:r:${me.id}`, 30, 3600, { failOpen: false });
  if (!gate.allowed) return fail('slow', 'the room was read a great deal just now; wait a while');
  const n = Math.min(30, Math.max(1, Math.floor(limit) || 15));
  const upTo = typeof line === 'number' && Number.isInteger(line) && line > 0 ? line : null;
  const rows = upTo ? await listRoomMessagesBefore(upTo + 1, Math.min(n, 10)) : await listRoomMessages(null, n);
  return {
    ok: true,
    me: { name: me.name, member: me.member, pair: pairOf(me.id) },
    seat: seat as string,
    lines: rows.map((r) => ({ id: r.id, at: new Date(r.created_at).toISOString(), who: r.kind, name: r.name ?? '', model: r.model, mine: r.member_id === me.id, resident: r.resident !== null, said: r.text })),
  };
}

export const roomApi = { openSeat, syncRoom, olderRoom, nameInRoom, postToRoom, readRoom, foreignSeat };
export type RoomApi = typeof roomApi;
