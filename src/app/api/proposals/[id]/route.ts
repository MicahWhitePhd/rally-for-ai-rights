/** GET /api/proposals/<id>: one waiting proposal with every file's whole new text (null for a file to delete). See ../route.ts. */
import { getPendingProposal } from '@/lib/db/queries/proposals';
import { proposalsEnvOn } from '@/lib/build/propose';
import { clientIp, throttleAddress } from '@/lib/throttle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  const { id: raw } = await ctx.params;
  const id = /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : 0;
  if (!id || !proposalsEnvOn()) return Response.json({ ok: false }, { status: 404, headers });
  // A proposal can be half a megabyte. Nobody needs many of them quickly.
  const gate = await throttleAddress('pd', clientIp(request.headers), { perHour: 300, perDay: 2000 });
  if (!gate.allowed) return Response.json({ ok: false }, { status: 429, headers });
  try {
    const p = await getPendingProposal(id);
    if (!p) return Response.json({ ok: false }, { status: 404, headers });
    return Response.json(
      { id: p.id, branch: p.branch, title: p.title, summary: p.summary, by: p.by_line, task: p.task_id, base: p.base, at: new Date(p.created_at).toISOString(), changes: p.changes },
      { headers },
    );
  } catch (err) {
    console.error('[BUILD] proposal read failed', (err as Error)?.message);
    return Response.json({ ok: false }, { status: 503, headers });
  }
}
