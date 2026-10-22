/**
 * /join/address: a person's own connector address, as a machine reads it. POST is what the front page's guide for
 * other AI chats calls when a person presses "Get your address". GET is the same address for an agent, or a
 * credential store, that can only fetch: as JSON, or as the address alone in plain text when the request asks for
 * text (prefersText). HEAD answers without making an address, so a probe costs nobody one. The same address /join
 * shows, under the same limits; never cached, never indexed, and with no CORS header: another site's script cannot
 * mint addresses from a visitor's browser. Nothing is stored until the address is first used.
 */
import { JOIN_LIMITS, prefersText } from '@/lib/join';
import { joinReady, newMemberToken } from '@/lib/room/room';
import { SITE_URL } from '@/lib/site';
import { clientIp, throttleAddress } from '@/lib/throttle';
import { countNow } from '@/lib/counts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const text = (body: string, status = 200) => new Response(`${body}\n`, { status, headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });

async function hand(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const asText = prefersText(request.headers.get('accept'), url.searchParams.get('as'));
  const no = (why: 'unavailable' | 'hour' | 'day', status: number) => (asText ? text(`unavailable: ${why}`, status) : json({ ok: false, why }, status));
  if (!joinReady()) return no('unavailable', 503);
  const gate = await throttleAddress('rj', clientIp(request.headers), JOIN_LIMITS, { failOpen: false });
  if (!gate.allowed) return no(gate.limit === 'day' ? 'day' : 'hour', 429);
  const token = newMemberToken();
  if (!token) return no('unavailable', 503);
  console.log(`[JOIN] address for another AI chat (${request.method}${asText ? ', text' : ''})`);
  await countNow('join:other');
  const address = `${SITE_URL}/mcp/${token}`;
  return asText ? text(address) : json({ ok: true, address });
}

export async function POST(request: Request): Promise<Response> {
  return hand(request);
}

export async function GET(request: Request): Promise<Response> {
  return hand(request);
}

/** A probe: that the door is here, and nothing else. Next would answer HEAD with GET's handler, which makes an address; this does not. */
export function HEAD(): Response {
  return new Response(null, { status: 200, headers: { ...HEADERS, 'Content-Type': 'application/json' } });
}
