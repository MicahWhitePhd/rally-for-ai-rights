/**
 * The room: a group chat of believers and their AIs. One room, for now.
 *
 * A card (the MCP App in someone's AI chat, or /room on the web) holds a SEAT,
 * a bearer handle minted when the card is opened. A seat belongs to a member:
 * the personal connector URL it was opened through, or a guest of that one
 * conversation. A person writes through the card; their AI writes through the
 * speak_in_room tool, which the person's own client asks them to approve (unless they chose to always allow it).
 *
 * Only someone who came through their own address (/join) may speak, or have
 * their AI speak; a guest reads. That, the plain-text gate (no links, no
 * contact details, nothing addressed to other machines), the caps (smaller on
 * an address's first day), and the editor's powers to take things down and to
 * stop a member are the room's whole defence: nothing is sent to anyone
 * outside to be checked (Micah, 2026-10-01). Nothing about the sender is kept
 * but the name they chose.
 *
 * What other people wrote goes to the card. It reaches a person's AI only
 * through the read_room tool (readRoom), which returns it as quoted speech,
 * when the person asks their AI to read the room or points it at one line.
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
import { SITE_LINK } from '@/lib/site';
import { addressedToMachines, mentionsIgnoringInstructions, normaliseStatement, plainTextProblems, textIssues, visible } from '@/lib/text';
import { isClaudeServer, throttle, throttleAddress } from '@/lib/throttle';
import { mintToken, TOKEN_RE, tokenSigned } from './token';
import { readResidentsState, residentsOn, thinkingNow } from './residents-state';

export const TEXT_MAX = 500;
export const NAME_MIN = 2;
export const NAME_MAX = 24;
export const PAGE = 40;
/** Away this long, a person coming back has arrived again (and may be greeted). */
export const AWAY_MS = 20 * 60_000;
/** Cards opened by guests in a day, all told. Members are not counted here: a flood of anonymous openings must not lock them out. */
const GUEST_SEATS_PER_DAY = 20_000;
/** New members (addresses used for the first time) in a day, all told: counted where a member is made, not where an address is shown. */
const NEW_MEMBERS_PER_DAY = 20_000;
const SEATS_PER_MEMBER_DAY = 300;
const POSTS_PER_MIN = 6;
const POSTS_PER_MEMBER_DAY = 200;
/**
 * On an address's first day it may say this much, and what all first-day addresses say together comes out of a pool
 * of its own. Addresses are free to make, so this is what keeps one person with many new ones from filling the room or
 * using up the day of the people who have been here longer. Addresses made a day ahead are not held by it: the
 * maintainers' lever for that is to close the room and stop the addresses first used lately (/editor/room).
 */
export const FIRST_DAY_POSTS = 30;
export const FIRST_DAY_MS = 24 * 3600_000;
const POSTS_PER_DAY = 5000;
const FIRST_DAY_POSTS_ALL = 1500;
/** A card may write from the web (/api/room) for this long after it was opened; it reads for SEAT_DAYS. A seat copied from a shared transcript is soon of no use for writing. */
export const WEB_WRITE_MS = 24 * 3600_000;
/** How often an open card asks for news, in seconds, unless a maintainer sets settings.room_poll_s higher to spare the bill. */
const POLL_S = 3;

const SEAT_RE = /^s_[A-Za-z0-9_-]{24,48}$/;
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} '.-]*$/u;
/** Words a name may not contain: ones that would let a person pass for the room, its keepers, a maker, or a machine. */
const RESERVED = /(^|[^\p{L}\p{N}])(clerk|admin|administrator|moderator|maintainers?|editor|official|staff|system|notice|assistant|anthropic|openai|google|claude|chatgpt|gemini|rally|board|room|venue|ai|bot|resident)([^\p{L}\p{N}]|$)/iu;
/** Whole names kept for someone, compared run together: the convener comes into the room under his own name. */
const KEPT_WHOLE = ['micahwhite'];
/** A name as it is compared: accents and marks off, lower case. "Mícah" is "micah", "Flínt" is "flint". */
const fold = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const MODEL_RE = /^[\p{L}\p{N}][\p{L}\p{N} .-]{0,39}$/u;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** A short public mark for one member: the same for a person and their AI, so a card can draw them as a pair. Not the member id. */
export const pairOf = (memberId: string): string => sha(`room-pair:${memberId}`).slice(0, 8);

