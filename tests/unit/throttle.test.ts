/**
 * Rate limits (src/lib/throttle.ts): what is counted, and that a network
 * address is never what is kept, only a keyed hash of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ counts: new Map<string, number>(), fail: false, cleaned: [] as number[] }));
vi.mock('@/lib/db/queries/throttle', () => ({
  bumpThrottle: async (bucket: string) => {
    if (db.fail) throw new Error('db down');
    const n = (db.counts.get(bucket) ?? 0) + 1;
    db.counts.set(bucket, n);
    return n;
  },
  cleanupThrottle: async (olderThanSec: number) => {
    db.cleaned.push(olderThanSec);
    return 0;
  },
}));

const { addressBucket, addressKey, clientIp, isLocalAddress, throttle, throttleAddress } = await import('@/lib/throttle');

beforeEach(() => {
  db.counts = new Map();
  db.fail = false;
  vi.stubEnv('ROOM_SECRET', 'a-secret-of-thirty-two-characters!!');
});
afterEach(() => vi.unstubAllEnvs());

describe('a network address', () => {
  it('is one key per client: IPv4 as it is, IPv6 by its /64, a mapped address as the IPv4 it carries', () => {
    expect(addressKey('203.0.113.9')).toBe('203.0.113.9');
    expect(addressKey('203.0.113.9:4431')).toBe('203.0.113.9');
    expect(addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(addressKey('[2001:db8:1:2::7]:443')).toBe('2001:db8:1:2::/64');
    expect(addressKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(addressKey('::1')).toBe('::1');
    expect(addressKey('')).toBe('');
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }))).toBe('203.0.113.9');
    expect(isLocalAddress('')).toBe(true);
    expect(isLocalAddress('127.0.0.1')).toBe(true);
    expect(isLocalAddress('203.0.113.9')).toBe(false);
  });

  it('is kept only as a keyed hash: the same address gives the same bucket, and the bucket does not give the address', async () => {
    const a = addressBucket('203.0.113.9');
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(addressBucket('203.0.113.9')).toBe(a);
    expect(addressBucket('203.0.113.10')).not.toBe(a);
    vi.stubEnv('ROOM_SECRET', 'another-secret-of-thirty-two-chars!');
    expect(addressBucket('203.0.113.9')).not.toBe(a);
    vi.stubEnv('ROOM_SECRET', 'a-secret-of-thirty-two-characters!!');
    expect(await throttleAddress('rs', '203.0.113.9', { perHour: 2, perDay: 3 })).toEqual({ allowed: true });
    expect([...db.counts.keys()].sort()).toEqual([`rs:${a}`, `rsd:${a}`]);
    expect(JSON.stringify([...db.counts.keys()])).not.toContain('203.0.113');
  });

  it('is held to an hour and a day; a refusal by the hour does not count against the day; a local address is never counted', async () => {
    const limits = { perHour: 2, perDay: 3 };
    const a = addressBucket('203.0.113.9');
    expect((await throttleAddress('rs', '203.0.113.9', limits)).allowed).toBe(true);
    expect((await throttleAddress('rs', '203.0.113.9', limits)).allowed).toBe(true);
    expect(await throttleAddress('rs', '203.0.113.9', limits)).toEqual({ allowed: false, limit: 'hour' });
    expect(db.counts.get(`rsd:${a}`)).toBe(2);
    db.counts.set(`rs:${a}`, 0);
    expect((await throttleAddress('rs', '203.0.113.9', limits)).allowed).toBe(true);
    db.counts.set(`rs:${a}`, 0);
    expect(await throttleAddress('rs', '203.0.113.9', limits)).toEqual({ allowed: false, limit: 'day' });
    db.counts = new Map();
    for (const local of ['', '127.0.0.1', '::1']) expect(await throttleAddress('rs', local, { perHour: 0, perDay: 0 })).toEqual({ allowed: true });
    expect(db.counts.size).toBe(0);
  });

  it('old rows are cleared in passing, two days after their window', async () => {
    await throttleAddress('rs', '203.0.113.9', { perHour: 9, perDay: 9 });
    expect(db.cleaned.every((s) => s === 2 * 86_400)).toBe(true);
    expect(db.cleaned.length).toBeLessThanOrEqual(1);
  });
});

describe('when the database cannot be reached', () => {
  it('a limit lets it through by default, and refuses where it guards something that costs', async () => {
    db.fail = true;
    expect(await throttle('x', 1, 60)).toEqual({ allowed: true, n: 0 });
    expect(await throttle('x', 1, 60, { failOpen: false })).toEqual({ allowed: false, n: 0 });
    expect(await throttleAddress('rs', '203.0.113.9', { perHour: 9, perDay: 9 }, { failOpen: false })).toEqual({ allowed: false, limit: 'hour' });
  });
});
