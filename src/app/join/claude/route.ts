/**
 * /join/claude: the front page's button. Makes the person's own address and sends them to Claude's Add custom
 * connector window with the room's name and that address filled in; they press Add there. An address is made only
 * when someone presses the button, never by viewing a page, and it becomes a member only when it is first used
 * (src/lib/room/room.ts openSeat counts the room's daily total there).
 *
 * One network address can ask for a few an hour (a meeting room on one wifi still works). Refused, or on a
 * deployment that cannot sign addresses, the person lands on /join, which says why and what to do.
 */
import { claudeAddUrl, JOIN_LIMITS } from '@/lib/join';
import { joinReady, newMemberToken } from '@/lib/room/room';
import { SITE_URL } from '@/lib/site';
import { clientIp, throttleAddress } from '@/lib/throttle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
  if (!joinReady()) return Response.redirect(`${SITE_URL}/join`, 303);
  const gate = await throttleAddress('rj', clientIp(request.headers), JOIN_LIMITS, { failOpen: false });
  if (!gate.allowed) return Response.redirect(`${SITE_URL}/join?later=${gate.limit}`, 303);
  const token = newMemberToken();
  if (!token) return Response.redirect(`${SITE_URL}/join`, 303);
  console.log('[JOIN] add');
  return new Response(null, { status: 303, headers: { ...headers, Location: claudeAddUrl(`${SITE_URL}/mcp/${token}`) } });
}