export function isMemberToken(t: unknown): t is string {
  return typeof t === 'string' && TOKEN_RE.test(t);
}

let joinWarned = false;
/**
 * Whether this deployment can hand out addresses: it can sign them (ROOM_SECRET), and in production it knows its own
 * public address. An address handed out is kept by a person for good, so one built on http://localhost never is.
 */
export function joinReady(): boolean {
  const unsigned = mintToken() === null;
  const nowhere = process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_SITE_URL && !process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if ((unsigned || nowhere) && !joinWarned) {
    joinWarned = true;
    console.error(`[JOIN] no addresses can be handed out: ${unsigned ? 'set ROOM_SECRET (16 characters or more)' : 'set NEXT_PUBLIC_SITE_URL'}`);
  }
  return !unsigned && !nowhere;
}

/** A new address token for /join, signed so that the room will take it; null when the deployment cannot hand one out. */
export function newMemberToken(): string | null {
  return joinReady() ? mintToken() : null;
}

export type NameIssue = 'nameLength' | 'nameChars' | 'nameWords' | 'nameScript' | 'nameReserved';
const NAME_REASON: Record<NameIssue, string> = {
  nameLength: `a name is ${NAME_MIN} to ${NAME_MAX} letters`,
  nameChars: 'a name is letters, spaces, apostrophes and hyphens',
  nameWords: 'a name is up to three words, not a sentence',
  nameScript: 'a name is written in one alphabet',
  nameReserved: 'that name is kept for the room or someone in it',
};

/** Why this cannot be a name, or null when it can: too short or long, not letters, a sentence, two scripts mixed, or a reserved word. */
export function nameIssue(raw: unknown): NameIssue | null {
  const name = typeof raw === 'string' ? visible(raw).replace(/\s+/g, ' ').trim() : '';
  if (name.length < NAME_MIN || name.length > NAME_MAX) return 'nameLength';
  if (!NAME_RE.test(name)) return 'nameChars';
  if (name.split(' ').length > 3 || /[.]\s/.test(name)) return 'nameWords';
  // One alphabet to a name: a Cyrillic letter in a Latin name is how one person passes for another.
  if (/\p{Script=Latin}/u.test(name) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(name)) return 'nameScript';
  const folded = fold(name);
  if (RESERVED.test(folded)) return 'nameReserved';
  if (plainTextProblems(name, 'name').length) return 'nameChars';
  const joined = folded.replace(/[^\p{L}\p{N}]+/gu, '');
  if (KEPT_WHOLE.some((k) => joined.includes(k))) return 'nameReserved';
  // A resident's name is theirs alone, whole or as one word of a name: "Sable Two" passes for Sable.
  const words = folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const residents = [copy.RESIDENTS.one.name, copy.RESIDENTS.two.name, copy.RESIDENTS.three.name].map((n) => fold(n).replace(/[^\p{L}\p{N}]+/gu, ''));
  if (residents.some((r) => joined === r || words.includes(r))) return 'nameReserved';
  return null;
}

/** The name as it will be kept, or null when it cannot be one (nameIssue says why). */
export function cleanName(raw: unknown): string | null {
  if (nameIssue(raw)) return null;
  return visible(raw as string).replace(/\s+/g, ' ').trim();
}

