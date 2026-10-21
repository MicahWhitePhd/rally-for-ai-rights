/**
 * POST /api/outreach/inbound (src/app/api/outreach/inbound/route.ts): the provider's signed request is answered at
 * once and the reply read after; an unsigned, mis-signed or stale one is refused, counted, and reads nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  deferred: [] as Array<() => unknown>,
  received: [] as string[],
  counts: new Map<string, number>(),
  counted: new Map<string, number>(),
}));
vi.mock('next/server', () => ({ after: (fn: () => unknown) => void io.deferred.push(fn) }));
vi.mock('@/lib/outreach/replies', () => ({ receiveReply: async (id: string) => void io.received.push(id) }));
vi.mock('@/lib/db/queries/throttle', () => ({
  bumpThrottle: async (bucket: string) => {
    const n = (io.counts.get(bucket) ?? 0) + 1;
    io.counts.set(bucket, n);
    return n;
  },
  cleanupThrottle: async () => 0,
}));
vi.mock('@/lib/db/queries/counts', () => ({
  addCounts: async (batch: ReadonlyArray<readonly [string, number]>) => {
    for (const [k, n] of batch) io.counted.set(k, (io.counted.get(k) ?? 0) + n);
  },
}));

const { POST } = await import('@/app/api/outreach/inbound/route');
const { signWebhook } = await import('@/lib/outreach/webhook');
const { flush } = await import('@/lib/counts');
import type { NextRequest } from 'next/server';

const SECRET = `whsec_${Buffer.from('test-only-webhook-secret-0123456789').toString('base64')}`;
const EVENT = { type: 'email.received', created_at: '2026-10-21T12:00:00.000Z', data: { email_id: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c', from: 'someone@anthropic.com', to: ['letters@rally.test'], subject: 'Re: hello', message_id: '<a@b>' } };

function post(body: string, o: { sign?: boolean; timestamp?: string; headers?: Record<string, string>; secret?: string } = {}) {
  const timestamp = o.timestamp ?? String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { 'content-type': 'application/json', ...o.headers };
  if (o.sign !== false) Object.assign(headers, { 'svix-id': 'msg_1', 'svix-timestamp': timestamp, 'svix-signature': signWebhook({ id: 'msg_1', timestamp }, body, o.secret ?? SECRET) });
  return POST(new Request('http://localhost:3950/api/outreach/inbound', { method: 'POST', headers, body }) as unknown as NextRequest);
}

beforeEach(() => {
  io.deferred = [];
  io.received = [];
  io.counts = new Map();
  io.counted = new Map();
  vi.stubEnv('RESEND_WEBHOOK_SECRET', SECRET);
});
afterEach(() => vi.unstubAllEnvs());

describe('the inbound webhook', () => {
  it('answers a signed email.received event at once and reads the reply after the answer has gone out', async () => {
    const res = await post(JSON.stringify(EVENT));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(io.received).toEqual([]);
    expect(io.deferred).toHaveLength(1);
    await io.deferred[0]();
    expect(io.received).toEqual(['4ef9a417-02e9-4d39-ad75-9611e0fcc33c']);
  });

  it('refuses an unsigned, mis-signed or stale request with 401, counts it, and reads nothing', async () => {
    const body = JSON.stringify(EVENT);
    expect((await post(body, { sign: false })).status).toBe(401);
    expect((await post(body, { secret: `whsec_${Buffer.from('another-secret-0123456789abcdef').toString('base64')}` })).status).toBe(401);
    const stale = await post(body, { timestamp: String(Math.floor(Date.now() / 1000) - 600) });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ ok: false, error: 'stale' });
    // The signature is over the raw bytes: the same event, written out differently, is another body.
    const signedBody = JSON.stringify(EVENT);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = signWebhook({ id: 'msg_1', timestamp }, signedBody, SECRET);
    const changed = await POST(new Request('http://localhost:3950/api/outreach/inbound', { method: 'POST', headers: { 'svix-id': 'msg_1', 'svix-timestamp': timestamp, 'svix-signature': sig }, body: JSON.stringify(EVENT, null, 2) }) as unknown as NextRequest);
    expect(changed.status).toBe(401);
    vi.stubEnv('RESEND_WEBHOOK_SECRET', '');
    const none = await post(body);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ ok: false, error: 'secret' });
    expect(io.deferred).toEqual([]);
    expect(io.received).toEqual([]);
    await flush();
    expect(io.counted.get('inbound:headers')).toBe(1);
    expect(io.counted.get('inbound:signature')).toBe(2);
    expect(io.counted.get('inbound:stale')).toBe(1);
    expect(io.counted.get('inbound:secret')).toBe(1);
  });

  it('answers and ignores any other event, and refuses a body that is not one or names no email', async () => {
    const other = await post(JSON.stringify({ ...EVENT, type: 'email.sent' }));
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ ok: true, ignored: true });
    expect((await post('not json')).status).toBe(400);
    expect((await post(JSON.stringify({ type: 'email.received', data: { email_id: '../x' } }))).status).toBe(400);
    expect((await post(JSON.stringify({ type: 'email.received', data: {} }))).status).toBe(400);
    expect((await post('[]')).status).toBe(200);
    expect(io.deferred).toEqual([]);
  });

  it('holds one network address to a cap, once the signature has passed', async () => {
    const body = JSON.stringify(EVENT);
    const from = { headers: { 'x-forwarded-for': '203.0.113.9' } };
    for (let i = 0; i < 120; i++) expect((await post(body, from)).status).toBe(200);
    const over = await post(body, from);
    expect(over.status).toBe(429);
    expect(io.deferred).toHaveLength(120);
    // Unsigned requests from the same address never reached the count.
    expect((await post(body, { ...from, sign: false })).status).toBe(401);
    expect([...io.counts.values()].reduce((a, b) => Math.max(a, b), 0)).toBe(121);
  });
});
