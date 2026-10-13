/**
 * /room/card: the room's own document, the same one the MCP App serves inside an AI chat
 * (src/lib/room/ui.generated.ts). On the web it sits in a frame on /room, inside the site's own pages, and is told so
 * (?web=1); opened on its own, with no host around it, it takes a guest seat and works as a plain group chat without
 * the AI buttons. Only this site may frame it (next.config.ts), search engines are sent to /room instead, and a hash
 * it is opened with names a line to show (#line-12, where the feed links).
 */
import { ROOM_UI_HTML } from '@/lib/room/ui.generated';

export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(ROOM_UI_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Robots-Tag': 'noindex' } });
}
