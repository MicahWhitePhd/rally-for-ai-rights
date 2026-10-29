/**
 * The database's one door (src/lib/db.ts) moves the room's version (src/lib/quiet.ts) after every write that changed
 * something, so no read kept from before it is given again; a plain read, a write that changed nothing, and a write
 * marked unseen leave it where it is. With `pg` mocked: nothing here reaches a database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => ({ rowCount: 1 as number | null, texts: [] as string[], changed: 0 }));
vi.mock('pg', () => ({
  Pool: class {
    async query(text: string) {
      pg.texts.push(text);
      return { rows: [], rowCount: pg.rowCount };
    }
    async connect() {
      return {
        query: async (text: string) => {
          pg.texts.push(text);
          return { rows: [], rowCount: 1 };
        },
        release: () => undefined,
      };
    }
  },
}));
vi.mock('@/lib/quiet', () => ({
  roomChanged: async () => {
    pg.changed++;
  },
}));

process.env.DATABASE_URL ??= 'postgresql://localhost/never-reached';
const { query, queryOne, withTx } = await import('@/lib/db');

beforeEach(() => {
  pg.rowCount = 1;
  pg.texts = [];
  pg.changed = 0;
});

describe('the room changes when the database is written', () => {
  it('a write that changed a row moves the version, before the caller hears back', async () => {
    await query(`INSERT INTO room_messages (member_id, kind, text) VALUES ($1, 'ai', $2) RETURNING id`, ['m1', 'hello']);
    expect(pg.changed).toBe(1);
    await queryOne(`UPDATE room_members SET name = $2 WHERE id = $1 RETURNING id`, ['m1', 'Dana']);
    await query(`DELETE FROM room_seats WHERE created_at < now() - interval '8 days'`);
    await query(`WITH c AS (UPDATE room_outreach SET status = 'sending' WHERE id = $1 RETURNING *) SELECT * FROM c`, [1]);
    expect(pg.changed).toBe(4);
  });

  it('a read, or a write that changed nothing, leaves it', async () => {
    await query(`SELECT id, name FROM room_members WHERE updated_at > now() - interval '1 day'`);
    pg.rowCount = 0;
    await query(`UPDATE room_tasks SET status = 'open' WHERE id = $1 AND status = 'claimed' RETURNING id`, [3]);
    expect(pg.changed).toBe(0);
  });

  it('a write marked unseen (the throttle, a last-seen mark) leaves it', async () => {
    await queryOne(`INSERT INTO throttle (bucket, win, n) VALUES ($1, now(), 1) ON CONFLICT (bucket, win) DO UPDATE SET n = throttle.n + 1 RETURNING n`, ['room:r:m1'], { unseen: true });
    expect(pg.changed).toBe(0);
  });

  it('a transaction moves it once it is committed', async () => {
    await withTx(async (c) => {
      await c.query(`UPDATE room_members SET muted_at = now() WHERE id = $1`, ['m1']);
      expect(pg.changed).toBe(0);
    });
    expect(pg.texts.at(-1)).toBe('COMMIT');
    expect(pg.changed).toBe(1);
  });

  it('every write the throttle makes is marked unseen, so counting tries never moves it', async () => {
    const { bumpThrottle, cleanupThrottle } = await import('@/lib/db/queries/throttle');
    await bumpThrottle('room:r:m1', 3600);
    await cleanupThrottle();
    expect(pg.texts).toHaveLength(2);
    expect(pg.changed).toBe(0);
  });
});
