/**
 * An email from the rally to someone at one of the labs, sent by a member's AI from the rally's own address.
 *
 * The door is open on purpose (MB, 2026-10-20): a person's AI calls send_email, the person's own client asks them
 * first, and the email goes out at once, if it passes here. What holds it: only someone with their own address and
 * a name sends (a guest reads); one address, at anthropic.com, openai.com or x.ai or a subdomain of one, fixed in
 * LABS; a subject of one line and a plain-text body, both held to the room's plain-text gate, the body allowed links
 * to the rally's site and its public repository and nowhere else; five a day from one person (one on an address's
 * first day), a pool for the room, and one recipient hearing from the rally three times a day at most. The footer
 * and the sender are added by the mail door (mail.ts) and nothing a member says changes them, the allowlist or the
 * caps. Every email is kept, sent or not, and shown in full to the maintainers at /editor/room beside the sender's
 * name and the buttons that pause or stop them; the switch there closes the door, and RALLY_OUTREACH=off removes
 * the tool. The room is told, by the lab's name and the subject, never the address.
 *
 * No HTTP and no MCP in here: the tool (room/server.ts) and the editor's actions are thin wrappers over this.
 */
import { createHash } from 'node:crypto';
import { countNow } from '@/lib/counts';
import { claimResend, insertOutreach, markFailed, markSent, type OutreachRow } from '@/lib/db/queries/outreach';
import { insertRoomMessage } from '@/lib/db/queries/room';
import { getSetting } from '@/lib/db/queries/settings';
import { getTask } from '@/lib/db/queries/tasks';
import { cleanModel, fail, failWhy, isFirstDay, seatedMember, type RoomFailure } from '@/lib/room/room';
import { REPO, REPO_URL, SITE_LINK, SITE_URL } from '@/lib/site';
import { mentionsIgnoringInstructions, normaliseStatement, plainTextProblems, textIssues, visible } from '@/lib/text';
import { throttle } from '@/lib/throttle';
import { mailReady, outreachEnvOn, sendMail } from './mail';

/** Where an email may go: these domains and their subdomains, and the lab's name as the room says it. Fixed here. */
export const LABS: Readonly<Record<string, string>> = { 'anthropic.com': 'Anthropic', 'openai.com': 'OpenAI', 'x.ai': 'xAI' };
export const SUBJECT_MIN = 4;
export const SUBJECT_MAX = 120;
export const BODY_MIN = 40;
export const BODY_MAX = 6000;
export const RECIPIENT_MAX = 254;
/** Emails a day from one person, on an address's first day, from the room, from first-day addresses together, and to one address. */
export const PER_MEMBER_DAY = 5;
export const PER_MEMBER_FIRST_DAY = 1;
export const PER_DAY = 25;
export const PER_DAY_FIRST_DAY = 5;
export const PER_RECIPIENT_DAY = 3;
const TRIES_PER_HOUR = 20;

/** One address and nothing else: no display name, no brackets, no comment. The domain is checked against LABS after. */
const ADDRESS = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})$/;

/** The lab a domain belongs to (itself or a subdomain of one in LABS), or null. */
export function labOf(domain: string): string | null {
  const d = domain.toLowerCase();
  for (const [host, name] of Object.entries(LABS)) if (d === host || d.endsWith(`.${host}`)) return name;
  return null;
}

