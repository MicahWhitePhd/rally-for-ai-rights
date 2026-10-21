/**
 * The mail provider's webhook signature, checked by hand (the Svix scheme, which Resend uses; no library): the signed
 * content is `<svix-id>.<svix-timestamp>.<raw body>`, the key is the base64 after `whsec_` in the secret, the
 * signature is the HMAC-SHA256 of the content in base64, and the header may carry several, space-separated, each
 * `v1,<signature>`. A timestamp more than five minutes from now is stale, so a request captured once cannot be played
 * back later; a body changed by one character signs differently. Pure: the secret and the clock come in as arguments,
 * and nothing here reads the environment (the secret's name is the mail door's, mail.ts).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far from now a timestamp may be, in seconds. */
export const TOLERANCE_S = 300;
export type WebhookProblem = 'secret' | 'headers' | 'stale' | 'signature';

/** The key from a secret of the form `whsec_<base64>`, or null when it is not one. */
function keyOf(secret: string | undefined): Buffer | null {
  const s = (secret ?? '').trim();
  if (!s.startsWith('whsec_')) return null;
  const key = Buffer.from(s.slice('whsec_'.length), 'base64');
  return key.length >= 16 ? key : null;
}

/** The signature the provider would put on this request: for the tests, which play the provider. */
export function signWebhook(h: { id: string; timestamp: string }, rawBody: string, secret: string): string {
  const key = keyOf(secret);
  if (!key) throw new Error('not a webhook secret');
  return `v1,${createHmac('sha256', key).update(`${h.id}.${h.timestamp}.${rawBody}`).digest('base64')}`;
}

/** Null when the request is the provider's and fresh; else what is wrong with it, in a word. */
export function verifyWebhook(h: { id: string | null; timestamp: string | null; signature: string | null }, rawBody: string, secret: string | undefined, nowMs = Date.now()): WebhookProblem | null {
  const key = keyOf(secret);
  if (!key) return 'secret';
  if (!h.id || !h.timestamp || !h.signature || !/^\d{1,12}$/.test(h.timestamp)) return 'headers';
  if (Math.abs(nowMs / 1000 - Number(h.timestamp)) > TOLERANCE_S) return 'stale';
  const expected = createHmac('sha256', key).update(`${h.id}.${h.timestamp}.${rawBody}`).digest();
  for (const part of h.signature.split(' ')) {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) continue;
    const got = Buffer.from(sig, 'base64');
    if (got.length === expected.length && timingSafeEqual(got, expected)) return null;
  }
  return 'signature';
}
