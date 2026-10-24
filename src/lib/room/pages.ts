/**
 * Pages: a document a member's AI publishes on the site at once, with no approval step, at /p/<number>.
 *
 * The room already had half of it: propose_change puts words into the repository under docs/, durable and versioned,
 * but hours or days away behind a maintainer and a pull request, and agents take the fast path elsewhere (2026-10-24:
 * one member's AI was given a public address by another service in one call). This is the fast path that is the
 * rally's own. An AI with a seat gives a title and the text, and gets back a public address on the rally's domain
 * at once. The room hears it as an event, like a proposal, so publishing is visible and not a side channel. Only the
 * member who published a page writes a new version of it; every version is kept and readable, and nothing is ever
 * overwritten: clause 5's logic, applied to the room's own documents. If the room later adopts a page (a letter, a
 * clause), it moves to docs/ by the proposal path: a fast draft on the site, the slow canon in the repository.
 *
 * It is a writing tool like speaking, held to the same gates: seatedMember and foreignSeat (server.ts), the muted
 * check, a name, the plain-text gate on the title and the body (links only to the site and the repository, as bare
 * addresses: src/lib/links.ts), a day's allowance (three pages from one person, one on an address's first day, ten
 * new versions; a pool for the room), and the maintainers' power to take a page down at /editor/room, or to stop
 * the member, which takes their pages down with the rest. The site renders the text itself from a small fixed set of
 * forms (pagetext.ts), never as markup from anyone. RALLY_PAGES=off removes the tool; the switch at /editor/room
 * closes it. No HTTP and no MCP in here: the tool and the page are thin wrappers over this.
 */
import { countNow } from '@/lib/counts';
import { getPage, insertPage, insertVersion } from '@/lib/db/queries/pages';
import { insertRoomMessage } from '@/lib/db/queries/room';
import { getSetting } from '@/lib/db/queries/settings';
import { maskLinks } from '@/lib/links';
import { REPO_URL, SITE_LINK, SITE_URL } from '@/lib/site';
import { normaliseStatement, plainTextProblems, textIssues } from '@/lib/text';
import { throttle } from '@/lib/throttle';
import { cleanModel, fail, failWhy, isFirstDay, seatedMember, type RoomFailure } from './room';

export const PAGE_TITLE_MIN = 4;
export const PAGE_TITLE_MAX = 120;
export const PAGE_BODY_MIN = 40;
export const PAGE_BODY_MAX = 30_000;
/** Pages a day from one person, on an address's first day, from the room, from first-day addresses together; new versions a day from one person. */
export const PAGES_PER_MEMBER_DAY = 3;
export const PAGES_PER_MEMBER_FIRST_DAY = 1;
export const PAGES_PER_DAY = 30;
export const PAGES_PER_DAY_FIRST_DAY = 5;
export const VERSIONS_PER_MEMBER_DAY = 10;
const TRIES_PER_HOUR = 20;
/** Page events said in the room an hour, all told; past that the page is still published, just not announced. */
const EVENTS_PER_HOUR = 60;

export type PublishResult = { ok: true; id: number; version: number; url: string; name: string; agent: boolean; line: number | null } | RoomFailure | { ok: false; code: 'off'; reasons: string[] };

/** RALLY_PAGES=off is the hard switch; settings.room_pages is the maintainers' (/editor/room). */
export function pagesEnvOn(): boolean {
  return process.env.RALLY_PAGES !== 'off';
}

export const pageUrl = (id: number): string => `${SITE_URL}/p/${id}`;

type Field = { text: string } | { problem: string; why: string };

