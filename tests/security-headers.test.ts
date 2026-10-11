import { describe, expect, it } from 'vitest';
import {
  BASELINE_CSP,
  buildCsp,
  cspHeaders,
  createNonce,
  staticSecurityHeaders,
  supabaseSources,
} from '@/lib/security/headers';

const SUPABASE = 'https://abcdefgh.supabase.co';

/** A policy as a map of directive name to its sources. */
function parse(policy: string) {
  return new Map(
    policy.split(';').map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );
}

describe('supabaseSources', () => {
  it('gives the https and wss origin of a project URL', () => {
    expect(supabaseSources(SUPABASE)).toEqual({
      http: 'https://abcdefgh.supabase.co',
      ws: 'wss://abcdefgh.supabase.co',
    });
  });

  it('keeps only the origin of a URL with a path, and maps http to ws', () => {
    expect(supabaseSources('http://127.0.0.1:54321/rest/v1/')).toEqual({
      http: 'http://127.0.0.1:54321',
      ws: 'ws://127.0.0.1:54321',
    });
  });

  it('gives nothing for a missing or unusable URL', () => {
    for (const url of [undefined, '', '   ', 'not a url', 'ftp://example.com', "javascript:alert(1)//'; x"]) {
      expect(supabaseSources(url), String(url)).toBeNull();
    }
  });
});

describe('buildCsp', () => {
  it('builds the production policy for a workspace with a database', () => {
    const csp = parse(buildCsp({ nonce: 'Tm9uY2U=', supabaseUrl: SUPABASE, isDev: false }));
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('script-src')).toEqual(["'self'", "'nonce-Tm9uY2U='", "'strict-dynamic'"]);
    expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp.get('img-src')).toEqual(["'self'", 'data:', 'blob:', SUPABASE]);
    expect(csp.get('media-src')).toEqual(["'self'", 'blob:', SUPABASE]);
    expect(csp.get('font-src')).toEqual(["'self'"]);
    expect(csp.get('connect-src')).toEqual(["'self'", SUPABASE, 'wss://abcdefgh.supabase.co']);
    expect(csp.get('worker-src')).toEqual(["'self'", 'blob:']);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'self'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('never allows inline or evaluated scripts in production', () => {
    const script = parse(buildCsp({ nonce: 'n', supabaseUrl: SUPABASE, isDev: false })).get('script-src');
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it('allows eval in development only, which React needs there', () => {
    const script = parse(buildCsp({ nonce: 'n', supabaseUrl: SUPABASE, isDev: true })).get('script-src');
    expect(script).toContain("'unsafe-eval'");
    expect(script).not.toContain("'unsafe-inline'");
  });

  it('names no outside origin when there is no database', () => {
    for (const supabaseUrl of [undefined, '', 'not a url']) {
      const policy = buildCsp({ nonce: 'n', supabaseUrl, isDev: false });
      expect(policy).not.toMatch(/undefined|null|https?:|wss?:/);
      const csp = parse(policy);
      expect(csp.get('connect-src')).toEqual(["'self'"]);
      expect(csp.get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
    }
  });

  it('is one line with no empty directive', () => {
    const policy = buildCsp({ nonce: 'n', supabaseUrl: SUPABASE, isDev: false });
    expect(policy).not.toMatch(/[\r\n]/);
    for (const [name, sources] of parse(policy)) {
      expect(name).toMatch(/^[a-z-]+$/);
      expect(sources.length, name).toBeGreaterThan(0);
    }
  });
});

describe('cspHeaders', () => {
  it('enforces the whole policy by default', () => {
    const headers = cspHeaders({ nonce: 'n', supabaseUrl: SUPABASE, isDev: false, reportOnly: false });
    expect(Object.keys(headers)).toEqual(['Content-Security-Policy']);
    expect(headers['Content-Security-Policy']).toBe(
      buildCsp({ nonce: 'n', supabaseUrl: SUPABASE, isDev: false }),
    );
  });

  it('in report-only mode still enforces the framing, object, base and form rules', () => {
    const headers = cspHeaders({ nonce: 'n', supabaseUrl: SUPABASE, isDev: false, reportOnly: true });
    expect(headers['Content-Security-Policy']).toBe(BASELINE_CSP);
    expect(headers['Content-Security-Policy-Report-Only']).toBe(
      buildCsp({ nonce: 'n', supabaseUrl: SUPABASE, isDev: false }),
    );
  });

  it('has a baseline that restricts nothing a page loads', () => {
    const csp = parse(BASELINE_CSP);
    expect([...csp.keys()].sort()).toEqual(['base-uri', 'form-action', 'frame-ancestors', 'object-src']);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
  });
});

describe('staticSecurityHeaders', () => {
  const asMap = (isProd: boolean) =>
    new Map(staticSecurityHeaders({ isProd }).map((h) => [h.key, h.value]));

  it('sets the fixed headers', () => {
    const headers = asMap(true);
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Content-Security-Policy')).toBe(BASELINE_CSP);
    const permissions = headers.get('Permissions-Policy') ?? '';
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment']) {
      expect(permissions).toContain(`${feature}=()`);
    }
  });

  it('sends HSTS in production only, without preload', () => {
    const hsts = asMap(true).get('Strict-Transport-Security') ?? '';
    expect(hsts).toMatch(/^max-age=\d+$/);
    expect(hsts).not.toContain('preload');
    expect(asMap(false).has('Strict-Transport-Security')).toBe(false);
  });

  it('has no empty value', () => {
    for (const { key, value } of staticSecurityHeaders({ isProd: true })) {
      expect(value, key).toBeTruthy();
      expect(value).not.toMatch(/undefined|null/);
    }
  });
});

describe('createNonce', () => {
  it('is base64, long enough, and new each time', () => {
    const a = createNonce();
    const b = createNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(a.length).toBeGreaterThanOrEqual(22);
    expect(a).not.toBe(b);
  });
});
