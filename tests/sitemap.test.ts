import { describe, expect, it } from 'vitest';
import sitemap from '../src/app/sitemap';
import robots from '../src/app/robots';

describe('sitemap', () => {
  const urls = sitemap().map((e) => e.url);

  it('lists the public marketing pages as absolute https URLs', () => {
    expect(urls).toEqual(
      expect.arrayContaining([
        'https://openkuasa.com',
        'https://openkuasa.com/pricing',
        'https://openkuasa.com/privacy',
        'https://openkuasa.com/login',
      ]),
    );
    for (const u of urls) expect(u.startsWith('https://openkuasa.com')).toBe(true);
  });

  it('has no duplicates and no app, api, oauth or per-org paths', () => {
    expect(new Set(urls).size).toBe(urls.length);
    for (const u of urls) {
      expect(u).not.toMatch(
        /\/(api|oauth|careers|account|crm|reach|people|hire|finance|mfa|invite|f|p|u)(\/|$)/,
      );
    }
  });

  it('is advertised by robots.txt', () => {
    expect(robots().sitemap).toBe('https://openkuasa.com/sitemap.xml');
  });
});
