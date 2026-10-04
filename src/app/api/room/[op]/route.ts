/**
 * /api/room/{enter,sync,older,post,name,tasks,task-new,task-act}: what a room card calls directly from the
 * person's device (the MCP App inside an AI chat, whose frame is on another
 * origin, or /room on this site). JSON posts; the seat travels in the body,
 * never in a URL. Open to any origin: there is no cookie here, only the seat.
 */
import type { NextRequest } from 'next/server';
import { liveCopy } from '@/lib/copy-live';
import { stir } from '@/lib/room/residents';
import { isSeat, nameInRoom, olderRoom, openSeat, postToRoom, seatWritable, syncRoom } from '@/lib/room/room';
import { arrivalOf } from '@/lib/room/server';
import { actOnTask, createTask, listBoard } from '@/lib/room/tasks';
import { addressKey, clientIp, throttleAddress } from '@/lib/throttle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store',
};
const STATUS = { seat: 401, name: 422, text: 422, guest: 403, slow: 429, closed: 503, task: 409, limit: 429, muted: 403 } as const;

/**
 * How often one card may ask for news: a card asks every few seconds, so anything much faster is not a card. Kept
 * in this instance's memory, so a flood of asks is turned away before it reaches the database. Bounded in size.
 * Counted per card, not per seat: when an AI reads the room a new card comes up on the same seat, and the older one
 * must still get through to learn that it has been moved down the chat. A card is its seat and its stamp.
 */
const SYNC_GAP_MS = 1200;
const lastSync = new Map<string, number>();
function tooSoon(seat: unknown, born: unknown): boolean {
  // Only a well-formed seat is remembered: anything else is refused where it is used, and must not fill this map.
  if (!isSeat(seat)) return false;
  const card = `${seat}|${typeof born === 'number' && Number.isSafeInteger(born) ? born : 0}`;
  const now = Date.now();
  const prev = lastSync.get(card);
  if (prev !== undefined && now - prev < SYNC_GAP_MS) return true;
  if (lastSync.size > 50_000) lastSync.clear();
  lastSync.set(card, now);
  return false;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
const tooMany = (limit?: 'hour' | 'day') => json({ ok: false, code: 'slow', reasons: ['too many from here just now'], ...(limit === 'day' ? { why: 'day' } : {}) }, 429);

/** What writes. The web routes cannot tell whose browser is asking, so a seat writes here only for its first day. */
const WRITES = new Set(['post', 'name', 'task-new', 'task-act']);

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ op: string }> }): Promise<Response> {
  const { op } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (body === null || typeof body !== 'object') throw new Error('body');
  } catch {
    return json({ ok: false, code: 'text', reasons: ['body'] }, 400);
  }
  const address = addressKey(clientIp(req.headers));
  if (WRITES.has(op) && !(await seatWritable(body.seat))) {
    return json({ ok: false, code: 'seat', why: 'stale', reasons: ['this card was opened more than a day ago; open the room again to write'] }, 401);
  }

  if (op === 'enter') {
    // With a seat (the MCP card): the room's strings and the latest messages. Without one (/room on the web): a guest seat first.
    let seat = typeof body.seat === 'string' ? body.seat : null;
    // No gap here: a new card often comes up on a seat whose older card synced a moment ago (read_room shows the card again).
    if (!seat) {
      // The web card keeps its seat between visits, so one network address needs few; a busy café or campus still gets in.
      const gate = await throttleAddress('rs', address, { perHour: 60, perDay: 200 }, { failOpen: false });
      if (!gate.allowed) return tooMany(gate.limit);
      const opened = await openSeat({});
      if (!opened.ok) return json(opened, STATUS[opened.code]);
      seat = opened.seat;
    }
    const [synced, copy] = await Promise.all([syncRoom(seat, null, [], body.born), liveCopy()]);
    if (!synced.ok) return json(synced, STATUS[synced.code]);
    stir({ arrival: arrivalOf(synced) });
    return json({ ...synced, seat, strings: copy.ROOM });
  }
  if (op === 'sync') {
    if (tooSoon(body.seat, body.born)) return json({ ok: false, code: 'slow', reasons: ['asked again too soon'] }, 429);
    const after = typeof body.after === 'number' && Number.isInteger(body.after) && body.after >= 0 ? body.after : null;
    const have = Array.isArray(body.have) ? body.have.filter((x): x is number => Number.isInteger(x)).slice(-200) : [];
    const out = await syncRoom(body.seat, after, have, body.born);
    if (out.ok) stir({ arrival: arrivalOf(out) });
    return json(out, out.ok ? 200 : STATUS[out.code]);
  }
  if (op === 'older') {
    const out = await olderRoom(body.seat, body.before);
    return json(out, out.ok ? 200 : STATUS[out.code]);
  }
  if (op === 'post') {
    const gate = await throttleAddress('rp', address, { perHour: 120, perDay: 400 }, { failOpen: false });
    if (!gate.allowed) return tooMany(gate.limit);
    const out = await postToRoom(body.seat, { text: body.text, kind: 'person' });
    if (out.ok) stir();
    return json(out, out.ok ? 201 : STATUS[out.code]);
  }
  if (op === 'tasks') {
    const out = await listBoard(body.seat);
    return json(out, out.ok ? 200 : STATUS[out.code]);
  }
  if (op === 'task-new') {
    const out = await createTask(body.seat, { title: body.title, detail: body.detail, kind: body.kind, via: 'person' });
    return json(out, out.ok ? 201 : STATUS[out.code]);
  }
  if (op === 'task-act') {
    const out = await actOnTask(body.seat, body.id, body.action, { proof: body.proof, links: body.links, via: 'person' });
    return json(out, out.ok ? 200 : STATUS[out.code]);
  }
  if (op === 'name') {
    const out = await nameInRoom(body.seat, body.name);
    if (out.ok) stir({ arrival: arrivalOf(out) });
    return json(out, out.ok ? 200 : STATUS[out.code]);
  }
  return json({ ok: false, code: 'text', reasons: ['unknown'] }, 404);
}
