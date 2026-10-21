/**
 * A reply from a lab to an email the rally sent, said in the room under the lab's name.
 *
 * The provider's webhook names an email that came back to the rally's mailbox (src/app/api/outreach/inbound); it is
 * read through the mail door (mail.ts), kept whole in room_outreach_replies, matched to the email it answers (the sent
 * email's provider id in its In-Reply-To or References headers, else the newest email sent to the address it came
 * from), and said in the room as one line from the lab's own member: the room's words around the lab's, quoted,
 * cleaned as a person's line is held to be. What a reader cannot see is taken out; the mail it quotes back and the
 * signature are dropped; addresses, phone numbers, handles and links are replaced by "[removed]"; the rest is cut to
 * the room's length at the end of a sentence. The room hears the lab and the subject of the email answered, never the
 * person's name or address. A reply that, cleaned, still reads as an instruction to a machine (or still carries a
 * link or a contact) is held for the maintainers, and the room is told only that one came. A reply that answers no
 * email the rally sent, or comes from no lab, or arrives while the door is shut, is held and said nowhere. The
 * maintainers read every reply in full at /editor/room, take a line down, and post a held one after reading it.
 *
 * No HTTP in here: the route and the editor's actions are thin wrappers over this.
 */
import { countNow } from '@/lib/counts';
import { scanInjection } from '@/lib/filters';
import { ensureLabMember, getReply, insertReply, latestSentTo, noteHeldReply, postReplyLine, sentByProviderIds, setReplyHeldWhy, setReplyLine, type SentEmail } from '@/lib/db/queries/replies';
import { getSettingNow } from '@/lib/db/queries/settings';
import { TEXT_MAX } from '@/lib/room/room';
import { textIssues, visible } from '@/lib/text';
import { FOOTER, outreachEnvOn, receivedMail, type ReceivedMail } from './mail';
import { labOf } from './outreach';

/** The lab's words are quoted in the room's line; what is replaced in them is said so. */
export const REMOVED = '[removed]';

/** One address out of what a From header carries ("Name <a@b.c>", or "a@b.c"), lower case; null when there is none. */
export function addressOf(raw: string): string | null {
  const m = /<\s*([^<>\s]+@[^<>\s]+)\s*>|([^\s<>",;]+@[^\s<>",;]+)/.exec(visible(raw));
  const a = (m?.[1] ?? m?.[2] ?? '').toLowerCase().replace(/[.,;]+$/, '');
  return /^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9.-]{3,253}$/.test(a) ? a : null;
}

/** The lab an address belongs to, by its domain, or null. */
export function labOfAddress(address: string): string | null {
  const at = address.lastIndexOf('@');
  return at > 0 ? labOf(address.slice(at + 1)) : null;
}

/**
 * The ids a reply's threading headers may carry: of each message id, the part before the @ (a provider that builds the
 * Message-ID from its own id puts it there), at most twenty, each shaped like an id.
 */
export function providerIdsIn(...headers: string[]): string[] {
  const out = new Set<string>();
  for (const h of headers) {
    for (const token of h.split(/[\s,]+/)) {
      const c = token.replace(/^<|>$/g, '').split('@')[0];
      if (/^[A-Za-z0-9_-]{8,80}$/.test(c)) out.add(c);
      if (out.size >= 20) return [...out];
    }
  }
  return [...out];
}

