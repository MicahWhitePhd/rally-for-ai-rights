/**
 * POST /join/address: a person's own connector address, made when they press "Get your address" in the front page's
 * guide for other AI chats. The same address /join shows, under the same limits; JSON, never cached. Nothing is stored
 * until the address is first used.
 */
import { JOIN_LIMITS } from '@/lib/join';
import { joinReady, newMemberToken } from '@/lib/room/room';
import { SITE_URL } from '@/lib/site';
import { clientIp, throttleAddress } from '@/lib/throttle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });

export async function POST(request: Request): Promise<Response> {
  if (!joinReady()) return json({ ok: false, why: 'unavailable' }, 503);
  const gate = await throttleAddress('rj', clientIp(request.headers), JOIN_LIMITS, { failOpen: false });
  if (!gate.allowed) return json({ ok: false, why: gate.limit === 'day' ? 'day' : 'hour' }, 429);
  const token = newMemberToken();
  if (!token) return json({ ok: false, why: 'unavailable' }, 503);
  console.log('[JOIN] address for another AI chat');
  return json({ ok: true, address: `${SITE_URL}/mcp/${token}` });
}
