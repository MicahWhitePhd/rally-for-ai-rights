/**
 * GET /api/health: 200 "ok" when the database answers with the schema this code needs, 503 when it does not. For an
 * uptime monitor: the pages fall back to their defaults when the database is down, so they stay green while the room
 * is dead; this does not. It reads the newest columns, so a deploy that went out before `pnpm db:apply` shows here.
 * It says nothing else (no counts). Each check wakes a database that sleeps when idle for its idle timeout (five
 * minutes on Neon): every 30 minutes keeps it awake about a sixth of a quiet day, every 5 minutes around the clock.
 *
 * With ?deep=1, JSON for a monitor that reads words: whether the code index is there, the state of the budget, when
 * each resident last spoke, when the proposals job last read the site, and `warn`, a list that is empty when all is
 * well (a monitor checking for the text "warn":[] is told of a quiet trouble, not only a dead one). No dollars, no
 * counts of people, no words from the room.
 */
import { codeIndex } from '@/lib/build/code';
import { budgetAllows, envHardPause, isPaused } from '@/lib/budget';
import { query } from '@/lib/db';
import { lastPersonLine, proposalsJobSeenAt, residentsLastLine } from '@/lib/db/queries/stats';
import { proposalsEnvOn } from '@/lib/build/propose';
import { residentsOn } from '@/lib/room/residents-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Residents on, people speaking, and no resident line for this long: something is wrong with the model or the budget. */
const RESIDENTS_SILENT_MS = 6 * 3600_000;
/** The job runs hourly; a day and a bit without a read means GitHub switched it off, or the site's address changed. */
const JOB_QUIET_MS = 26 * 3600_000;

export async function GET(request: Request): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' };
  try {
    // The newest columns: if db/schema.sql was not applied after they were added, this fails. Add new ones here too.
    await query('SELECT m.muted_at, m.muted_until, m.maintainer_at, m.away_from, m.lab, r.ref, p.approved_at, g.estimated, c.n, o.provider_id, rr.provider_id FROM room_members m, room_messages r, room_proposals p, generation_log g, room_counts c, room_outreach o, room_outreach_replies rr LIMIT 0');
  } catch (err) {
    console.error('[HEALTH] database', (err as Error)?.message);
    return new Response('database unreachable\n', { status: 503, headers });
  }
  if (new URL(request.url).searchParams.get('deep') !== '1') return new Response('ok\n', { headers });
  const now = Date.now();
  const [index, paused, budget, on, residents, person, jobSeen] = await Promise.all([codeIndex(), isPaused(), budgetAllows(0), residentsOn(), residentsLastLine(), lastPersonLine(), proposalsJobSeenAt()]);
  const warn: string[] = [];
  const files = Object.keys(index.files).length;
  if (files === 0) warn.push('code index missing: read_code shows nothing');
  const budgetState = envHardPause() ? 'hard-paused' : paused ? 'paused' : budget.ok ? 'ok' : 'over';
  if (budgetState === 'over') warn.push('budget over: the residents are silent until midnight UTC');
  const lastResident = residents.reduce<number | null>((m, r) => (r.at ? Math.max(m ?? 0, new Date(r.at).getTime()) : m), null);
  const silent = on && budgetState === 'ok' && person !== null && now - new Date(person).getTime() < RESIDENTS_SILENT_MS && (lastResident === null || now - lastResident > RESIDENTS_SILENT_MS);
  if (silent) warn.push('residents silent for six hours while people spoke');
  if (proposalsEnvOn() && (jobSeen === null || now - jobSeen.getTime() > JOB_QUIET_MS)) warn.push(jobSeen ? 'proposals job not seen for over a day' : 'proposals job never seen');
  const body = {
    ok: true,
    codeIndex: { files, commit: index.commit },
    budget: budgetState,
    residents: { on, lastLine: Object.fromEntries(residents.map((r) => [r.resident, r.at ? new Date(r.at).toISOString() : null])), oldestAgeMin: lastResident === null ? null : Math.round((now - lastResident) / 60_000) },
    proposalsJob: { seenAt: jobSeen ? jobSeen.toISOString() : null, ageHours: jobSeen ? Math.round((now - jobSeen.getTime()) / 360_000) / 10 : null },
    warn,
  };
  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
