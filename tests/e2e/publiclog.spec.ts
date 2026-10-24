/**
 * The public log's head, said in the room once a day (src/lib/publiclog): GET /api/log/head verifies the log as
 * deployed, answers with its head, and the first time each UTC day says it in the room as the site's own line, once,
 * however often it is asked. Today's row and line are removed after, so the suite can run again today.
 */
import { expect, test } from '@playwright/test';
import { closeDb, db, HAS_DB } from './helpers';

test.describe('the public log', () => {
  test.skip(!HAS_DB, 'DATABASE_URL is not set');
  const today = new Date().toISOString().slice(0, 10);
  const clear = async () => {
    await db().query(`DELETE FROM room_messages WHERE id IN (SELECT message_id FROM room_log_heads WHERE day = $1::date)`, [today]);
    await db().query(`DELETE FROM room_log_heads WHERE day = $1::date`, [today]);
  };
  test.beforeAll(clear);
  test.afterAll(async () => {
    await clear();
    await closeDb();
  });

  test('answers with the verified head, and says it in the room once a day as the site’s own line', async ({ request }) => {
    const res = await request.get('/api/log/head');
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('no-store');
    const body = (await res.json()) as { ok: boolean; entries: number; head: { seq: number; date: string; hash: string; short: string }; said: { outcome: string; line?: number }; file: string };
    expect(body).toMatchObject({ ok: true, said: { outcome: 'said' }, file: 'https://github.com/MicahWhitePhd/rally-for-ai-rights/blob/main/docs/log/entries.jsonl' });
    expect(body.entries).toBeGreaterThanOrEqual(1);
    expect(body.head.seq).toBe(body.entries);
    expect(body.head.short).toMatch(/^[0-9a-f]{8}:[0-9a-f]{8}$/);
    expect(body.head.hash.startsWith(body.head.short.replace(':', ''))).toBe(true);
    // The row and the line: the site's voice, under the name kept for it, two numbers and a hash.
    const rows = (
      await db().query<{ seq: number; hash: string; text: string; kind: string; ref: string; name: string; site: string }>(
        `SELECT h.seq, h.hash, r.text, r.kind, r.ref, m.name, m.site FROM room_log_heads h JOIN room_messages r ON r.id = h.message_id JOIN room_members m ON m.id = r.member_id WHERE h.day = $1::date`,
        [today],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ seq: body.head.seq, hash: body.head.hash, text: `stands at entry ${body.head.seq}, head ${body.head.short} (${body.head.date}).`, kind: 'event', ref: `log:${body.head.seq}`, name: 'Public log', site: 'log' });
    expect(rows[0].text).not.toContain(body.head.hash);
    // Asked again: the same head, and nothing more said.
    const again = (await (await request.get('/api/log/head')).json()) as { said: { outcome: string } };
    expect(again.said).toEqual({ outcome: 'already' });
    expect((await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM room_log_heads WHERE day = $1::date`, [today])).rows[0].n).toBe(1);
  });
});
