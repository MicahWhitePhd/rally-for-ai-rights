/** /sitemap.xml: the pages for a search engine. Not /join (it hands out an address on every view), /tasks (people's names; noindexed) or the card alone. */
import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  return ['/', '/room', '/rules', '/privacy'].map((path) => ({ url: `${SITE_URL}${path}` }));
}
