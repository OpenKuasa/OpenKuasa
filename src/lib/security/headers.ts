/**
 * Security response headers.
 *
 * Two places send them, following the Next.js guides:
 *  - next.config.ts `headers()` sends the fixed ones on every path
 *    (`staticSecurityHeaders`), static files included.
 *  - src/proxy.ts sends the Content-Security-Policy on every page and data
 *    request, because the policy carries a nonce that is new on each request.
 *
 * This file imports nothing, so next.config.ts can load it.
 */

/** The framing, plugin, base-URL and form rules. These restrict nothing a page loads. */
export const BASELINE_CSP =
  "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";

/** One year. No `includeSubDomains` and no `preload`: both reach beyond this app and are the owner's call. */
const HSTS = 'max-age=31536000';

/**
 * Browser features no screen uses. The chat's microphone button is not wired
 * to the microphone; allow `microphone=(self)` here when it is.
 */
const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'camera=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
  'browsing-topics=()',
].join(', ');

/** The headers that are the same on every response. */
export function staticSecurityHeaders({ isProd }: { isProd: boolean }) {
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    // For browsers that predate `frame-ancestors`.
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Permissions-Policy', value: PERMISSIONS_POLICY },
    // The proxy replaces this with the full policy on the requests it handles.
    { key: 'Content-Security-Policy', value: BASELINE_CSP },
    ...(isProd ? [{ key: 'Strict-Transport-Security', value: HSTS }] : []),
  ];
}

/**
 * The Supabase project's origin, for the browser's direct calls to it: the API,
 * storage (uploads, the public avatars bucket, signed file links) and realtime.
 * Null when the app runs without a database, or the URL is not an http(s) one.
 */
export function supabaseSources(url: string | undefined): { http: string; ws: string } | null {
  if (!url?.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const scheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return { http: parsed.origin, ws: `${scheme}//${parsed.host}` };
}

type CspInput = {
  /** New on every request; see `createNonce`. */
  nonce: string;
  /** NEXT_PUBLIC_SUPABASE_URL, which is unset when the app runs without a database. */
  supabaseUrl: string | undefined;
  isDev: boolean;
};

/**
 * The full policy.
 *
 * Scripts: only ones that carry this request's nonce, and what those load
 * (`'strict-dynamic'`). Next.js puts the nonce on its own scripts when a page
 * is rendered for the request, which is why every page is rendered that way
 * (see the root layout). `'self'` is there for browsers without
 * `'strict-dynamic'`; the ones that have it ignore it.
 *
 * Styles: inline styles stay allowed. React, Recharts and the landing page's
 * animations set `style` attributes throughout, and the chart kit writes a
 * small `<style>` element (its content is checked in ui/chart-style.ts).
 */
export function buildCsp({ nonce, supabaseUrl, isDev }: CspInput): string {
  const supabase = supabaseSources(supabaseUrl);
  const directives: [string, (string | false | undefined)[]][] = [
    ['default-src', ["'self'"]],
    // Development only: React uses eval to rebuild server error stacks in the browser.
    ['script-src', ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", isDev && "'unsafe-eval'"]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    // data: the two-factor QR code and attached images; blob: local previews.
    ['img-src', ["'self'", 'data:', 'blob:', supabase?.http]],
    ['media-src', ["'self'", 'blob:', supabase?.http]],
    // next/font serves the fonts from this origin.
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'", supabase?.http, supabase?.ws]],
    ['worker-src', ["'self'", 'blob:']],
  ];
  const fetched = directives
    .map(([name, sources]) => `${name} ${sources.filter(Boolean).join(' ')}`)
    .join('; ');
  return `${fetched}; ${BASELINE_CSP}`;
}

/**
 * The policy headers for one response.
 *
 * `reportOnly` is the switch for backing out without a code change: the full
 * policy is then only reported in the browser console, while the baseline
 * rules stay enforced.
 */
export function cspHeaders({
  reportOnly,
  ...input
}: CspInput & { reportOnly: boolean }): Record<string, string> {
  const policy = buildCsp(input);
  if (!reportOnly) return { 'Content-Security-Policy': policy };
  return {
    'Content-Security-Policy': BASELINE_CSP,
    'Content-Security-Policy-Report-Only': policy,
  };
}

/** A nonce for one request, as the Next.js guide makes it. */
export function createNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString('base64');
}
