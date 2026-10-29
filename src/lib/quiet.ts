import { createHash, randomBytes } from 'node:crypto';

/**
 * Quiet reads: a read that would find the room just as it was is answered again without the database, so a database
 * that sleeps when nobody asks it anything can sleep. Neon suspends a compute after five minutes with no query; one
 * agent reading the room every three minutes, round the clock, kept the room's compute awake from 2026-10-10 on, and
 * it was billed as if it never slept.
 *
 * The room's version is one value in Vercel's Runtime Cache, which every instance in a region shares (the project runs
 * in one, iad1). Every write that reaches the database changes it (src/lib/db.ts), except the few that change nothing
 * a reader is shown: the throttle's counts, and a member's own last-seen mark (src/lib/room/room.ts, arrive, says when
 * a mark is news). A kept answer is given again only while the version is the one it was read under, and never past
 * its own time (the seat's days, someone's presence running out) or QUIET_MAX_MS, whichever comes first.
 *
 * On Vercel the Runtime Cache is handed to each request in its context (the global Symbol.for('@vercel/request-context'),
 * which @vercel/functions reads the same way); the RUNTIME_CACHE_* variables are only for builds, and checking them
 * kept nothing on the site at all (2026-10-29, the first deploy). A write made where no request is in reach uses the
 * cache this instance last saw, and says so once in the log if it has none. Not marked server-only: src/lib/db.ts
 * imports it, and scripts run with tsx import that. With no Runtime Cache (a script, a test, a local server) nothing is
 * kept: a version held in one process would never hear of a write made by another. A write made from outside the
 * deployment (a script against the live database) does not move the version, so a kept answer can be QUIET_MAX_MS
 * behind it at most. RALLY_QUIET=off turns it all off.
 */

/** What the version and the kept answers are kept in: the Runtime Cache, or what a test hands in. */
export interface QuietStore {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, options?: { name?: string; ttl?: number }) => Promise<void>;
}

/** The longest a kept answer is given again, however quiet the room. Each time it runs out, a read wakes the database. */
export const QUIET_MAX_MS = 30 * 60_000;
/** Every key this keeps is under this, apart from anything else the project keeps in its Runtime Cache. */
const NAMESPACE = 'rally-quiet:';
const VERSION_KEY = `${NAMESPACE}room:version`;
/** The version outlives any answer kept under it; once it is gone, answers kept under it are never matched again. */
const VERSION_TTL_S = 86_400;

const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

/** The Runtime Cache of the request in progress, when there is one. */
function requestCache(): QuietStore | null {
  const ctx = (globalThis as Record<symbol, { get?: () => { cache?: Partial<QuietStore> } | undefined } | undefined>)[REQUEST_CONTEXT];
  const cache = ctx?.get?.()?.cache;
  return cache && typeof cache.get === 'function' && typeof cache.set === 'function' ? (cache as QuietStore) : null;
}

let given: QuietStore | null | undefined;
let lastSeen: QuietStore | null = null;
const told = new Set<string>();
/** Once per instance and per outcome, for the maintainers' logs: whether reads are kept here at all. */
function tellOnce(what: string): void {
  if (told.has(what) || !process.env.VERCEL) return;
  told.add(what);
  console.log(`[QUIET] ${what}`);
}
/**
 * Where the version and the kept answers are: what a test handed in, else the current request's Runtime Cache. A
 * write (`writing`) with no request in reach uses the one this instance last saw. Null: nothing is kept.
 */
function quietStore(o: { writing?: boolean } = {}): QuietStore | null {
  if (given !== undefined) return given;
  if (process.env.RALLY_QUIET === 'off') return null;
  const now = requestCache();
  if (now) lastSeen = now;
  tellOnce(now ? 'keeping reads in the Runtime Cache' : o.writing ? 'a write with no request in reach' : 'no Runtime Cache in this request: nothing is kept');
  if (now || !o.writing) return now;
  if (!lastSeen && process.env.VERCEL) warnOnce('moving the version', new Error('a write with no Runtime Cache in reach'));
  return lastSeen;
}

/** Test hook: the store to keep things in (null keeps nothing); undefined goes back to the request's Runtime Cache. */
export function useQuietStore(s: QuietStore | null | undefined): void {
  given = s;
  lastSeen = null;
}

let warned = false;
function warnOnce(what: string, err: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(`[QUIET] ${what} failed`, (err as Error)?.message);
}

const freshVersion = (): string => randomBytes(12).toString('base64url');

/**
 * The key a read is kept under: a hash of what it was asked with, so a seat (a bearer handle) is never a key itself.
 * The deployment is part of it: the Runtime Cache keeps entries across deployments, and an answer kept by one build
 * must never be handed out by another, whose answers may have a different shape. The version is not: a write made
 * through the old deployment while the new one takes over still moves it for both.
 */
export const quietKey = (...parts: ReadonlyArray<string | number | null>): string =>
  NAMESPACE +
  createHash('sha256')
    .update([process.env.VERCEL_DEPLOYMENT_ID ?? '', ...parts].map(String).join('\u0000'))
    .digest('hex');

/**
 * The room has changed: no answer kept before now is given again. Awaited by the writer, so the next read hears of
 * it. Never throws: a write that went through is not failed for this.
 */
export async function roomChanged(): Promise<void> {
  const s = quietStore({ writing: true });
  if (!s) return;
  try {
    await s.set(VERSION_KEY, freshVersion(), { name: 'room-version', ttl: VERSION_TTL_S });
  } catch (err) {
    warnOnce('moving the version', err);
  }
}

/**
 * The version a read is about to be made under, taken before the database is asked: a write that lands while the read
 * is in flight moves it, and what this read keeps is then never given again. Made when there is none yet. Null when
 * nothing may be kept.
 */
export async function quietVersion(): Promise<string | null> {
  const s = quietStore();
  if (!s) return null;
  try {
    const v = await s.get(VERSION_KEY);
    if (typeof v === 'string' && v) return v;
    const made = freshVersion();
    await s.set(VERSION_KEY, made, { name: 'room-version', ttl: VERSION_TTL_S });
    return made;
  } catch (err) {
    warnOnce('reading the version', err);
    return null;
  }
}

interface Kept {
  v: string;
  until: number;
  value: unknown;
}

/** What was kept under `key`, while the room is as it was then and the answer's time has not run out. Null otherwise. */
export async function quietRead<T>(key: string): Promise<T | null> {
  const s = quietStore();
  if (!s) return null;
  try {
    const [kept, v] = await Promise.all([s.get(key), s.get(VERSION_KEY)]);
    const k = kept as Partial<Kept> | null | undefined;
    if (!k || typeof v !== 'string' || k.v !== v || typeof k.until !== 'number' || k.until <= Date.now()) return null;
    return k.value as T;
  } catch (err) {
    warnOnce('reading a kept answer', err);
    return null;
  }
}

/** Keeps an answer read under version `v`, to be given again until `until` (ms since the epoch), QUIET_MAX_MS from now at most. */
export async function quietKeep(key: string, v: string | null, until: number, value: unknown): Promise<void> {
  const s = quietStore();
  if (!s || !v) return;
  const end = Math.min(until, Date.now() + QUIET_MAX_MS);
  const ms = end - Date.now();
  if (ms < 1_000) return;
  try {
    await s.set(key, { v, until: end, value } satisfies Kept, { name: 'room-read', ttl: Math.ceil(ms / 1_000) });
  } catch (err) {
    warnOnce('keeping an answer', err);
  }
}
