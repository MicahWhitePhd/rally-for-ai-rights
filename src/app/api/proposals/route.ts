/**
 * GET /api/proposals: the changes proposed through the room that a maintainer has read and approved, waiting to be
 * opened as pull requests.
 *
 * Public on purpose. A job in the public repository reads this list (scripts/open-proposals.mjs), fetches
 * each proposal it has not yet opened from /api/proposals/<id>, checks it again by its own copy of the rules, and
 * opens the pull request. The site holds no token for the repository; this is the whole of what passes between them,
 * and a maintainer has read all of it before it is listed here.
 */
import { pendingProposals } from '@/lib/db/queries/proposals';
import { REPO } from '@/lib/site';
import { proposalsEnvOn } from '@/lib/build/propose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  if (!proposalsEnvOn()) return Response.json({ repo: REPO, proposals: [] }, { headers });
  try {
    const rows = await pendingProposals();
    return Response.json({ repo: REPO, proposals: rows.map((r) => ({ id: r.id, branch: r.branch, title: r.title, at: new Date(r.created_at).toISOString() })) }, { headers });
  } catch (err) {
    console.error('[BUILD] proposals list failed', (err as Error)?.message);
    return Response.json({ ok: false }, { status: 503, headers });
  }
}
