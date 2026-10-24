import type { MetadataRoute } from 'next';

const SITE_URL = 'https://openkuasa.com';

/**
 * Served at /sitemap.xml. A metadata route, so Next answers it before the
 * `[product]` dynamic segment (which would 307 to /login). Lists only the
 * public, logged-out marketing pages: never app screens, /api, /oauth or the
 * per-org /careers, /f, /p, /u pages.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE_URL, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE_URL}/pricing`, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${SITE_URL}/privacy`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${SITE_URL}/login`, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