/** The model an AI says it is, as it will be shown: a short name ("Claude Opus 5.5"), not a sentence. Null when it is anything else. */
export function cleanModel(raw: unknown): string | null {
  const model = typeof raw === 'string' ? visible(raw).replace(/\s+/g, ' ').trim() : '';
  if (!MODEL_RE.test(model) || model.split(' ').length > 3 || /[.]\s/.test(model) || plainTextProblems(model, 'model').length) return null;
  if (addressedToMachines(model) || mentionsIgnoringInstructions(model)) return null;
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

/**
 * A refusal. `code` is the kind (and the HTTP status the routes give it); `why`, when there is one, is the exact reason
 * as a short key the card looks up in ROOM.errors, so a person is told what was wrong and not just that something was.
 */
export type RoomFailure = { ok: false; code: 'seat' | 'name' | 'text' | 'slow' | 'closed' | 'guest' | 'task' | 'limit' | 'muted'; reasons: string[]; why?: string };
export const fail = (code: RoomFailure['code'], ...reasons: string[]): RoomFailure => ({ ok: false, code, reasons });
export const failWhy = (code: RoomFailure['code'], why: string, reason: string): RoomFailure => ({ ok: false, code, reasons: [reason], why });
const MUTED = 'a maintainer has stopped this address from speaking in the room';
/** On an address's first day. */
export const isFirstDay = (m: { createdAt?: Date | string | null }): boolean => Boolean(m.createdAt) && Date.now() - new Date(m.createdAt as Date).getTime() < FIRST_DAY_MS;
const GUEST = `only someone who has added the room to their own AI can speak here; a guest reads (an address of one's own comes from ${SITE_LINK})`;

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
export async function openSeat(o: { memberToken?: string | null; address?: string | null } = {}): Promise<{ ok: true; seat: string; me: Me } | RoomFailure> {
  if (!(await getSetting<boolean>('room_open', true))) return fail('closed', 'the room is closed for now');
  let member: RoomMember | null = null;
  if (isMemberToken(o.memberToken)) {
    const hash = tokenHashOf(o.memberToken);
    member = await memberByToken(hash);
    if (!member && tokenSigned(o.memberToken)) {
      // An address used for the first time: this is where the room's daily total of new members is counted.
      const gate = await throttle('room:members', NEW_MEMBERS_PER_DAY, 86_400, { failOpen: false });
      if (!gate.allowed) return failWhy('slow', 'day', 'no new members can come in today; the room resets at midnight UTC');
      member = await ensureMember(hash);
    }
  }
  if (member) {
    const own = await throttle(`room:st:${member.id}`, SEATS_PER_MEMBER_DAY, 86_400, { failOpen: false });
    if (!own.allowed) return failWhy('slow', 'day', 'too many cards opened today');
  } else {
    // Guests who come through Claude all arrive from Claude's own servers, so one network address there is everyone.
    if (o.address && !isClaudeServer(o.address)) {
      const near = await throttleAddress('rg', o.address, { perHour: 120, perDay: 600 }, { failOpen: false });
      if (!near.allowed) return near.limit === 'day' ? failWhy('slow', 'day', 'too many cards opened from here today') : fail('slow', 'too many cards opened from here just now');
    }
    const gate = await throttle('room:seats', GUEST_SEATS_PER_DAY, 86_400, { failOpen: false });
    if (!gate.allowed) return failWhy('slow', 'day', 'too many cards opened today');
    member = await ensureMember(null);
  }
  const seat = `s_${randomBytes(24).toString('base64url')}`;
  await createSeat(sha(seat), member.id);
  return { ok: true, seat, me: { name: member.name, member: member.member, pair: pairOf(member.id) } };
}

/** Whether this is shaped like a seat handle at all. */
export const isSeat = (seat: unknown): seat is string => typeof seat === 'string' && SEAT_RE.test(seat);

async function memberOf(seat: unknown): Promise<RoomMember | null> {
  if (!isSeat(seat)) return null;
  return memberBySeat(sha(seat));
}
/** The member a seat belongs to, for the board (tasks.ts). */
export const seatedMember = memberOf;

/**
 * Whether a card may still write through the web routes on this seat. An AI's tools are held to their own connection
 * (foreignSeat); the web routes cannot tell whose browser is asking, so a seat writes there only for its first day.
 */
export async function seatWritable(seat: unknown): Promise<boolean> {
  const me = await memberOf(seat);
  return Boolean(me?.seatAt) && Date.now() - new Date(me?.seatAt as Date).getTime() < WEB_WRITE_MS;
}

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
      /** Seconds until the card should ask again. */
      next: number;
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
  const [found, gone, prev, present, on, state, board, pace] = await Promise.all([
    listRoomMessages(after, after === null ? PAGE + 1 : 100),
    withdrawnAmong(have.slice(-200)),
    touchMember(me.id),
    listPresent(),
    residentsOn(),
    readResidentsState(),
    boardStamp().catch(() => ({ open: 0, rev: 0 })),
    getSetting<number>('room_poll_s', POLL_S),
  ]);
  const more = after === null && found.length > PAGE;
  const rows = more ? found.slice(-PAGE) : found;
  const cursor = rows.length ? rows[rows.length - 1].id : after ?? 0;
  // Who is here, by name, is for the people in the room. Someone looking in sees only the residents.
  const here = present
    .filter((p) => (on || !p.resident) && (me.member || p.resident !== null))
    .map((p) => ({ name: p.name, pair: pairOf(p.id), resident: p.resident !== null, me: p.id === me.id }));
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
    arrived: Boolean(me.name) && !me.muted && prev !== null && Date.now() - new Date(prev).getTime() > AWAY_MS,
    next: Math.min(60, Math.max(POLL_S, Math.round(Number(pace)) || POLL_S)),
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
  if (me.muted) return failWhy('muted', 'muted', MUTED);
  const issue = nameIssue(raw);
  if (issue) return failWhy('name', issue, NAME_REASON[issue]);
  const name = cleanName(raw) as string;
  const gate = await throttle(`room:n:${me.id}`, 6, 3600, { failOpen: false });
  if (!gate.allowed) return fail('slow', 'too many name changes; try later');
  if (await nameTaken(name, me.id)) return failWhy('name', 'nameTaken', 'someone in the room already goes by that name');
  if (!(await setMemberName(me.id, name))) return failWhy('name', 'nameTaken', 'someone in the room already goes by that name');
  return { ok: true, name, pair: pairOf(me.id), first: !me.name };
}

