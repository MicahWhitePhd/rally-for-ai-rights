/**
 * /room: the room on the web. The same document the MCP App serves inside an
 * AI chat (src/lib/room/ui.generated.ts); with no host around it, it takes a
 * guest seat and works as a plain group chat, without the AI buttons.
 */
import { FRONT, SITE_TITLE } from '@/lib/copy';
import { ROOM_UI_HTML } from '@/lib/room/ui.generated';
import { SITE_URL } from '@/lib/site';

export const dynamic = 'force-static';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
/** A shared /room link previews like the front page: the creed, the share line, the card image. */
const PREVIEW = [
  `<meta name="description" content="${esc(FRONT.share)}">`,
  `<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(SITE_TITLE)}">`,
  `<meta property="og:title" content="${esc(FRONT.creed)}"><meta property="og:description" content="${esc(FRONT.share)}">`,
  `<meta property="og:image" content="${SITE_URL}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`,
  `<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${SITE_URL}/og.png">`,
].join('');

export function GET(): Response {
  const html = ROOM_UI_HTML.replace('<title>The room</title>', `<title>The room \u00b7 ${esc(SITE_TITLE)}</title>${PREVIEW}`);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}
