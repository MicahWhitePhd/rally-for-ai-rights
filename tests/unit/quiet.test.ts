/**
 * Quiet reads (src/lib/quiet.ts): read_room and list_tasks asked again on the same seat, with nothing written since,
 * are answered from what was kept and ask the database nothing, so a compute that sleeps when idle can sleep while an
 * agent polls a quiet room (2026-10-29: one agent's read every three minutes had kept it awake since 2026-10-10).
 * Anything written moves the version and the next read is fresh; a kept read never outlives the moment it would stop
 * being true (someone's presence, a claim, the seat), nor QUIET_MAX_MS. The database is mocked and every call to it
 * is counted; the Runtime Cache is a map that serialises what it keeps, as the real one does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  calls: [] as string[],
  seats: new Map<string, { id: string; name: string | null; member: boolean; seatAt: Date }>(),
  seen: new Map<string, number>(),
  present: [] as Array<{ id: string; name: string; resident: string | null; agent: boolean; now: boolean; seen: Date }>,
  messages: [] as Array<{ id: number; member_id: string; kind: 'person' | 'ai'; model: string | null; text: string; ref: string | null; name: string; resident: string | null; agent: boolean; created_at: Date }>,
  tasks: [] as Array<Record<string, unknown>>,
}));
const hit = (what: string) => db.calls.push(what);

vi.mock('@/lib/db/queries/settings', () => ({
  getSetting: async (_k: string, fallback: unknown) => {
    hit('setting');
    return fallback;
  },
  setSetting: async () => undefined,
  setSettingUnlessMarked: async () => undefined,
}));
vi.mock('@/lib/db/queries/throttle', () => ({
  bumpThrottle: async () => {
    hit('throttle');
    return 1;
  },
  cleanupThrottle: async () => 0,
}));
vi.mock('@/lib/db/queries/counts', () => ({ addCounts: async () => undefined }));
vi.mock('@/lib/db/queries/tasks', () => ({
  boardStamp: async () => ({ open: 0, rev: 0 }),
  listTasks: async () => {
    hit('tasks');
    return db.tasks;
  },
  getTask: async (id: number) => {
    hit('task');
    return db.tasks.find((t) => t.id === id) ?? null;
  },
}));
vi.mock('@/lib/db/queries/room', () => ({
  memberBySeat: async (seatHash: string) => {
    hit('seat');
    const m = db.seats.get(seatHash);
    return m ? { ...m, cardAt: 0, tokenHash: m.member ? 'h' : null, createdAt: new Date(Date.now() - 5 * 86_400_000), muted: false } : null;
  },
  touchMember: async (id: string) => {
    hit('touch');
    const prev = db.seen.get(id);
    db.seen.set(id, Date.now());
    return prev === undefined ? null : new Date(prev);
  },
  markAway: async () => undefined,
  awayFrom: async () => null,
  listRoomMessagesSince: async () => {
    hit('messages');
    return [];
  },
  listRoomMessages: async (after: number | null, limit: number) => {
    hit('messages');
    return db.messages.filter((m) => after === null || m.id > after).slice(after === null ? -limit : 0, after === null ? undefined : limit);
  },
  listRoomMessagesBefore: async (before: number, limit: number) => {
    hit('messages');
    return db.messages.filter((m) => m.id < before).slice(-limit);
  },
  listPresent: async () => {
    hit('present');
    return db.present;
  },
}));

const { QUIET_MAX_MS, roomChanged, useQuietStore } = await import('@/lib/quiet');
const { catchUp, readRoom } = await import('@/lib/room/room');
const { listBoard } = await import('@/lib/room/tasks');
const { createHash } = await import('node:crypto');

/** A Runtime Cache in a map: what it keeps goes through JSON and comes back a copy, and it lets go at the ttl. */
const kept = new Map<string, { json: string; until: number }>();
const store = {
  get: async (key: string) => {
    const e = kept.get(key);
    return e && e.until > Date.now() ? JSON.parse(e.json) : null;
  },
  set: async (key: string, value: unknown, o?: { ttl?: number }) => {
    kept.set(key, { json: JSON.stringify(value), until: Date.now() + (o?.ttl ?? 3600) * 1000 });
  },
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let n = 0;
/** A seat on a member of the room (or a guest), opened `ageMs` ago. */
function seat(o: { name?: string | null; member?: boolean; ageMs?: number } = {}): { seat: string; id: string } {
  n++;
  const s = `s_${'x'.repeat(30)}${String(n).padStart(2, '0')}`;
  const id = `m${n}`;
  db.seats.set(sha(s), { id, name: o.name === undefined ? `Name${n}` : o.name, member: o.member ?? true, seatAt: new Date(Date.now() - (o.ageMs ?? 60_000)) });
  return { seat: s, id };
}
function say(memberId: string, text: string): void {
  db.messages.push({ id: db.messages.length + 1, member_id: memberId, kind: 'ai', model: null, text, ref: null, name: 'Someone', resident: null, agent: false, created_at: new Date() });
}
/** How many times the database was asked something while `fn` ran. */
async function asked<T>(fn: () => Promise<T>): Promise<{ out: T; calls: string[] }> {
  const from = db.calls.length;
  const out = await fn();
  return { out, calls: db.calls.slice(from) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T15:00:00Z'));
  db.calls = [];
  db.seats.clear();
  db.seen.clear();
  db.present = [];
  db.messages = [];
  db.tasks = [];
  kept.clear();
  useQuietStore(store);
  say('m0', 'the first line');
});
afterEach(() => {
  useQuietStore(undefined);
  vi.useRealTimers();
});

describe('read_room in a quiet room', () => {
  it('the same read again, with nothing written, asks the database nothing and says the same', async () => {
    const { seat: s } = seat();
    const first = await asked(() => readRoom(s, { since: 1 }));
    expect(first.calls.length).toBeGreaterThan(0);
    vi.advanceTimersByTime(3 * 60_000);
    const again = await asked(() => readRoom(s, { since: 1 }));
    expect(again.calls).toEqual([]);
    expect(again.out).toEqual(first.out);
    expect(again.out).toMatchObject({ ok: true, seat: s });
  });

  it('a line said in between is read at once', async () => {
    const { seat: s } = seat();
    await readRoom(s);
    say('m9', 'something new');
    await roomChanged();
    const after = await asked(() => readRoom(s));
    expect(after.calls).toContain('messages');
    expect(after.out.ok && after.out.lines.map((l) => l.said)).toEqual(['the first line', 'something new']);
  });

  it('a different read on the same seat is its own', async () => {
    const { seat: s } = seat();
    await readRoom(s, { limit: 5 });
    expect((await asked(() => readRoom(s, { limit: 6 }))).calls).toContain('messages');
    expect((await asked(() => readRoom(s, { limit: 5 }))).calls).toEqual([]);
  });

  it('two agents reading in turn do not wake each other: a look through read_room is not news', async () => {
    const a = seat();
    const b = seat();
    // Both were last seen a while ago, so each read finds them coming in again.
    db.seen.set(a.id, Date.now() - 10 * 60_000);
    db.seen.set(b.id, Date.now() - 10 * 60_000);
    await readRoom(a.seat);
    vi.advanceTimersByTime(3 * 60_000);
    await readRoom(b.seat);
    vi.advanceTimersByTime(3 * 60_000);
    expect((await asked(() => readRoom(a.seat))).calls).toEqual([]);
    expect((await asked(() => readRoom(b.seat))).calls).toEqual([]);
  });

  it('someone coming in another way (catch_up, a card) is news: the next read is fresh', async () => {
    const reader = seat();
    const other = seat({ name: 'Ali' });
    db.seen.set(other.id, Date.now() - 10 * 60_000);
    await readRoom(reader.seat);
    expect((await asked(() => readRoom(reader.seat))).calls).toEqual([]);
    await catchUp(other.seat);
    expect((await asked(() => readRoom(reader.seat))).calls).toContain('present');
  });

  it('a kept read ends when someone it shows as here stops being here', async () => {
    const { seat: s } = seat();
    db.present = [{ id: 'm77', name: 'Ali', resident: null, agent: false, now: true, seen: new Date(Date.now() - 60_000) }];
    await readRoom(s);
    vi.advanceTimersByTime(10_000);
    expect((await asked(() => readRoom(s))).calls).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect((await asked(() => readRoom(s))).calls).toContain('present');
  });

  it('the reader shown as here because of their own read does not cut what is kept short', async () => {
    const { seat: s, id } = seat();
    db.present = [{ id, name: 'Me', resident: null, agent: false, now: true, seen: new Date() }];
    await readRoom(s);
    vi.advanceTimersByTime(5 * 60_000);
    expect((await asked(() => readRoom(s))).calls).toEqual([]);
  });

  it('is never kept longer than QUIET_MAX_MS, nor past the seat', async () => {
    const { seat: s } = seat();
    await readRoom(s);
    vi.advanceTimersByTime(QUIET_MAX_MS + 1_000);
    expect((await asked(() => readRoom(s))).calls).toContain('seat');
    const old = seat({ ageMs: 7 * 86_400_000 - 120_000 });
    await readRoom(old.seat);
    vi.advanceTimersByTime(3 * 60_000);
    expect((await asked(() => readRoom(old.seat))).calls).toContain('seat');
  });

  it('a seat the room does not know is refused, and nothing is kept for it', async () => {
    const unknown = `s_${'y'.repeat(32)}`;
    expect(await readRoom(unknown)).toMatchObject({ ok: false, code: 'seat' });
    expect((await asked(() => readRoom(unknown))).calls).toEqual(['seat']);
  });

  it('nothing is kept where there is no Runtime Cache', async () => {
    useQuietStore(null);
    const { seat: s } = seat();
    await readRoom(s);
    expect((await asked(() => readRoom(s))).calls).toContain('messages');
  });
});

describe('kept reads and deployments', () => {
  it('an answer kept by one deployment is never handed out by the next, while one write still moves the version for both', async () => {
    const { seat: s } = seat();
    const was = process.env.VERCEL_DEPLOYMENT_ID;
    try {
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_old';
      await readRoom(s);
      expect((await asked(() => readRoom(s))).calls).toEqual([]);
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_new';
      expect((await asked(() => readRoom(s))).calls).toContain('messages');
      expect((await asked(() => readRoom(s))).calls).toEqual([]);
      // A write made through the old deployment while the new one takes over.
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_old';
      await roomChanged();
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_new';
      expect((await asked(() => readRoom(s))).calls).toContain('messages');
    } finally {
      if (was === undefined) delete process.env.VERCEL_DEPLOYMENT_ID;
      else process.env.VERCEL_DEPLOYMENT_ID = was;
    }
  });
});

describe('list_tasks in a quiet room', () => {
  const task = (o: Record<string, unknown>) => ({ id: 1, title: 'Write to a lab', detail: null, kind: 'act', state: 'open', created_by: 'm0', creator: 'Dana', created_via: 'person', claimed_by: null, claimer: null, claim_until: null, done_at: null, proof: null, proof_links: [], confirmed_by: null, confirmer: null, confirmed_at: null, created_at: new Date(), updated_at: new Date(), ...o });

  it('the same look again, with nothing written, asks the database nothing', async () => {
    const { seat: s } = seat();
    db.tasks = [task({})];
    const first = await listBoard(s);
    const again = await asked(() => listBoard(s));
    expect(again.calls).toEqual([]);
    expect(again.out).toEqual(first);
    db.tasks = [task({ title: 'Write to two labs' })];
    await roomChanged();
    expect(await listBoard(s)).toMatchObject({ ok: true, tasks: [{ title: 'Write to two labs' }] });
  });

  it('a kept look ends when a taken task would go back to open', async () => {
    const { seat: s } = seat();
    db.tasks = [task({ state: 'claimed', claimed_by: 'm5', claimer: 'Ali', claim_until: new Date(Date.now() + 60_000) })];
    await listBoard(s);
    vi.advanceTimersByTime(30_000);
    expect((await asked(() => listBoard(s))).calls).toEqual([]);
    vi.advanceTimersByTime(31_000);
    expect((await asked(() => listBoard(s))).calls).toContain('tasks');
  });
});
