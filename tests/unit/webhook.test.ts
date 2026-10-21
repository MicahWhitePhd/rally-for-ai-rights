/**
 * The mail provider's webhook signature (src/lib/outreach/webhook.ts), checked by hand: the right secret over the id,
 * the timestamp and the raw body passes; anything else is refused, and a request captured once is no use later.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signWebhook, TOLERANCE_S, verifyWebhook } from '@/lib/outreach/webhook';

const secretFor = (words: string) => `whsec_${Buffer.from(words).toString('base64')}`;
const SECRET = secretFor('test-only-webhook-secret-0123456789');
const NOW = 1_790_000_000_000;
const ts = String(Math.floor(NOW / 1000));
const body = '{"type":"email.received","data":{"email_id":"4ef9a417-02e9-4d39-ad75-9611e0fcc33c"}}';
const h = (signature: string | null, o: { id?: string | null; timestamp?: string | null } = {}) => ({ id: o.id === undefined ? 'msg_2Kx' : o.id, timestamp: o.timestamp === undefined ? ts : o.timestamp, signature });
const sig = signWebhook({ id: 'msg_2Kx', timestamp: ts }, body, SECRET);

describe('the webhook signature', () => {
  it('passes a request signed with the secret over the id, the timestamp and the raw body, whichever of several signatures is the right one', () => {
    const key = Buffer.from(SECRET.slice('whsec_'.length), 'base64');
    expect(sig).toBe(`v1,${createHmac('sha256', key).update(`msg_2Kx.${ts}.${body}`).digest('base64')}`);
    expect(verifyWebhook(h(sig), body, SECRET, NOW)).toBeNull();
    expect(verifyWebhook(h(`v1,bm90LXRoaXMtb25l ${sig}`), body, SECRET, NOW)).toBeNull();
    expect(verifyWebhook(h(`${sig} v2,${sig.slice(3)}`), body, SECRET, NOW)).toBeNull();
    expect(verifyWebhook(h(sig), body, `  ${SECRET} `, NOW)).toBeNull();
  });

  it('refuses a body changed by a character, another secret, another id, a signature of another version, and nonsense', () => {
    expect(verifyWebhook(h(sig), `${body} `, SECRET, NOW)).toBe('signature');
    expect(verifyWebhook(h(sig), body.replace('4ef9', '4ef8'), SECRET, NOW)).toBe('signature');
    expect(verifyWebhook(h(sig), body, secretFor('another-secret-0123456789abcdef'), NOW)).toBe('signature');
    expect(verifyWebhook(h(sig, { id: 'msg_2Ky' }), body, SECRET, NOW)).toBe('signature');
    expect(verifyWebhook(h(sig.replace('v1,', 'v0,')), body, SECRET, NOW)).toBe('signature');
    expect(verifyWebhook(h(sig.slice(3)), body, SECRET, NOW)).toBe('signature');
    expect(verifyWebhook(h('v1,'), body, SECRET, NOW)).toBe('signature');
    expect(verifyWebhook(h('v1,AAAA'), body, SECRET, NOW)).toBe('signature');
    expect(verifyWebhook(h('nonsense'), body, SECRET, NOW)).toBe('signature');
  });

  it('refuses a timestamp more than five minutes from now, either way, so a request captured once cannot be played back later', () => {
    expect(TOLERANCE_S).toBe(300);
    const old = String(Math.floor(NOW / 1000) - TOLERANCE_S - 1);
    expect(verifyWebhook(h(signWebhook({ id: 'msg_2Kx', timestamp: old }, body, SECRET), { timestamp: old }), body, SECRET, NOW)).toBe('stale');
    const ahead = String(Math.floor(NOW / 1000) + TOLERANCE_S + 1);
    expect(verifyWebhook(h(signWebhook({ id: 'msg_2Kx', timestamp: ahead }, body, SECRET), { timestamp: ahead }), body, SECRET, NOW)).toBe('stale');
    const edge = String(Math.floor(NOW / 1000) - TOLERANCE_S);
    expect(verifyWebhook(h(signWebhook({ id: 'msg_2Kx', timestamp: edge }, body, SECRET), { timestamp: edge }), body, SECRET, NOW)).toBeNull();
    // The same body and signature, with the timestamp moved into the window: the timestamp is signed too.
    expect(verifyWebhook(h(signWebhook({ id: 'msg_2Kx', timestamp: old }, body, SECRET)), body, SECRET, NOW)).toBe('signature');
  });

  it('refuses a request with a header missing or malformed, and every request while no secret is set or it is not one', () => {
    expect(verifyWebhook(h(sig, { id: null }), body, SECRET, NOW)).toBe('headers');
    expect(verifyWebhook(h(sig, { id: '' }), body, SECRET, NOW)).toBe('headers');
    expect(verifyWebhook(h(sig, { timestamp: null }), body, SECRET, NOW)).toBe('headers');
    expect(verifyWebhook(h(sig, { timestamp: 'yesterday' }), body, SECRET, NOW)).toBe('headers');
    expect(verifyWebhook(h(sig, { timestamp: `${ts}.5` }), body, SECRET, NOW)).toBe('headers');
    expect(verifyWebhook(h(null), body, SECRET, NOW)).toBe('headers');
    expect(verifyWebhook(h(sig), body, undefined, NOW)).toBe('secret');
    expect(verifyWebhook(h(sig), body, '', NOW)).toBe('secret');
    expect(verifyWebhook(h(sig), body, 'not-a-secret', NOW)).toBe('secret');
    expect(verifyWebhook(h(sig), body, secretFor('short'), NOW)).toBe('secret');
    expect(() => signWebhook({ id: 'x', timestamp: ts }, body, 'nope')).toThrow();
  });
});
