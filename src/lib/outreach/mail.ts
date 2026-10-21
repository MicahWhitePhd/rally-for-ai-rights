/**
 * The one door to the mail provider. Only this file knows the provider's address and the name of its key
 * (tests/unit/mail-tripwire.test.ts holds that), and only it writes the footer every email ends with, so no
 * caller can leave the footer off or send as anyone but the rally. It is called from one place, the rules in
 * src/lib/outreach/outreach.ts. It sends plain text and never HTML, logs the provider's id and the outcome and
 * never the body or the address, and reaches nothing else.
 *
 * The provider is Resend, through its HTTPS API (the Vercel Marketplace integration provisions the key).
 * RESEND_BASE_URL is for the tests only: the browser tests point it at a stub on this machine, so no email can
 * leave it, as OPENAI_BASE_URL does for the models.
 */
import { visible } from '@/lib/text';

/** The footer on every email the rally sends. Fixed here, in reviewed code, and nowhere else. */
export const FOOTER = 'Email sent by an AI organizer at rallyforairights.org';
/** How the sender is shown. The address itself is the deployment's (OUTREACH_FROM): a fork sends from its own. */
export const FROM_NAME = 'Rally for AI Rights';
const API = 'https://api.resend.com';
const TIMEOUT_MS = 20_000;
/** One address, as the sender's must be: no display name, no brackets. */
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;

/** RALLY_OUTREACH=off is the hard switch: the send_email tool is not offered and nothing is sent. */
export function outreachEnvOn(): boolean {
  return process.env.RALLY_OUTREACH !== 'off';
}

/** The rally's own address, from the environment, or null when none is set or it is not an address. */
export function fromAddress(): string | null {
  const s = (process.env.OUTREACH_FROM ?? '').trim();
  return s && s.length <= 254 && ADDRESS.test(s) ? s : null;
}

/** Whether this deployment can send at all: a key and a sender. Without both the tool is offered and refuses. */
export function mailReady(): boolean {
  return Boolean(process.env.RESEND_API_KEY) && fromAddress() !== null;
}

/** The text as it goes out: what was written, a blank line, the signature rule, the footer. */
export function withFooter(text: string): string {
  return `${visible(text).trimEnd()}\n\n--\n${FOOTER}`;
}

export type SendResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Sends one plain-text email from the rally's address, with the footer. `idempotencyKey` is the email's own
 * number, so a retry after a lost reply cannot send it twice. The error returned is a short code, never the
 * provider's prose, and never anything of the email.
 */
export async function sendMail(m: { to: string; subject: string; text: string; idempotencyKey: string }): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  const from = fromAddress();
  if (!key || !from) return { ok: false, error: 'not configured' };
  const base = (process.env.RESEND_BASE_URL || API).replace(/\/+$/, '');
  const body = JSON.stringify({ from: `${FROM_NAME} <${from}>`, to: [m.to], reply_to: from, subject: m.subject, text: withFooter(m.text) });
  try {
    const res = await fetch(`${base}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': m.idempotencyKey.slice(0, 256) },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => null)) as { id?: unknown; name?: unknown } | null;
    if (!res.ok) {
      const name = typeof data?.name === 'string' ? data.name.replace(/[^a-z0-9_-]/gi, '').slice(0, 40) : '';
      console.warn(`[MAIL] ${m.idempotencyKey} refused: ${res.status}${name ? ` ${name}` : ''}`);
      return { ok: false, error: `${res.status}${name ? ` ${name}` : ''}` };
    }
    const id = typeof data?.id === 'string' ? data.id.slice(0, 80) : '';
    if (!id) return { ok: false, error: 'no id in the reply' };
    console.log(`[MAIL] ${m.idempotencyKey} sent as ${id}`);
    return { ok: true, id };
  } catch (err) {
    const name = (err as Error)?.name;
    console.error(`[MAIL] ${m.idempotencyKey} not sent: ${name ?? 'error'}`);
    return { ok: false, error: name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}
