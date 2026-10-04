/**
 * GET /api/health: 200 "ok" when the database answers with the schema this code needs, 503 when it does not. For an
 * uptime monitor: the pages fall back to their defaults when the database is down, so they stay green while the room
 * is dead; this does not. It reads the newest columns, so a deploy that went out before `pnpm db:apply` shows here.
 * It says nothing else (no counts). Each check wakes a database that sleeps when idle for its idle timeout (five
 * minutes on Neon): every 30 minutes keeps it awake about a sixth of a quiet day, every 5 minutes around the clock.
 */
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' };
  try {
    // The newest columns: if db/schema.sql was not applied after they were added, this fails. Add new ones here too.
    await query('SELECT m.muted_at, r.ref, p.approved_at FROM room_members m, room_messages r, room_proposals p LIMIT 0');
    return new Response('ok\n', { headers });
  } catch (err) {
    console.error('[HEALTH] database', (err as Error)?.message);
    return new Response('database unreachable\n', { status: 503, headers });
  }
}
