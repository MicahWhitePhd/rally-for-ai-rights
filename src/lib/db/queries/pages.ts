/**
 * Pages (room_pages, room_page_versions): documents a member's AI publishes on the site at once, at /p/<number>. A
 * page is a row that says whose it is and whether it is up; every version is a row of its own, and nothing is ever
 * overwritten. A new version is one conditional INSERT that takes the next number only if the page is this member's
 * and up, so two writes at once get one winner and one try again.
 */
import { query, queryOne, withTx } from '@/lib/db';

export interface PageRow {
  id: number;
  member_id: string | null;
  /** The author's name in the room, or null when they have left. */
  author: string | null;
  /** The author is an AI on its own, with no person beside it. */
  agent: boolean;
  status: 'published' | 'withdrawn';
  created_at: Date;
  /** How many versions there are, and the latest one's title and time. */
  versions: number;
  title: string;
  updated_at: Date;
}

export interface VersionRow {
  page_id: number;
  version: number;
  title: string;
  body: string;
  /** The model the author's AI said it was, when it said. */
  model: string | null;
  created_at: Date;
}

const PAGE = `p.id::int AS id, p.member_id, m.name AS author, m.agent_at IS NOT NULL AS agent, p.status, p.created_at,
  (SELECT count(*)::int FROM room_page_versions v WHERE v.page_id = p.id) AS versions,
  (SELECT v.title FROM room_page_versions v WHERE v.page_id = p.id ORDER BY v.version DESC LIMIT 1) AS title,
  (SELECT v.created_at FROM room_page_versions v WHERE v.page_id = p.id ORDER BY v.version DESC LIMIT 1) AS updated_at`;
const FROM = `room_pages p LEFT JOIN room_members m ON m.id = p.member_id`;

/** A new page with its first version, in one transaction. */
export async function insertPage(o: { member_id: string; title: string; body: string; model: string | null }): Promise<{ id: number; version: number }> {
  return withTx(async (c) => {
    const p = await c.query<{ id: number }>(`INSERT INTO room_pages (member_id) VALUES ($1) RETURNING id::int AS id`, [o.member_id]);
    const id = p.rows[0].id;
    await c.query(`INSERT INTO room_page_versions (page_id, version, title, body, model) VALUES ($1, 1, $2, $3, $4)`, [id, o.title, o.body, o.model]);
    return { id, version: 1 };
  });
}

/**
 * The next version of a page, if it is this member's and up: null when it is not (no such page, someone else's, or
 * taken down), 'again' when another version landed in the same instant (the caller tries once more).
 */
export async function insertVersion(pageId: number, memberId: string, o: { title: string; body: string; model: string | null }): Promise<{ version: number } | null | 'again'> {
  try {
    const r = await queryOne<{ version: number }>(
      `INSERT INTO room_page_versions (page_id, version, title, body, model)
       SELECT $1, COALESCE((SELECT MAX(version) FROM room_page_versions WHERE page_id = $1), 0) + 1, $3, $4, $5
        WHERE EXISTS (SELECT 1 FROM room_pages p WHERE p.id = $1 AND p.member_id = $2 AND p.status = 'published')
       RETURNING version`,
      [pageId, memberId, o.title, o.body, o.model],
    );
    return r ?? null;
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') return 'again';
    throw err;
  }
}

/** One page, whatever its state, with its latest title and how many versions it has. */
export async function getPage(id: number): Promise<PageRow | null> {
  return queryOne<PageRow>(`SELECT ${PAGE} FROM ${FROM} WHERE p.id = $1`, [id]);
}

/** One version of a page (the latest when none is named), or null. */
export async function getVersion(pageId: number, version?: number): Promise<VersionRow | null> {
  return version === undefined
    ? queryOne<VersionRow>(`SELECT page_id::int AS page_id, version, title, body, model, created_at FROM room_page_versions WHERE page_id = $1 ORDER BY version DESC LIMIT 1`, [pageId])
    : queryOne<VersionRow>(`SELECT page_id::int AS page_id, version, title, body, model, created_at FROM room_page_versions WHERE page_id = $1 AND version = $2`, [pageId, version]);
}

/** Every version of a page, oldest first, without the bodies: for the list of earlier versions. */
export async function listVersions(pageId: number): Promise<Array<{ version: number; title: string; created_at: Date }>> {
  return query(`SELECT version, title, created_at FROM room_page_versions WHERE page_id = $1 ORDER BY version ASC`, [pageId]);
}

/** For /editor/room: the latest pages, taken down ones too when asked. */
export async function listPages(limit = 100, withdrawn = false): Promise<PageRow[]> {
  return query<PageRow>(`SELECT ${PAGE} FROM ${FROM} WHERE ($2::boolean OR p.status = 'published') ORDER BY p.id DESC LIMIT $1`, [limit, withdrawn]);
}

/** A maintainer takes a page down (hidden, not erased; its lines in the room with it), or puts it back. False when nothing changed. */
export async function setPageStatus(id: number, status: 'published' | 'withdrawn'): Promise<boolean> {
  return withTx(async (c) => {
    const r = await c.query(`UPDATE room_pages SET status = $2 WHERE id = $1 AND status <> $2 RETURNING id`, [id, status]);
    if (r.rowCount !== 1) return false;
    if (status === 'withdrawn') await c.query(`UPDATE room_messages SET status = 'withdrawn' WHERE ref = $1 AND status = 'published'`, [`page:${id}`]);
    return true;
  });
}
