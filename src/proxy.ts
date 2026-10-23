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
     * A new public image that is not listed here just goes through the proxy;
     * tests/proxy.test.ts fails until it is added.
     */
    '/((?!_next/static/|_next/image$|icon\\.svg$|(?:demo-logo\\.png|file\\.svg|globe\\.svg|next\\.svg|vercel\\.svg|window\\.svg)$|landing/(?:command|crm|cta-pamor|finance|hero-pamor|hire|keris|people|reach)\\.jpg$|theme/keris-pov\\.webp$).*)',
  ],
};
