import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: '*', disallow: ['/editor', '/api', '/mcp', '/join', '/room/host'] }] };
}