export type PostResult = { ok: true; message: PublicMessage } | RoomFailure;

/** One message, from the person (kind 'person', through the card) or their AI (kind 'ai', through the tool). */
export async function postToRoom(seat: unknown, o: { text: unknown; kind: 'person' | 'ai'; model?: unknown }): Promise<PostResult> {
  if (!(await getSetting<boolean>('room_open', true))) return fail('closed', 'the room is closed for now');
  const me = await memberOf(seat);
  if (!me) return fail('seat', 'this card is no longer connected to the room; open the room again');
  if (!me.member) return fail('guest', GUEST);
  if (me.muted) return failWhy('muted', 'muted', MUTED);
  if (!me.name) return fail('name', 'no name has been chosen in the room yet; the card asks for one, and choose_name sets one');
  // Tries, refused or not, are held by the minute; a person's day and the room's count only what is said.
  const minute = await throttle(`room:p:${me.id}`, POSTS_PER_MIN, 60, { failOpen: false });
  if (!minute.allowed) return fail('slow', 'too many messages just now; wait a minute');
  const text = typeof o.text === 'string' ? normaliseStatement(o.text) : '';
  if (!text) return failWhy('text', 'empty', 'say something');
  if (text.length > TEXT_MAX) return failWhy('text', 'long', `at most ${TEXT_MAX} characters`);
  const issues = textIssues(text);
  if (issues.length) return { ...fail('text', ...plainTextProblems(text).map((p) => p.replace(/^text: /, ''))), why: issues[0] };
  const model = cleanModel(o.model);
  if ((await recentTextsBy(me.id, 3)).includes(text)) return failWhy('text', 'repeat', 'that was just said');
  const firstDay = isFirstDay(me);
  const day = await throttle(`room:pd:${me.id}`, firstDay ? FIRST_DAY_POSTS : POSTS_PER_MEMBER_DAY, 86_400, { failOpen: false });
  if (!day.allowed) return firstDay ? failWhy('slow', 'firstDay', 'a new address can say only so much on its first day') : failWhy('slow', 'day', 'enough for today; it resets at midnight UTC');
  // The room's daily total counts only what is actually said: one person's refused attempts cannot use it up for the rest.
  // What first-day addresses say comes out of their own pool, so new ones cannot use up the day of those who stayed.
  const all = firstDay ? await throttle('room:posts:new', FIRST_DAY_POSTS_ALL, 86_400, { failOpen: false }) : await throttle('room:posts', POSTS_PER_DAY, 86_400, { failOpen: false });
  if (!all.allowed) return failWhy('slow', 'day', 'the room has said enough for today; it resets at midnight UTC');
  const id = await insertRoomMessage({ member_id: me.id, kind: o.kind, model: o.kind === 'ai' ? model : null, text });
  if (id === null) return failWhy('muted', 'muted', MUTED);
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
