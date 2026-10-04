/**
 * Changes to the app proposed through the room (room_proposals): who proposed what, and each file's whole new text.
 * A proposal is 'pending' from the moment it is kept. A maintainer reads it and approves it (approved_at) or takes it
 * down ('withdrawn'); only approved ones are handed to the job that opens pull requests. Whether one has become a pull
 * request yet is GitHub's to say, not this table's: the branch name carries the proposal's number.
 */
import { query, queryOne, withTx } from '@/lib/db';

export interface ProposalRow {
  id: number;
  title: string;
  proposer: string | null;
  member_id: string | null;
  task_id: number | null;
  branch: string;
  status: 'pending' | 'withdrawn';
  approved_at: Date | null;
  files: number;
  created_at: Date;
}

export interface ProposalDetail {
  id: number;
  title: string;
  summary: string;
  by_line: string;
  task_id: number | null;
  branch: string;
  base: string | null;
  changes: Array<{ path: string; content: string | null }>;
  created_at: Date;
}

/** How long an approved proposal stays on the public list for the job that opens pull requests, counted from approval. */
export const PENDING_DAYS = 14;

/** Keeps a proposal and names its branch after its number, in one statement. */
export async function insertProposal(p: {
  member_id: string;
  task_id: number | null;
  title: string;
  summary: string;
  by_line: string;
  base: string | null;
  slug: string;
  changes: Array<{ path: string; content: string | null }>;
}): Promise<{ id: number; branch: string }> {
  const r = await queryOne<{ id: number; branch: string }>(
    `INSERT INTO room_proposals (id, member_id, task_id, title, summary, by_line, base, branch, changes)
     SELECT n, $1, $2, $3, $4, $5, $6, 'room/p' || n || '-' || $7, $8::jsonb
       FROM nextval(pg_get_serial_sequence('room_proposals', 'id')) AS n
     RETURNING id::int AS id, branch`,
    [p.member_id, p.task_id, p.title, p.summary, p.by_line, p.base, p.slug, JSON.stringify(p.changes)],
  );
  if (!r) throw new Error('proposal insert failed');
  return r;
}

/** For /tasks and /editor/room: the latest proposals, without their contents. */
export async function listProposals(limit = 50, withdrawn = false): Promise<ProposalRow[]> {
  return query<ProposalRow>(
    `SELECT p.id::int AS id, p.title, m.name AS proposer, p.member_id, p.task_id::int AS task_id, p.branch, p.status, p.approved_at,
            jsonb_array_length(p.changes) AS files, p.created_at
       FROM room_proposals p LEFT JOIN room_members m ON m.id = p.member_id
      WHERE ($2::boolean OR p.status = 'pending') ORDER BY p.id DESC LIMIT $1`,
    [limit, withdrawn],
  );
}

/** For /editor/room: one proposal with everything in it, whatever its state, for a maintainer to read before approving. */
export async function getProposal(id: number): Promise<(ProposalDetail & { status: string; approved_at: Date | null }) | null> {
  return queryOne(
    `SELECT id::int AS id, title, summary, by_line, task_id::int AS task_id, branch, base, changes, created_at, status, approved_at
       FROM room_proposals WHERE id = $1`,
    [id],
  );
}

/** For /api/proposals: what the job that opens pull requests has to look at. Oldest first, so nothing waits behind newer ones. */
export async function pendingProposals(limit = 300): Promise<Array<{ id: number; branch: string; title: string; created_at: Date }>> {
  return query(
    `SELECT id::int AS id, branch, title, created_at FROM room_proposals
      WHERE status = 'pending' AND approved_at > now() - ($2::int * interval '1 day') ORDER BY id ASC LIMIT $1`,
    [limit, PENDING_DAYS],
  );
}

/** One approved proposal with every file's new text, or null when there is none to hand out. */
export async function getPendingProposal(id: number): Promise<ProposalDetail | null> {
  return queryOne<ProposalDetail>(
    `SELECT id::int AS id, title, summary, by_line, task_id::int AS task_id, branch, base, changes, created_at FROM room_proposals
      WHERE id = $1 AND status = 'pending' AND approved_at > now() - ($2::int * interval '1 day')`,
    [id, PENDING_DAYS],
  );
}

/** A maintainer takes a proposal down (and the room's line about it), or puts it back (unapproved, to be read again). */
export async function setProposalStatus(id: number, status: 'pending' | 'withdrawn'): Promise<void> {
  await withTx(async (c) => {
    await c.query(`UPDATE room_proposals SET status = $2, approved_at = NULL WHERE id = $1`, [id, status]);
    if (status === 'withdrawn') await c.query(`UPDATE room_messages SET status = 'withdrawn' WHERE ref = $1 AND status = 'published'`, [`proposal:${id}`]);
  });
}

/** A maintainer has read it and lets it go to GitHub. */
export async function approveProposal(id: number): Promise<boolean> {
  return (await query(`UPDATE room_proposals SET approved_at = now() WHERE id = $1 AND status = 'pending' AND approved_at IS NULL RETURNING id`, [id])).length === 1;
}
