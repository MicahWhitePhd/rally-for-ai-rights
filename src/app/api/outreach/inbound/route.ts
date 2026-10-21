/**
 * POST /api/outreach/inbound: the mail provider's webhook for an email that came back to the rally's mailbox (Resend,
 * event email.received). The provider signs each request (Svix's scheme), and the signature is checked by hand against
 * the secret the mail door holds (webhookSecret in mail.ts) before anything else is read: unsigned, mis-signed or stale,
 * the request is refused with 401, counted, and nothing is kept. The payload names the email and carries nothing of what it says; the
 * email itself is read through the mail door once the answer has gone out (after()), so the provider hears 200 at
 * once and does not send the same event again. Any other event is answered and ignored. One network address is held
 * to a cap, as at the other doors.
 */
import { after, type NextRequest } from 'next/server';
import { count } from '@/lib/counts';
import { PROVIDER_ID, webhookSecret } from '@/lib/outreach/mail';
import { receiveReply } from '@/lib/outreach/replies';
import { verifyWebhook } from '@/lib/outreach/webhook';
import { clientIp, throttleAddress } from '@/lib/throttle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** What the provider sends: the event's kind and, for a received email, its id. Nothing of what the email says. */
type InboundEvent = { type?: unknown; data?: { email_id?: unknown } };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: NextRequest): Promise<Response> {
  // The raw body, as sent: the signature is over these bytes, and a body parsed and written out again signs differently.
  const raw = await req.text();
  const problem = verifyWebhook({ id: req.headers.get('svix-id'), timestamp: req.headers.get('svix-timestamp'), signature: req.headers.get('svix-signature') }, raw, webhookSecret());
  if (problem) {
    count(`inbound:${problem}`);
    console.warn(`[REPLY] webhook refused: ${problem}`);
    return json({ ok: false, error: problem }, 401);
  }
  const gate = await throttleAddress('ri', clientIp(req.headers), { perHour: 120, perDay: 1000 }, { failOpen: false });
  if (!gate.allowed) {
    count('inbound:slow');
    return json({ ok: false, error: 'slow' }, 429);
  }
  let event: InboundEvent | null = null;
  try {
    event = JSON.parse(raw) as InboundEvent | null;
  } catch {
    return json({ ok: false, error: 'body' }, 400);
  }
  if (!event || typeof event !== 'object' || event.type !== 'email.received') return json({ ok: true, ignored: true });
  const id = typeof event.data?.email_id === 'string' ? event.data.email_id : '';
  if (!PROVIDER_ID.test(id)) return json({ ok: false, error: 'body' }, 400);
  // The provider has its answer; the reading, the keeping and the saying happen once it has gone out.
  try {
    after(() => receiveReply(id));
  } catch {
    // No request scope to hang it on (a test): read it now, and still answer.
    void receiveReply(id);
  }
  return json({ ok: true });
}
