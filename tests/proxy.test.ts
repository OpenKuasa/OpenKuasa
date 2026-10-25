import { existsSync, readdirSync } from 'node:fs';
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

  /**
   * Every image the public folder serves, as its URL path, except docs screenshots. Those go through the proxy
   * on purpose: there are many, and the matcher must stay a literal, so `/docs-media/` never appears in it.
   */
  const publicImages = (dir = 'public', prefix = ''): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? `${prefix}/${entry.name}` === '/docs-media'
          ? []
          : publicImages(join(dir, entry.name), `${prefix}/${entry.name}`)
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

  test('docs screenshots go through the proxy and are not named in the matcher', () => {
    expect(runs('/docs-media/x/y.png')).toBe(true);
    expect(publicImages().filter((path) => path.startsWith('/docs-media/'))).toEqual([]);
    expect(config.matcher[0]).not.toContain('docs-media');
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

  /**
   * The exact names the matcher skips, read out of its literal (Next reads `config` statically, so the list cannot
   * be a shared constant): each `|` alternative of the lookahead, `(?:a|b)` groups expanded, Next's own `_next/`
   * paths left out.
   */
  function skippedNames(): string[] {
    const source = config.matcher[0];
    const body = /^\/\(\(\?!(.*)\)\.\*\)$/.exec(source)?.[1];
    if (!body) throw new Error(`unexpected matcher shape: ${source}`);
    const alternatives: string[] = [];
    let depth = 0;
    let current = '';
    for (const char of body) {
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      if (char === '|' && depth === 0) {
        alternatives.push(current);
        current = '';
      } else current += char;
    }
    alternatives.push(current);
    return alternatives
      .filter((alt) => !alt.startsWith('_next/'))
      .flatMap((alt) => {
        expect(alt.endsWith('$'), `${alt} must be anchored with $`).toBe(true);
        const exact = alt.slice(0, -1);
        const group = /^(.*)\(\?:([^()]*)\)(.*)$/.exec(exact);
        const names = group ? group[2].split('|').map((inner) => `${group[1]}${inner}${group[3]}`) : [exact];
        return names.map((name) => {
          const plain = name.replace(/\\\./g, '.');
          expect(plain, `${name} must be a plain file name`).toMatch(/^[\w./-]+$/);
          return plain;
        });
      });
  }

  test('every file the matcher skips still exists, so no route can answer its path unproxied', () => {
    const names = skippedNames();
    expect(names).toContain('icon.svg');
    expect(names).toContain('landing/command.jpg');
    for (const name of names) {
      // The parse matches what the matcher really skips.
      expect(runs(`/${name}`), name).toBe(false);
      expect(existsSync(join('public', name)) || existsSync(join('src/app', name)), `${name} is skipped but missing`).toBe(true);
    }
  });
});
