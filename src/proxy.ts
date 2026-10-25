import { NextResponse, type NextRequest } from 'next/server';
import { cspHeaders, createNonce } from '@/lib/security/headers';
import { updateSession } from '@/lib/supabase/middleware';

/** Paths an MCP client calls with a bearer credential: no cookie session to refresh or set. */
const BEARER_PATHS = new Set(['/api/mcp', '/.well-known/oauth-protected-resource']);

export async function proxy(request: NextRequest) {
  const nonce = createNonce();
  const policy = cspHeaders({
    nonce,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    isDev: process.env.NODE_ENV === 'development',
    // Set CSP_REPORT_ONLY=1 on the host to stop enforcing the full policy without a deploy of new code.
    reportOnly: process.env.CSP_REPORT_ONLY === '1',
  });

  // Next.js takes the nonce for its own scripts from the policy on the request,
  // and the root layout reads `x-nonce` for the one inline script we write. Both
  // are set before the session refresh, which builds its response from this request.
  request.headers.set('x-nonce', nonce);
  request.headers.set(
    'Content-Security-Policy',
    policy['Content-Security-Policy-Report-Only'] ?? policy['Content-Security-Policy'],
  );

  const response = BEARER_PATHS.has(request.nextUrl.pathname) ? NextResponse.next() : await updateSession(request);
  for (const [key, value] of Object.entries(policy)) response.headers.set(key, value);
  return response;
}

export const config = {
  matcher: [
    /*
     * Match every request path except Next's own build assets and the exact
     * files in public/ (plus the app icon), so the Supabase session is
     * refreshed, an AI tool's sign-in session is dropped, and the content
     * policy is set on everything a route can answer. The fixed security
     * headers go on every path, from next.config.ts.
     *
     * Only exact names: a pattern such as "any .png" or "anything under
     * /landing/" also skips paths a dynamic route answers (/invite/x.png,
     * /hr/x.png via [product]/[item]), server actions included. A real public
     * file answers 405 to anything but GET/HEAD, so no action runs on one.
     *
     * Kept in step both ways by tests/proxy.test.ts: every svg/png/jpg/jpeg/
     * gif/webp/ico file in public/ must be listed (else it goes through the
     * proxy: safe, just slower; other public files always do), and every name
     * listed must still exist in public/ or src/app/ (a deleted or renamed
     * file left here would let [product]/[item] answer that path unproxied).
     * The matcher must stay a literal: Next reads it statically at build time.
     * Docs screenshots under /docs-media/ go through the proxy on purpose and are not listed.
     */
    '/((?!_next/static/|_next/image$|icon\\.svg$|apple-icon\\.png$|icons/(?:icon-192|icon-512|maskable-512)\\.png$|(?:demo-logo\\.png|file\\.svg|globe\\.svg|next\\.svg|vercel\\.svg|window\\.svg)$|landing/(?:command|crm|cta-pamor|finance|hero-pamor|hire|keris|people|reach)\\.jpg$|theme/keris-pov\\.webp$).*)',
  ],
};
