import { describe, expect, it } from 'vitest';
import { trustConfiguredSiteOrigin } from '@/lib/security/site-origin';

/**
 * Behind a proxy that writes `x-forwarded-host` without the port (Kong) or rewrites
 * it, Next's Server Actions check refuses a form sent from the site's own address.
 * The site's own address (PUBLIC_SITE_URL) is trusted; anything else is left as is.
 */
const headers = (h: Record<string, string>) => new Headers(h);

describe('trustConfiguredSiteOrigin', () => {
  it('names the configured site as the forwarded host when the browser came from it', () => {
    const h = headers({ origin: 'http://localhost:58273', 'x-forwarded-host': 'localhost' });
    trustConfiguredSiteOrigin(h, 'http://localhost:58273');
    expect(h.get('x-forwarded-host')).toBe('localhost:58273');
  });

  it('works for an https link with no port, and a configured address with a trailing slash', () => {
    const h = headers({ origin: 'https://abc123.preview.example', 'x-forwarded-host': '127.0.0.1' });
    trustConfiguredSiteOrigin(h, 'https://abc123.preview.example/');
    expect(h.get('x-forwarded-host')).toBe('abc123.preview.example');
  });

  it('leaves a request from any other origin alone, so Next still refuses it', () => {
    const h = headers({ origin: 'http://evil.example', 'x-forwarded-host': 'localhost' });
    trustConfiguredSiteOrigin(h, 'http://localhost:58273');
    expect(h.get('x-forwarded-host')).toBe('localhost');
  });

  it('does not match on scheme or port differences', () => {
    for (const origin of ['https://localhost:58273', 'http://localhost:58272', 'http://localhost']) {
      const h = headers({ origin, 'x-forwarded-host': 'localhost' });
      trustConfiguredSiteOrigin(h, 'http://localhost:58273');
      expect(h.get('x-forwarded-host')).toBe('localhost');
    }
  });

  it('does nothing without an origin, without a configured site, or with one that is not a URL', () => {
    const none = headers({ 'x-forwarded-host': 'localhost' });
    trustConfiguredSiteOrigin(none, 'http://localhost:58273');
    expect(none.get('x-forwarded-host')).toBe('localhost');
    for (const site of [undefined, '', 'not a url']) {
      const h = headers({ origin: 'http://localhost:58273', 'x-forwarded-host': 'localhost' });
      trustConfiguredSiteOrigin(h, site);
      expect(h.get('x-forwarded-host')).toBe('localhost');
    }
  });

  it('ignores an origin of "null" (sandboxed frames, some redirects)', () => {
    const h = headers({ origin: 'null', 'x-forwarded-host': 'localhost' });
    trustConfiguredSiteOrigin(h, 'http://localhost:58273');
    expect(h.get('x-forwarded-host')).toBe('localhost');
  });
});