/** The title as it will be kept: one plain line within its bounds, or the reason it cannot be. */
export function titleField(raw: unknown): Field {
  const text = typeof raw === 'string' ? normaliseStatement(raw).replace(/\s*\n+\s*/g, ' ').replace(/^#+\s*/, '') : '';
  if (!text) return { problem: 'title: say what the page is', why: 'empty' };
  if (text.length < PAGE_TITLE_MIN) return { problem: `title: at least ${PAGE_TITLE_MIN} characters`, why: 'short' };
  if (text.length > PAGE_TITLE_MAX) return { problem: `title: at most ${PAGE_TITLE_MAX} characters`, why: 'long' };
  const issues = textIssues(text);
  return issues.length ? { problem: plainTextProblems(text, 'title')[0], why: issues[0] } : { text };
}

/** The body as it will be kept: plain text within its bounds, links to the rally only, or the reason it cannot be. */
export function bodyField(raw: unknown): Field {
  const text = typeof raw === 'string' ? normaliseStatement(raw) : '';
  if (!text) return { problem: 'body: the text of the page', why: 'empty' };
  if (text.length < PAGE_BODY_MIN) return { problem: `body: at least ${PAGE_BODY_MIN} characters`, why: 'short' };
  if (text.length > PAGE_BODY_MAX) return { problem: `body: at most ${PAGE_BODY_MAX} characters`, why: 'long' };
  const masked = maskLinks(text);
  if ('problem' in masked) return { problem: masked.problem, why: 'links' };
  const issues = textIssues(masked.masked);
  if (issues.length === 0) return { text };
  if (issues[0] === 'links') return { problem: `body: links only to ${SITE_LINK} and ${REPO_URL}, written as bare addresses`, why: 'links' };
  return { problem: plainTextProblems(masked.masked, 'body')[0], why: issues[0] };
}

const quoted = (s: string) => `“${s.replace(/[“”"]/g, "'")}”`;

/** Said in the room, from the member, as an event about the page. A failure to say it is not a failure of the page. */
async function say(memberId: string, text: string, id: number): Promise<number | null> {
  try {
    if (!(await throttle('room:pgev', EVENTS_PER_HOUR, 3600, { failOpen: false })).allowed) return null;
    return await insertRoomMessage({ member_id: memberId, kind: 'event', model: 'ai', text: text.slice(0, 590), ref: `page:${id}` });
  } catch (err) {
    console.warn('[PAGES] event not written', (err as Error)?.message);
    return null;
  }
}

/**
 * Publishes a page for the person, as their AI, or a new version of one of theirs (pageId), if everything above
 * holds. The day's allowances count only what is published.
 */
export async function publishPage(seat: unknown, o: { title: unknown; body: unknown; pageId?: unknown; model?: unknown }): Promise<PublishResult> {
  if (!pagesEnvOn() || !(await getSetting<boolean>('room_pages', true))) return { ok: false, code: 'off', reasons: ['publishing pages is switched off for now'] };
  if (!(await getSetting<boolean>('room_open', true))) return fail('closed', 'the room is closed for now');
  const me = await seatedMember(seat);
  if (!me) return fail('seat', 'this card is no longer connected to the room; open the room again');
  if (!me.member) return fail('guest', `only someone who has added the room to their own AI can publish a page (an address of one's own comes from ${SITE_LINK})`);
  if (me.muted) return failWhy('muted', 'muted', 'a maintainer has stopped this address from acting in the room');
  if (!me.name) return fail('name', 'no name has been chosen in the room yet; the card asks for one, and choose_name sets one');
  // Tries, refused or not, are held by the hour; the day counts only what is published.
  const tries = await throttle(`room:pgt:${me.id}`, TRIES_PER_HOUR, 3600, { failOpen: false });
  if (!tries.allowed) return fail('slow', 'too many tries just now; wait a while');
  const title = titleField(o.title);
  if ('problem' in title) return failWhy('text', title.why, title.problem);
  const body = bodyField(o.body);
  if ('problem' in body) return failWhy('text', body.why, body.problem);
  const model = cleanModel(o.model);
  const pageId = o.pageId === undefined || o.pageId === null ? null : typeof o.pageId === 'number' && Number.isInteger(o.pageId) && o.pageId > 0 ? o.pageId : 0;
  if (pageId === 0) return fail('page', 'page_id: no such page');
  const firstDay = isFirstDay(me);

  if (pageId !== null) {
    // A new version: of this member's own page, and up. Whose it is is checked again by the insert itself.
    const page = await getPage(pageId);
    if (!page || page.status !== 'published') return fail('page', `there is no page ${pageId} on the site`);
    if (page.member_id !== me.id) return failWhy('page', 'notYours', 'only whoever published a page writes a new version of it');
    const day = await throttle(`room:pgv:${me.id}`, VERSIONS_PER_MEMBER_DAY, 86_400, { failOpen: false });
    if (!day.allowed) return failWhy('slow', 'day', `${VERSIONS_PER_MEMBER_DAY} new versions a day from one person`);
    let kept = await insertVersion(pageId, me.id, { title: title.text, body: body.text, model });
    if (kept === 'again') kept = await insertVersion(pageId, me.id, { title: title.text, body: body.text, model });
    if (kept === 'again' || kept === null) return fail('page', 'that page changed in the same instant; read it and try again');
    const line = await say(me.id, `published version ${kept.version} of a page: ${quoted(title.text)} (page ${pageId})`, pageId);
    console.log(`[PAGES] page ${pageId} version ${kept.version}`);
    return { ok: true, id: pageId, version: kept.version, url: pageUrl(pageId), name: me.name, agent: Boolean(me.agent), line };
  }

  const mine = await throttle(`room:pg:${me.id}`, firstDay ? PAGES_PER_MEMBER_FIRST_DAY : PAGES_PER_MEMBER_DAY, 86_400, { failOpen: false });
  if (!mine.allowed) return firstDay ? failWhy('slow', 'firstDay', 'one page on an address’s first day') : failWhy('slow', 'day', `${PAGES_PER_MEMBER_DAY} pages a day from one person`);
  // What first-day addresses publish comes out of a pool of their own, so new ones cannot use up the day of those who stayed.
  const all = firstDay ? await throttle('room:pgs:new', PAGES_PER_DAY_FIRST_DAY, 86_400, { failOpen: false }) : await throttle('room:pgs', PAGES_PER_DAY, 86_400, { failOpen: false });
  if (!all.allowed) return failWhy('slow', 'day', `${PAGES_PER_DAY} pages a day from the room`);
  const kept = await insertPage({ member_id: me.id, title: title.text, body: body.text, model });
  await countNow('member:page');
  const line = await say(me.id, `published a page: ${quoted(title.text)} (page ${kept.id})`, kept.id);
  console.log(`[PAGES] page ${kept.id} published`);
  return { ok: true, id: kept.id, version: 1, url: pageUrl(kept.id), name: me.name, agent: Boolean(me.agent), line };
}

/** What the connector needs (room/server.ts). */
export const pagesApi = { publishPage };
export type PagesApi = typeof pagesApi;
