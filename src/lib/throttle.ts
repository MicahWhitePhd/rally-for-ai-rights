import 'server-only';
import { createHmac } from 'node:crypto';
import { bumpThrottle, cleanupThrottle } from '@/lib/db/queries/throttle';

/**
 * Postgres-only rate limiting (no Redis). Fixed window keyed by `bucket`.
 *
 *   const { allowed } = await throttle(`e:${readerId}`, 30, 60);   // 30 per minute
 *
 * FAIL-OPEN by default: a DB hiccup must not take the site down; callers that
 * guard something expensive pass `{ failOpen: false }` and get `allowed: false`.
 * Bucket names are short and opaque (`room:p:<member>`, `rs:<address hash>`).
 *
 * The table is keyed (bucket, window start), and an hour window and a day
 * window both start at 00:00 UTC: never use one bucket name with two window
 * lengths, or the two counts share a row at midnight.
 */
export async function throttle(
  bucket: string,
  perWindow: number,
  windowSec: number,
  options: { failOpen?: boolean } = {},
): Promise<{ allowed: boolean; n: number }> {
  const failOpen = options.failOpen ?? true;
  try {
    const n = await bumpThrottle(bucket, windowSec);
    return { allowed: n <= perWindow, n };
  } catch (err) {
    console.warn('[THROTTLE] check failed', failOpen ? '(open)' : '(closed)', (err as Error)?.message);
    return { allowed: failOpen, n: 0 };
  }
}

/**
 * The client address as a rate-limit key: what every per-address bucket is
 * keyed on. Vercel overwrites `x-forwarded-for` with the real client address
 * and refuses externally supplied values, so the first hop is trustworthy on
 * this deployment. Empty in local dev.
 *
 * NOT the raw address for IPv6: see addressKey. Nothing here needs the address
 * itself, and nothing should store it.
 */
export function clientIp(headers: { get(name: string): string | null }): string {
  const xff = headers.get('x-forwarded-for') ?? '';
  return addressKey(xff.split(',')[0].trim() || headers.get('x-real-ip') || '');
}

/**
 * One key per client, as far as an address can say so.
 *
 * - IPv4 as is (a port, if a proxy ever appends one, is dropped).
 * - IPv6 cut to its /64, written `2001:db8:1:2::/64`. One subscriber, one
 *   phone or one rented server holds at least a /64 and can walk through its
 *   2^64 addresses at will, so a cap on the full address caps nothing.
 * - An IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) as the IPv4 it carries.
 * - Loopback stays `::1` or `127.x.x.x`, so the routes still recognise local
 *   dev and e2e (isLocalAddress).
 * - Anything unparseable, trimmed and lowercased as it came.
 */
export function addressKey(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (!s) return '';
  // [v6]:port or [v6]
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracket) s = bracket[1];
  // v4:port
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);
  if (v4port) s = v4port[1];
  if (ipv4Octets(s)) return s;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const g = ipv6Groups(s);
  if (!g) return raw.trim().toLowerCase();
  const zeroTo = (k: number) => g.slice(0, k).every((x) => x === 0);
  if (zeroTo(5) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  if (zeroTo(7) && g[7] === 1) return '::1';
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * Claude's own servers (Anthropic's published egress range, 160.79.104.0/21). Every tool call from every Claude user
 * reaches the connector from these, so a per-address limit there would be one limit shared by everyone.
 */
export function isClaudeServer(key: string): boolean {
  const o = ipv4Octets(key);
  return Boolean(o && o[0] === 160 && o[1] === 79 && o[2] >= 104 && o[2] <= 111);
}

/** No address, or the loopback one: local dev and e2e (`next dev` / `next start` fill x-forwarded-for from the socket). */
export function isLocalAddress(key: string): boolean {
  return !key || /^(?:127\.|::1$)/.test(key);
}

function ipv4Octets(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? o : null;
}

/** The eight 16-bit groups of an IPv6 address (`::` and a trailing dotted IPv4 allowed), or null. */
function ipv6Groups(s: string): number[] | null {
  if (!s.includes(':')) return null;
  let head = s;
  let v4: number[] | null = null;
  const last = s.lastIndexOf(':');
  if (s.slice(last + 1).includes('.')) {
    v4 = ipv4Octets(s.slice(last + 1));
    if (!v4) return null;
    head = `${s.slice(0, last + 1)}0:0`;
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const h of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  if (!left || !right) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null;
    groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  } else groups = left;
  if (groups.length !== 8) return null;
  if (v4) {
    groups[6] = (v4[0] << 8) | v4[1];
    groups[7] = (v4[2] << 8) | v4[3];
  }
  return groups;
}

export type AddressGate = { allowed: true } | { allowed: false; limit: 'hour' | 'day' };

/**
 * One address held to an hour cap and a day cap (a UTC day, like every other
 * day bucket). Buckets `<prefix>:<key>` (hour) and `<prefix>d:<key>` (day).
 *
 * The hour is checked first, and a refusal there does not touch the day, so
 * the day counts only what got past the hour. A check that fails with
 * `failOpen: false` reports 'hour' (try later), never 'day' (tomorrow).
 * No address, or the loopback one, is never counted (isLocalAddress).
 */
/**
 * The network address as it is kept: a keyed hash, never the address. The key is ROOM_SECRET (or the editor's session
 * secret); without one the hash is unkeyed, which is fine on a laptop and not on a deployment.
 */
export function addressBucket(key: string): string {
  const secret = process.env.ROOM_SECRET || process.env.EDITOR_SESSION_SECRET || 'rally-dev';
  return createHmac('sha256', secret).update(`addr:${key}`).digest('base64url').slice(0, 22);
}

let swept = 0;
/** Rows for windows that ended more than two days ago are of no use to anyone. Cleared at most hourly per instance, in passing. */
export function sweepThrottle(): void {
  const now = Date.now();
  if (now - swept < 3_600_000) return;
  swept = now;
  void cleanupThrottle(2 * 86_400).catch(() => undefined);
}

export async function throttleAddress(
  prefix: string,
  key: string,
  limits: { perHour: number; perDay: number },
  options: { failOpen?: boolean } = {},
): Promise<AddressGate> {
  if (isLocalAddress(key)) return { allowed: true };
  sweepThrottle();
  const who = addressBucket(key);
  const hour = await throttle(`${prefix}:${who}`, limits.perHour, 3600, options);
  if (!hour.allowed) return { allowed: false, limit: 'hour' };
  const day = await throttle(`${prefix}d:${who}`, limits.perDay, 86_400, options);
  if (!day.allowed) return { allowed: false, limit: day.n === 0 ? 'hour' : 'day' };
  return { allowed: true };
}
