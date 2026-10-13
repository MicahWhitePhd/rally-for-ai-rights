import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

export default function robots(): MetadataRoute.Robots {
  // /room/card is the card alone, framed by /room: the page is for search engines, the frame is not.
  return { rules: [{ userAgent: '*', disallow: ['/editor', '/api', '/mcp', '/join', '/room/card', '/room/host'] }], sitemap: `${SITE_URL}/sitemap.xml` };
}
