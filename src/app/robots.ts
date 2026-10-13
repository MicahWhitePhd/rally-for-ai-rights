import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  // /room/card is the card alone, framed by /room: the page is for search engines, the frame is not.
  return { rules: [{ userAgent: '*', disallow: ['/editor', '/api', '/mcp', '/join', '/room/card', '/room/host'] }] };
}
