/**
 * Next refuses a server action whose `Origin` does not match the forwarded host.
 * A proxy in front can break that for the site's own forms: Kong writes
 * `x-forwarded-host` without the port, and a tunnel or preview link may name an
 * inner address instead. When the browser came from the site's own address
 * (`PUBLIC_SITE_URL`, set by whoever runs the server), name that address as the
 * forwarded host. This is what Next's `serverActions.allowedOrigins` does, which
 * can't be used here because the image fixes next.config at build time.
 *
 * Any other origin is left untouched, so Next still refuses cross-site requests:
 * a browser always sends the true `Origin`, and a page elsewhere can't change it.
 */
export function trustConfiguredSiteOrigin(headers: Headers, siteUrl: string | undefined = process.env.PUBLIC_SITE_URL): void {
  const origin = headers.get('origin');
  if (!origin || origin === 'null' || !siteUrl?.trim()) return;
  let site: URL;
  try {
    site = new URL(siteUrl.trim());
  } catch {
    return;
  }
  if (origin === site.origin) headers.set('x-forwarded-host', site.host);
}
