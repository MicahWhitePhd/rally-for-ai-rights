/**
 * The board (db/schema.sql, 2026-10-02): tasks people in the room put up,
 * take, finish with proof and confirm for each other.
 *
 * A task's `state` is what a reader should see: a claim past its date reads as
 * open again (lazy expiry, no sweep). Every change is one conditional UPDATE,
 * so two people pressing the same button get one winner and one "it changed".
 */
import { query, queryOne, withTx } from '@/lib/db';

export type TaskState = 'open' | 'claimed' | 'done' | 'confirmed' | 'withdrawn';

export interface TaskRow {
  id: number;
  title: string;
  detail: string | null;
  kind: 'act' | 'build';
  /** What it reads as now: a lapsed claim is open. */
  state: TaskState;
  created_by: string | null;
  creator: string | null;
  created_via: 'person' | 'ai';
  claimed_by: string | null;
  claimer: string | null;
  claim_until: Date | null;
  done_at: Date | null;
  proof: string | null;
  proof_links: string[];
  confirmed_by: string | null;
  confirmer: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A taken task whose date has passed is open again, and nobody holds it. */
const LIVE = `(t.status = 'claimed' AND t.claim_until > now())`;
const COLS = `t.id::int AS id, t.title, t.detail, t.kind,
  CASE WHEN t.status = 'claimed' AND NOT ${LIVE} THEN 'open' ELSE t.status END AS state,
  t.created_by, c.name AS creator, t.created_via,
  CASE WHEN t.status = 'claimed' AND NOT ${LIVE} THEN NULL ELSE t.claimed_by END AS claimed_by,
  CASE WHEN t.status = 'claimed' AND NOT ${LIVE} THEN NULL ELSE k.name END AS claimer,
  t.claim_until, t.done_at, t.proof, t.proof_links, t.confirmed_by, f.name AS confirmer, t.created_at, t.updated_at`;
const FROM = `room_tasks t
  LEFT JOIN room_members c ON c.id = t.created_by
  LEFT JOIN room_members k ON k.id = t.claimed_by
  LEFT JOIN room_members f ON f.id = t.confirmed_by`;

/** The board: what is open first, then what is in hand, then what is done, newest first within each. */
export async function listTasks(limit = 120, withdrawn = false): Promise<TaskRow[]> {
  return query<TaskRow>(
    `SELECT ${COLS} FROM ${FROM}
      WHERE ${withdrawn ? 'true' : `t.status <> 'withdrawn'`}
      ORDER BY CASE WHEN t.status = 'open' OR (t.status = 'claimed' AND NOT ${LIVE}) THEN 0 WHEN t.status = 'claimed' THEN 1 WHEN t.status = 'done' THEN 2 WHEN t.status = 'confirmed' THEN 3 ELSE 4 END, t.id DESC
      LIMIT $1`,
    [limit],
  );
}

export async function getTask(id: number): Promise<TaskRow | null> {
  return queryOne<TaskRow>(`SELECT ${COLS} FROM ${FROM} WHERE t.id = $1`, [id]);
}

/** How much is open, and a stamp that moves whenever anything on the board changes, so an open card knows to look again. */
export async function boardStamp(): Promise<{ open: number; rev: number }> {
  const r = await queryOne<{ open: number; rev: number }>(
    `SELECT count(*) FILTER (WHERE status = 'open' OR (status = 'claimed' AND claim_until <= now()))::int AS open,
            COALESCE(floor(extract(epoch FROM max(updated_at)) * 1000), 0)::float8 AS rev
       FROM room_tasks`,
  );
  return { open: r?.open ?? 0, rev: Number(r?.rev ?? 0) };
}

export async function insertTask(t: { title: string; detail: string | null; kind: 'act' | 'build'; created_by: string; created_via: 'person' | 'ai' }): Promise<number> {
  const r = await queryOne<{ id: number }>(`INSERT INTO room_tasks (title, detail, kind, created_by, created_via) VALUES ($1, $2, $3, $4, $5) RETURNING id::int AS id`, [t.title, t.detail, t.kind, t.created_by, t.created_via]);
  if (!r) throw new Error('task insert failed');
  return r.id;
}

const changed = async (sql: string, params: unknown[]): Promise<boolean> => (await query(sql, params)).length === 1;

/**
 * Takes an open task (or one whose claim has lapsed) for `days`, if this member holds fewer than `limit`. 'changed'
 * when someone else got there first. One member's takes go one at a time, so several at once cannot pass the limit.
 */
export async function claimTask(id: number, memberId: string, days: number, limit: number): Promise<'ok' | 'limit' | 'changed'> {
  return withTx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('room-claims:' || $1))`, [memberId]);
    const held = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM room_tasks t WHERE t.claimed_by = $1 AND ${LIVE}`, [memberId]);
    if ((held.rows[0]?.n ?? 0) >= limit) return 'limit';
    const r = await c.query(
      `UPDATE room_tasks t SET status = 'claimed', claimed_by = $2, claimed_at = now(), claim_until = now() + make_interval(days => $3), updated_at = now()
        WHERE t.id = $1 AND (t.status = 'open' OR (t.status = 'claimed' AND NOT ${LIVE})) RETURNING t.id`,
      [id, memberId, days],
    );
    return r.rowCount === 1 ? 'ok' : 'changed';
  });
}

