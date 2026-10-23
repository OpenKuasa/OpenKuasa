import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';

const updateSession = vi.fn();
vi.mock('@/lib/supabase/middleware', () => ({ updateSession: (request: NextRequest) => updateSession(request) }));

const { proxy, config } = await import('@/proxy');

beforeEach(() => {
  updateSession.mockReset();
  updateSession.mockImplementation(() => NextResponse.next());
});

test.each(['/api/mcp', '/.well-known/oauth-protected-resource'])('%s skips the cookie session', async (path) => {
  const response = await proxy(new NextRequest(`https://openkuasa.com${path}`, { method: path === '/api/mcp' ? 'POST' : 'GET' }));
  expect(updateSession).not.toHaveBeenCalled();
  expect(response.status).toBe(200);
  expect(response.headers.get('location')).toBeNull();
});

test('other paths still refresh the session', async () => {
  await proxy(new NextRequest('https://openkuasa.com/api/chat', { method: 'POST' }));
  await proxy(new NextRequest('https://openkuasa.com/api/mcpx'));
  expect(updateSession).toHaveBeenCalledTimes(2);
});

describe('which paths the proxy runs on', () => {
  const runs = (path: string, headers?: Record<string, string>) =>
    unstable_doesMiddlewareMatch({ config, url: `https://openkuasa.com${path}`, headers });

  /** Every image the public folder serves, as its URL path. */
  const publicImages = (dir = 'public', prefix = ''): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? publicImages(join(dir, entry.name), `${prefix}/${entry.name}`)
        : /\.(?:svg|png|jpe?g|gif|webp|ico)$/i.test(entry.name)
          ? [`${prefix}/${entry.name}`]
          : [],
    );

  test('image-like paths that a dynamic route answers go through the proxy, server action or not', () => {
    const paths = [
      '/invite/x.png',
      '/hr/x.png',
      '/crm/contacts.svg',
      '/p/abc.webp',
      '/f/form.jpg',
      '/x.png',
      // Unknown files beside real assets: the [product]/[item] route answers these.
      '/landing/x.jpg',
      '/theme/x.webp',
      '/landing/command.jpg/x',
      '/xdemo-logo.png',
      '/_next/staticx.png',
      // No such file: the [product] route answers it.
      '/favicon.ico',
    ];
    for (const path of paths) {
      expect(runs(path), path).toBe(true);
      expect(runs(path, { 'next-action': 'abc123' }), `${path} with Next-Action`).toBe(true);
    }
  });

  test('pages and APIs go through the proxy', () => {
    for (const path of ['/', '/hr', '/hr/employees', '/account/developers', '/api/chat', '/oauth/consent']) {
      expect(runs(path), path).toBe(true);
    }
  });

  test('real static assets skip it, every public image among them', () => {
    const images = publicImages();
    expect(images.length).toBeGreaterThan(0);
    for (const path of [...images, '/_next/static/chunks/app.js', '/_next/static/media/font.woff2', '/_next/image', '/icon.svg']) {
      expect(runs(path), path).toBe(false);
    }
  });
});
