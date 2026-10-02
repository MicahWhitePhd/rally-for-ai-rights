/** Changes to the app proposed through the room (room_proposals): who proposed what, and the pull request it became. */
import { query, queryOne } from '@/lib/db';

export interface ProposalRow {
  id: number;
  title: string;
  proposer: string | null;
  task_id: number | null;
  branch: string;
  pr_number: number | null;
  pr_url: string | null;
  created_at: Date;
}

export async function insertProposal(p: { member_id: string; task_id: number | null; title: string; branch: string; pr_number: number; pr_url: string }): Promise<number> {
  const r = await queryOne<{ id: number }>(`INSERT INTO room_proposals (member_id, task_id, title, branch, pr_number, pr_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::int AS id`, [p.member_id, p.task_id, p.title, p.branch, p.pr_number, p.pr_url]);
  if (!r) throw new Error('proposal insert failed');
  return r.id;
}

export async function listProposals(limit = 50): Promise<ProposalRow[]> {
  return query<ProposalRow>(
    `SELECT p.id::int AS id, p.title, m.name AS proposer, p.task_id::int AS task_id, p.branch, p.pr_number, p.pr_url, p.created_at
       FROM room_proposals p LEFT JOIN room_members m ON m.id = p.member_id ORDER BY p.id DESC LIMIT $1`,
    [limit],
  );
}
