/**
 * The public log's head in the room (src/lib/publiclog/head.ts): the deployed log verified, the head said once a UTC
 * day as the site's own line through the room's gate, nothing said of a chain that is wrong or a room that is closed,
 * and the name kept for the site's voice. The database is mocked: what the tests read is what would be written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  open: true as unknown,
  member: 'site-log' as string | null,
  stopped: false,
  days: new Map<string, { seq: number; hash: string; text: string; member_id: string }>(),
  said: [] as Array<{ member_id: string; text: string; ref: string }>,
  members: [] as Array<[string, string]>,
}));
vi.mock('@/lib/db/queries/settings', () => ({ getSetting: async (k: string, fallback: unknown) => (k === 'room_open' ? db.open : fallback), setSetting: async () => undefined }));
vi.mock('@/lib/db/queries/publiclog', () => ({
  ensureSiteMember: async (voice: string, name: string) => {
    db.members.push([voice, name]);
    return db.member;
  },
  sayLogHead: async (o: { day: string; seq: number; hash: string; member_id: string; text: string }) => {
    if (db.days.has(o.day)) return null;
    db.days.set(o.day, { seq: o.seq, hash: o.hash, text: o.text, member_id: o.member_id });
    if (db.stopped) return { line: null };
    db.said.push({ member_id: o.member_id, text: o.text, ref: `log:${o.seq}` });
    return { line: db.said.length };
  },
}));

const { headLine, logHead, LOG_VOICE, sayHeadToday, setLogText } = await import('@/lib/publiclog/head');
const { nextEntry, lineOf, shortHead } = await import('../../scripts/log-chain.mjs');
const { plainTextProblems } = await import('@/lib/text');
const { nameIssue } = await import('@/lib/room/room');
const { ROOM } = await import('@/lib/copy');

const entries = (() => {
  const out: Array<ReturnType<typeof nextEntry>> = [];
  out.push(nextEntry(out, '2026-10-24', 'The log opens.'));
  out.push(nextEntry(out, '2026-10-25', 'An objection was recorded.'));
  return out;
})();
const FILE = entries.map(lineOf).join('\n') + '\n';
const T = new Date('2026-10-25T09:00:00Z');

beforeEach(() => {
  db.open = true;
  db.member = 'site-log';
  db.stopped = false;
  db.days = new Map();
  db.said = [];
  db.members = [];
  setLogText(FILE);
});

describe('the log as deployed', () => {
  it('is verified by the one recipe, and the head is its last entry', async () => {
    expect(await logHead()).toEqual({ ok: true, problems: [], entries: 2, head: { seq: 2, date: '2026-10-25', hash: entries[1].hash, short: shortHead(entries[1].hash) } });
    setLogText('');
    expect(await logHead()).toEqual({ ok: true, problems: [], entries: 0, head: null });
    setLogText(FILE.replace('An objection', 'No objection'));
    const broken = await logHead();
    expect(broken.ok).toBe(false);
    expect(broken.problems).toEqual([`entry 2: hash is not its own (${shortHead(nextEntry([entries[0]], '2026-10-25', 'No objection was recorded.').hash)} expected)`]);
    // The file in this checkout verifies too.
    setLogText(null);
    expect((await logHead()).ok).toBe(true);
  });
});

describe('saying the head', () => {
  it('once a UTC day, as the site’s own line, in the room’s words, through the gate, under the name kept for it', async () => {
    expect(await sayHeadToday(T)).toEqual({ outcome: 'said', line: 1 });
    const text = `stands at entry 2, head ${shortHead(entries[1].hash)} (2026-10-25).`;
    expect(db.said).toEqual([{ member_id: 'site-log', text, ref: 'log:2' }]);
    expect(headLine(ROOM, { seq: 2, date: '2026-10-25', hash: entries[1].hash, short: shortHead(entries[1].hash) })).toBe(text);
    expect(plainTextProblems(text)).toEqual([]);
    expect(db.members).toEqual([[LOG_VOICE, 'Public log']]);
    expect(db.days.get('2026-10-25')).toMatchObject({ seq: 2, hash: entries[1].hash });
    // Asked again the same day, from this instance or another: nothing more.
    expect(await sayHeadToday(new Date('2026-10-25T23:59:00Z'))).toEqual({ outcome: 'already' });
    expect(db.said).toHaveLength(1);
    // The next day, again.
    expect(await sayHeadToday(new Date('2026-10-26T00:01:00Z'))).toEqual({ outcome: 'said', line: 2 });
  });

  it('says nothing of a chain that is wrong, an empty log, a closed room, a voice with no row, or a voice a maintainer stopped', async () => {
    setLogText(FILE.replace('An objection', 'No objection'));
    expect(await sayHeadToday(T)).toEqual({ outcome: 'broken' });
    setLogText('');
    expect(await sayHeadToday(T)).toEqual({ outcome: 'empty' });
    setLogText(FILE);
    db.open = false;
    expect(await sayHeadToday(T)).toEqual({ outcome: 'closed' });
    db.open = true;
    db.member = null;
    expect(await sayHeadToday(T)).toEqual({ outcome: 'nowhere' });
    db.member = 'site-log';
    db.stopped = true;
    // The day's row is taken all the same, so nothing tries again until tomorrow, and the maintainers see the line missing.
    expect(await sayHeadToday(T)).toEqual({ outcome: 'stopped' });
    expect(db.days.has('2026-10-25')).toBe(true);
    expect(db.said).toEqual([]);
  });

  it('the name is kept for the site: nobody in the room takes it, whole or as a word', () => {
    for (const n of ['Public log', 'Log', 'The Log', 'log keeper']) expect(nameIssue(n), n).toBe('nameReserved');
    for (const n of ['Logan', 'Blog', 'Analog Al']) expect(nameIssue(n), n).toBeNull();
  });
});
