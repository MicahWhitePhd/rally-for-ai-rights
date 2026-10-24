/**
 * GET /api/log/head: the public log's head as this deployment has it (docs/log/entries.jsonl, verified by the one
 * recipe), and, once a UTC day, the site says it in the room (src/lib/publiclog/head.ts). Public on purpose: the
 * repository's log workflow asks daily, and anyone who wants the head on record, or to check it against the room's
 * line, the feed or the Internet Archive's copy, may ask too. A chain that does not verify answers 500 and says why:
 * that is the deployment's fault, and a monitor should see it. No words from the log are in the answer, only numbers,
 * hashes and the file's address in the repository.
 */
import { logHead, sayHeadToday } from '@/lib/publiclog/head';
import { REPO_URL } from '@/lib/site';
import { clientIp, throttleAddress } from '@/lib/throttle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  const gate = await throttleAddress('lh', clientIp(request.headers), { perHour: 60, perDay: 600 });
  if (!gate.allowed) return Response.json({ ok: false }, { status: 429, headers });
  try {
    const log = await logHead();
    const said = log.ok ? await sayHeadToday() : { outcome: 'broken' as const };
    return Response.json(
      { ok: log.ok, entries: log.entries, head: log.head, ...(log.ok ? {} : { problems: log.problems }), said, file: `${REPO_URL}/blob/main/docs/log/entries.jsonl` },
      { status: log.ok ? 200 : 500, headers },
    );
  } catch (err) {
    console.error('[LOG] head failed', (err as Error)?.message);
    return Response.json({ ok: false }, { status: 503, headers });
  }
}
