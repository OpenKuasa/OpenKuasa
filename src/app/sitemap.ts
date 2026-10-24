import type { MetadataRoute } from 'next';
import { getAllGuides } from '@/lib/docs/content';

const SITE_URL = 'https://openkuasa.com';

/**
 * Served at /sitemap.xml. A metadata route, so Next answers it before the
 * `[product]` dynamic segment (which would 307 to /login). Lists only the
 * public, logged-out marketing pages: never app screens, /api, /oauth or the
 * per-org /careers, /f, /p, /u pages. The docs home and every guide are
 * listed. /login is left out on purpose: robots.txt
 * disallows it, and a sitemap must not list a blocked page.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE_URL, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE_URL}/pricing`, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${SITE_URL}/privacy`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${SITE_URL}/docs`, changeFrequency: 'weekly', priority: 0.7 },
    ...getAllGuides().map((g) => ({
      url: `${SITE_URL}${g.url}`,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    })),
  ];
}