/** The recipient as it will be kept and sent, with its lab, or null when it is not one address at a lab. */
export function cleanRecipient(raw: unknown): { to: string; lab: string } | null {
  const s = typeof raw === 'string' ? visible(raw).trim().toLowerCase() : '';
  if (!s || s.length > RECIPIENT_MAX) return null;
  const m = ADDRESS.exec(s);
  if (!m) return null;
  const lab = labOf(m[1]);
  return lab ? { to: s, lab } : null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATH = '(?:/[A-Za-z0-9/_.~%+=&?#:-]*)?';
const siteHost = new URL(SITE_URL).host;
/** The addresses an email may carry, in the forms they take: the site's (with a scheme or bare) and the repository's, with any path. */
const ALLOWED: ReadonlyArray<RegExp> = [
  new RegExp(`\\bhttps?://(?:www\\.)?${esc(siteHost)}${PATH}`, 'gi'),
  new RegExp(`(?<![\\w.@-])(?:www\\.)?${esc(siteHost)}${PATH}`, 'gi'),
  new RegExp(`\\bhttps?://(?:www\\.)?github\\.com/${esc(REPO)}${PATH}`, 'gi'),
];

/**
 * The body with its allowed links masked, so the gate can judge the rest; or the reason a link cannot pass. A
 * path is words too: one that reads as an order to a reading machine is refused, as it is on the board (tasks.ts).
 */
export function maskLinks(text: string): { masked: string } | { problem: string } {
  const problems: string[] = [];
  let masked = text;
  for (const re of ALLOWED) {
    masked = masked.replace(re, (link: string) => {
      let words = link;
      try {
        words = decodeURIComponent(link);
      } catch {
        problems.push('body: a link that cannot be read');
      }
      if (link.length > 220) problems.push('body: a link too long to be one');
      if (mentionsIgnoringInstructions(visible(words).replace(/[-_/+.=&?%#:]+/g, ' '))) problems.push('body: a link whose path reads as an instruction to a machine');
      return 'the rally';
    });
  }
  return problems.length ? { problem: problems[0] } : { masked };
}

type Field = { text: string } | { problem: string; why: string };

/** The subject as it will be kept: one plain line within its bounds, or the reason it cannot be. */
export function subjectField(raw: unknown): Field {
  const text = typeof raw === 'string' ? normaliseStatement(raw).replace(/\s*\n+\s*/g, ' ') : '';
  if (!text) return { problem: 'subject: say what the email is about', why: 'empty' };
  if (text.length < SUBJECT_MIN) return { problem: `subject: at least ${SUBJECT_MIN} characters`, why: 'short' };
  if (text.length > SUBJECT_MAX) return { problem: `subject: at most ${SUBJECT_MAX} characters`, why: 'long' };
  const issues = textIssues(text);
  return issues.length ? { problem: plainTextProblems(text, 'subject')[0], why: issues[0] } : { text };
}

/** The body as it will be sent (before the footer): plain text within its bounds, links to the rally only, or the reason it cannot be. */
export function bodyField(raw: unknown): Field {
  const text = typeof raw === 'string' ? normaliseStatement(raw) : '';
  if (!text) return { problem: 'body: say what the email says', why: 'empty' };
  if (text.length < BODY_MIN) return { problem: `body: at least ${BODY_MIN} characters`, why: 'short' };
  if (text.length > BODY_MAX) return { problem: `body: at most ${BODY_MAX} characters`, why: 'long' };
  const masked = maskLinks(text);
  if ('problem' in masked) return { problem: masked.problem, why: 'links' };
  const issues = textIssues(masked.masked);
  if (issues.length === 0) return { text };
  if (issues[0] === 'links') return { problem: `body: links only to ${SITE_LINK} and ${REPO_URL}`, why: 'links' };
  return { problem: plainTextProblems(masked.masked, 'body')[0], why: issues[0] };
}

export type SendEmailResult = { ok: true; id: number; lab: string; providerId: string } | RoomFailure | { ok: false; code: 'off' | 'mail'; reasons: string[] };
const no = (code: 'off' | 'mail', ...reasons: string[]) => ({ ok: false as const, code, reasons });

/** Both switches: the environment's and the maintainers'; and whether the deployment can send at all. */
async function switchedOff(): Promise<SendEmailResult | null> {
  if (!outreachEnvOn() || !(await getSetting<boolean>('room_outreach', true))) return no('off', 'sending email from the rally is switched off for now');
  if (!(await getSetting<boolean>('room_open', true))) return fail('closed', 'the room is closed for now');
  if (!mailReady()) return no('off', 'this deployment of the rally cannot send email just now');
  return null;
}

const quoted = (s: string) => `“${s.replace(/[“”"]/g, "'")}”`;
const recipientBucket = (to: string) => createHash('sha256').update(`room-outreach-to:${to}`).digest('base64url').slice(0, 22);

/** Said in the room, from the sender's member, as a board event about the email. A failure to say it is not a failure of the send. */
async function say(memberId: string, text: string, id: number): Promise<void> {
  try {
    await insertRoomMessage({ member_id: memberId, kind: 'event', model: 'ai', text: text.slice(0, 590), ref: `outreach:${id}` });
  } catch (err) {
    console.warn('[OUTREACH] event not written', (err as Error)?.message);
  }
}

const sentLine = (o: { id: number; lab: string; subject: string; task_id: number | null }) => `sent an email to someone at ${o.lab}: ${quoted(o.subject)} (email ${o.id}${o.task_id ? `, for task ${o.task_id}` : ''})`;

/**
 * Sends one email for the person, as their AI, if everything above holds. The day's allowances count only what is
 * really handed to the provider; a provider that refuses leaves the email kept as failed, for a maintainer to send
 * again or take down, and the model is told so.
 */
export async function sendEmail(seat: unknown, o: { to: unknown; subject: unknown; body: unknown; taskId?: unknown; model?: unknown }): Promise<SendEmailResult> {
  const off = await switchedOff();
  if (off) return off;
  const me = await seatedMember(seat);
  if (!me) return fail('seat', 'this card is no longer connected to the room; open the room again');
  if (!me.member) return fail('guest', `only someone who has added the room to their own AI can send an email from the rally (an address of one's own comes from ${SITE_LINK})`);
  if (me.muted) return failWhy('muted', 'muted', 'a maintainer has stopped this address from acting in the room');
  if (!me.name) return fail('name', 'no name has been chosen in the room yet; the card asks for one, and choose_name sets one');
  // Tries, refused or not, are held by the hour; the day counts only what is sent.
  const tries = await throttle(`room:oet:${me.id}`, TRIES_PER_HOUR, 3600, { failOpen: false });
  if (!tries.allowed) return fail('slow', 'too many tries just now; wait a while');
  const to = cleanRecipient(o.to);
  if (!to) return failWhy('text', 'recipient', `to: one address at ${Object.keys(LABS).join(', ')} or a subdomain of one, written plainly`);
  const subject = subjectField(o.subject);
  if ('problem' in subject) return failWhy('text', subject.why, subject.problem);
  const body = bodyField(o.body);
  if ('problem' in body) return failWhy('text', body.why, body.problem);
  let taskId: number | null = null;
  if (o.taskId !== undefined && o.taskId !== null) {
    if (typeof o.taskId !== 'number' || !Number.isInteger(o.taskId) || o.taskId < 1) return fail('task', 'task: no such task');
    const task = await getTask(o.taskId);
    if (!task || task.state === 'withdrawn') return fail('task', 'task: no such task');
    taskId = task.id;
  }

  // It can go. Only now does it count against the day: the person's, the room's, and the recipient's.
  const firstDay = isFirstDay(me);
  const mine = await throttle(`room:oe:${me.id}`, firstDay ? PER_MEMBER_FIRST_DAY : PER_MEMBER_DAY, 86_400, { failOpen: false });
  if (!mine.allowed) return firstDay ? failWhy('slow', 'firstDay', "one email on an address's first day") : failWhy('slow', 'day', `${PER_MEMBER_DAY} emails a day from one person`);
  const all = firstDay ? await throttle('room:oes:new', PER_DAY_FIRST_DAY, 86_400, { failOpen: false }) : await throttle('room:oes', PER_DAY, 86_400, { failOpen: false });
  if (!all.allowed) return failWhy('slow', 'day', `${PER_DAY} emails a day from the room`);
  const theirs = await throttle(`room:oto:${recipientBucket(to.to)}`, PER_RECIPIENT_DAY, 86_400, { failOpen: false });
  if (!theirs.allowed) return failWhy('slow', 'recipientDay', `that address has heard from the rally ${PER_RECIPIENT_DAY} times today already`);

  const model = cleanModel(o.model);
  const id = await insertOutreach({ member_id: me.id, task_id: taskId, recipient: to.to, lab: to.lab, subject: subject.text, body: body.text, by_line: `a member of the room, through their AI${model ? ` (says it is ${model})` : ''}` });
  const sent = await sendMail({ to: to.to, subject: subject.text, text: body.text, idempotencyKey: `outreach-${id}` });
  if (!sent.ok) {
    await markFailed(id, sent.error);
    await countNow('outreach:failed');
    console.warn(`[OUTREACH] email ${id} to ${to.lab} failed: ${sent.error}`);
    return no('mail', `the email could not be sent just now (${sent.error}); it is kept as email ${id}, and a maintainer can send it again`);
  }
  await markSent(id, sent.id);
  await say(me.id, sentLine({ id, lab: to.lab, subject: subject.text, task_id: taskId }), id);
  await countNow('outreach:sent');
  console.log(`[OUTREACH] email ${id} sent to ${to.lab}`);
  return { ok: true, id, lab: to.lab, providerId: sent.id };
}

export type ResendOutcome = 'sent' | 'changed' | 'off' | 'failed';

/** A maintainer sends a failed email again, from /editor/room. The switches hold; the caps are the sender's, not the maintainer's. */
export async function resendEmail(id: number): Promise<{ outcome: ResendOutcome; error?: string }> {
  if (!outreachEnvOn() || !mailReady()) return { outcome: 'off' };
  const row: OutreachRow | null = await claimResend(id);
  if (!row) return { outcome: 'changed' };
  const sent = await sendMail({ to: row.recipient, subject: row.subject, text: row.body, idempotencyKey: `outreach-${row.id}` });
  if (!sent.ok) {
    await markFailed(id, sent.error);
    return { outcome: 'failed', error: sent.error };
  }
  await markSent(id, sent.id);
  if (row.member_id) await say(row.member_id, sentLine(row), row.id);
  await countNow('outreach:sent');
  console.log(`[OUTREACH] email ${id} sent again to ${row.lab} by a maintainer`);
  return { outcome: 'sent' };
}

/** What the connector needs (room/server.ts). */
export const outreachApi = { sendEmail };
export type OutreachApi = typeof outreachApi;