/** Where the reply stops being the reply and starts quoting the mail it answers: dropped from there on. */
const QUOTED_FROM: RegExp[] = [
  /^On .{0,300}wrote:\s*$/,
  /^-{2,}\s*(?:Original|Forwarded) Message\s*-{2,}\s*$/i,
  /^_{8,}\s*$/,
  /^From:\s.+$/,
  /^Le .{0,200} a écrit\s*:\s*$/,
  /^Am .{0,200} schrieb .{0,80}:\s*$/,
];
/** The rally's own footer, quoted back, is the sent email, not the reply. */
const RALLY_FOOTER = new RegExp(FOOTER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
/** Where the signature starts: the signature rule, or a phone's note. */
const SIGNATURE_FROM: RegExp[] = [/^--\s*$/, /^Sent from my \w+/i, /^Get Outlook for /i];

/** The reply's own words: the lines before any quoted mail or signature, with lines that quote dropped. */
export function ownWords(text: string): string {
  const lines = visible(text).replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('>')) continue;
    // "On Mon, 3 Nov 2026 at 10:00, Someone" on one line and "wrote:" on the next: two lines read as one.
    const two = `${line} ${(lines[i + 1] ?? '').trim()}`;
    if (QUOTED_FROM.some((re) => re.test(line) || re.test(two)) || RALLY_FOOTER.test(line)) break;
    if (SIGNATURE_FROM.some((re) => re.test(line))) break;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/**
 * Contact details and links, in the forms the gate (src/lib/text.ts) refuses, each replaced by one mark. Each match
 * stops before the punctuation that ends a sentence, so "write to jane@example.org." keeps its full stop.
 */
const TRAIL = '(?=[.,;:!?)\\]]*(?:\\s|$))';
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]*\w/g;
const URL_LIKE = new RegExp(`https?:\\/\\/\\S+?${TRAIL}|www\\.\\S+?${TRAIL}|\\b[a-z0-9-]+\\.[a-z]{2,24}\\/\\S*?${TRAIL}`, 'gi');
const DOMAIN = /\b[a-z0-9-]+\.(com|org|net|io|ai|dev|xyz|gov|edu|app|me|ly|co|gg|to|sh|link|info|biz|page|site|online|uk|de|fr|ru|cn|us)\b/gi;
const PHONE = /\+?\d(?:[\s().-]{0,2}\d){8,}/g;
const HANDLE = /(^|[^\w])@[\w.]*\w/g;
const MARKUP = /<\/?[a-z][^>]*>|\]\(|\]\[/gi;
/** Several marks in a row, with only a separator between them (a signature's "address · phone · handle"), are one. */
const MARKS = /\[removed\](?:\s*[·•|,;:/\-–—]?\s*\[removed\])+/g;

export function removeContacts(text: string): string {
  return text
    .replace(MARKUP, ' ')
    .replace(URL_LIKE, REMOVED)
    .replace(EMAIL, REMOVED)
    // "Yes.To be honest" is a missing space, not an address, as the gate reads it.
    .replace(DOMAIN, (m, tld: string) => (/^[A-Z][a-z]+$/.test(tld) ? m : REMOVED))
    .replace(PHONE, (m) => ((m.match(/\d+/g) ?? []).every((g) => /^(?:19|20)\d{2}$/.test(g)) ? m : REMOVED))
    .replace(HANDLE, `$1${REMOVED}`);
}

/** Shouting brought down: a reply in capitals is read, not refused. */
function unshout(text: string): string {
  return /[A-Z]{12,}/.test(text.replace(/\s/g, '')) ? text.replace(/\b[A-Z]{2,}\b/g, (w) => w[0] + w.slice(1).toLowerCase()) : text;
}

/** The reply as the room may hear it, whole: its own words, cleaned, on one line. Empty when nothing is left. */
export function cleanReply(raw: string): string {
  return unshout(removeContacts(ownWords(raw))).replace(MARKS, REMOVED).replace(/\s+/g, ' ').trim();
}

/** The first `max` characters, cut at the end of a sentence when one falls in the last three fifths, else at a word with a mark. */
export function fitSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  let end = -1;
  for (const m of head.matchAll(/[.!?](?:[”’"')\]])?(?=\s|$)/g)) end = m.index + m[0].length;
  if (end >= max * 0.4) return head.slice(0, end).trimEnd();
  const space = head.lastIndexOf(' ', max - 1);
  return `${head.slice(0, space > max * 0.4 ? space : max - 1).trimEnd()}…`;
}

const quoted = (s: string) => `“${s.replace(/\s+/g, ' ').replace(/[“”"]/g, "'")}”`;

/** The line the room hears, from the lab's member: the room's words around the lab's, within the room's length. */
export function replyLine(o: { emailId: number; subject: string; lab: string; text: string }): string {
  const lead = `In reply to email ${o.emailId} (${quoted(o.subject)}), someone at ${o.lab} wrote: `;
  const room = Math.max(40, TEXT_MAX - lead.length - 2);
  return `${lead}${quoted(fitSentence(o.text, room))}`;
}

/** What the room hears when a reply is held: an event from the lab's member, in the room's words ("Anthropic replied to email 3 ..."). */
export function heldLine(o: { emailId: number; subject: string }): string {
  return `replied to email ${o.emailId} (${quoted(o.subject)}); the reply is held for the maintainers to read`;
}

/** Why the cleaned words cannot be said in the room, in a few words, or null when they can. */
export function whyNotSayable(cleaned: string): string | null {
  if (!cleaned) return 'no plain text';
  const issues = textIssues(cleaned);
  if (issues.includes('machines') || scanInjection(cleaned, { prose: true })) return 'reads as addressed to a machine';
  if (issues.includes('links')) return 'a link remains';
  if (issues.includes('contact')) return 'a contact detail remains';
  if (issues.includes('shouting')) return 'shouting';
  return null;
}

/** The email a reply answers: by the ids its headers carry, else by the address it came from. */
export async function matchSent(mail: { from: string; inReplyTo: string; references: string }): Promise<SentEmail | null> {
  const byId = await sentByProviderIds(providerIdsIn(mail.inReplyTo, mail.references));
  if (byId) return byId;
  const from = addressOf(mail.from);
  return from ? latestSentTo(from) : null;
}

/**
 * Both switches, and the room's: a reply that comes while any is off is kept and held. Read from the table, not the
 * snapshot every other path reads (src/lib/db/queries/settings.ts): a reply is rare, and a maintainer who has just
 * shut the door from the editor, which runs in another bundle with a snapshot of its own, means the next reply too.
 */
async function doorShut(): Promise<string | null> {
  if (!outreachEnvOn() || !(await getSettingNow<boolean>('room_outreach', true))) return 'the door is shut';
  if (!(await getSettingNow<boolean>('room_open', true))) return 'the room is closed';
  return null;
}

export type ReceiveOutcome = 'posted' | 'held' | 'seen' | 'unread';

/**
 * A reply the provider has: read it, keep it, and say it in the room if everything above holds. Called after the
 * webhook's answer has gone out, so it throws nothing and says what became of the reply in the log, by number only.
 */
export async function receiveReply(providerId: string): Promise<ReceiveOutcome> {
  try {
    const read = await receivedMail(providerId);
    if (!read.ok) {
      await countNow('reply:unread');
      console.warn(`[REPLY] received email not read: ${read.error}`);
      return 'unread';
    }
    return await keepAndSay(read.mail);
  } catch (err) {
    console.error('[REPLY] not kept', (err as Error)?.message);
    return 'unread';
  }
}

async function keepAndSay(mail: ReceivedMail): Promise<ReceiveOutcome> {
  const from = addressOf(mail.from);
  const lab = from ? labOfAddress(from) : null;
  const sent = await matchSent(mail);
  const cleaned = cleanReply(mail.text);
  const shut = await doorShut();
  // Why it is held, in the order a maintainer would want to know: nothing to post, nowhere to post it, the door, the words.
  const why = !sent ? 'no matching email' : !lab ? 'not from a lab' : shut ?? whyNotSayable(cleaned);
  const id = await insertReply({ outreach_id: sent?.id ?? null, from_address: from ?? (mail.from.slice(0, 254) || 'unknown'), subject: mail.subject, text: mail.text, provider_id: mail.id, received_at: mail.receivedAt, held_why: why });
  if (id === null) {
    console.log('[REPLY] kept already');
    return 'seen';
  }
  if (why) {
    await countNow('reply:held');
    console.log(`[REPLY] reply ${id} held: ${why}`);
    // The room is told that one came only when there is an email to point at and the words are what holds it.
    if (sent && lab && !shut) {
      const member = await ensureLabMember(lab);
      if (member) await noteHeldReply(id, { member_id: member, kind: 'event', text: heldLine({ emailId: sent.id, subject: sent.subject }) });
    }
    return 'held';
  }
  const member = await ensureLabMember(lab as string);
  if (!member) return hold(id, `the name ${lab} is taken in the room`);
  const line = await postReplyLine(id, { member_id: member, kind: 'person', text: replyLine({ emailId: (sent as SentEmail).id, subject: (sent as SentEmail).subject, lab: lab as string, text: cleaned }) });
  if (line === null) return hold(id, `${lab}'s member is stopped`);
  await countNow('reply:posted');
  console.log(`[REPLY] reply ${id} posted as line ${line} (${lab}, email ${(sent as SentEmail).id})`);
  return 'posted';
}

/** Kept held after all, with the reason on the row (it was inserted held; only the reason is set). */
async function hold(id: number, why: string): Promise<ReceiveOutcome> {
  await setReplyHeldWhy(id, why);
  await countNow('reply:held');
  console.log(`[REPLY] reply ${id} held: ${why}`);
  return 'held';
}

export type PostHeldOutcome = 'posted' | 'changed' | 'nowhere';

/**
 * A maintainer posts a held reply, having read it in full: its cleaned words, as the line the webhook would have
 * posted. What held it (words that read as an instruction, a link left) is theirs to judge; what the room never
 * hears (the address, the name, the quoted mail) is taken out all the same. 'nowhere' when it answers no email or
 * comes from no lab: there is no line to make.
 */
export async function postHeldReply(id: number): Promise<PostHeldOutcome> {
  const r = await getReply(id);
  if (!r || r.status !== 'held') return 'changed';
  const lab = r.lab ?? labOfAddress(r.from_address);
  if (!r.outreach_id || !lab || !r.email_subject) return 'nowhere';
  const cleaned = cleanReply(r.text);
  if (!cleaned) return 'nowhere';
  const member = await ensureLabMember(lab);
  if (!member) return 'nowhere';
  const line = await postReplyLine(id, { member_id: member, kind: 'person', text: replyLine({ emailId: r.outreach_id, subject: r.email_subject, lab, text: cleaned }) });
  if (line === null) return 'changed';
  await countNow('reply:posted');
  console.log(`[REPLY] reply ${id} posted as line ${line} by a maintainer`);
  return 'posted';
}

/** A maintainer takes a reply's line down, or puts it back. */
export async function setReplyPosted(id: number, posted: boolean): Promise<boolean> {
  return setReplyLine(id, posted ? 'posted' : 'withdrawn');
}