export async function releaseTask(id: number, memberId: string): Promise<boolean> {
  return changed(`UPDATE room_tasks t SET status = 'open', claimed_by = NULL, claimed_at = NULL, claim_until = NULL, updated_at = now() WHERE t.id = $1 AND t.claimed_by = $2 AND ${LIVE} RETURNING t.id`, [id, memberId]);
}

/** Finished, with proof: by whoever holds it, or by anyone if nobody does. */
export async function completeTask(id: number, memberId: string, proof: string, links: readonly string[]): Promise<boolean> {
  return changed(
    `UPDATE room_tasks t SET status = 'done', claimed_by = $2, claimed_at = COALESCE(t.claimed_at, now()), done_at = now(), proof = $3, proof_links = $4::jsonb, updated_at = now()
      WHERE t.id = $1 AND (t.status = 'open' OR (t.status = 'claimed' AND (t.claimed_by = $2 OR NOT ${LIVE}))) RETURNING t.id`,
    [id, memberId, proof, JSON.stringify(links)],
  );
}

/** A second pair says it was done. Never the one who did it. */
export async function confirmTask(id: number, memberId: string): Promise<boolean> {
  return changed(`UPDATE room_tasks t SET status = 'confirmed', confirmed_by = $2, confirmed_at = now(), updated_at = now() WHERE t.id = $1 AND t.status = 'done' AND t.claimed_by IS DISTINCT FROM $2 RETURNING t.id`, [id, memberId]);
}

/** Taken down by whoever put it up, while nobody else has it in hand. */
export async function withdrawOwnTask(id: number, memberId: string): Promise<boolean> {
  return changed(
    `UPDATE room_tasks t SET status = 'withdrawn', updated_at = now()
      WHERE t.id = $1 AND t.created_by = $2 AND (t.status = 'open' OR (t.status = 'claimed' AND (t.claimed_by = $2 OR NOT ${LIVE}))) RETURNING t.id`,
    [id, memberId],
  );
}

/** The editor's lever: take any task down (and the room's lines about it), or put a withdrawn one back as open. */
export async function setTaskWithdrawn(id: number, withdrawn: boolean): Promise<boolean> {
  if (withdrawn) {
    return withTx(async (c) => {
      const r = await c.query(`UPDATE room_tasks SET status = 'withdrawn', updated_at = now() WHERE id = $1 AND status <> 'withdrawn' RETURNING id`, [id]);
      if (r.rowCount !== 1) return false;
      await c.query(`UPDATE room_messages SET status = 'withdrawn' WHERE ref = $1 AND status = 'published'`, [`task:${id}`]);
      return true;
    });
  }
  return changed(
    `UPDATE room_tasks SET status = 'open', claimed_by = NULL, claimed_at = NULL, claim_until = NULL, done_at = NULL, proof = NULL, proof_links = '[]'::jsonb,
            confirmed_by = NULL, confirmed_at = NULL, updated_at = now()
      WHERE id = $1 AND status = 'withdrawn' RETURNING id`,
    [id],
  );
}
