/**
 * /room: the room on the web. The same document the MCP App serves inside an
 * AI chat (src/lib/room/ui.generated.ts); with no host around it, it takes a
 * guest seat and works as a plain group chat, without the AI buttons.
 */
import { ROOM_UI_HTML } from '@/lib/room/ui.generated';

export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(ROOM_UI_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}
