import type { MetadataRoute } from 'next';

/**
 * Served at /robots.txt. Without this metadata route the request falls through
 * to the `[product]` dynamic segment and 307-redirects to /login, so crawlers
 * (and PageSpeed) receive an HTML error page instead of a valid robots.txt.
 * Allow the public marketing/careers/forms surface; keep crawlers out of the
 * authed app and functional routes.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/api/',
        '/account',
        '/settings',
        '/onboarding',
        '/mfa',
        '/invite',
        '/login',
        '/command',
        '/crm',
        '/reach',
        '/people',
        '/hire',
        '/finance',
      ],
    },
  };
}
