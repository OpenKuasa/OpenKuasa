import { type NextRequest } from 'next/server';
import { cspHeaders, createNonce } from '@/lib/security/headers';
import { updateSession } from '@/lib/supabase/middleware';

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

  const response = await updateSession(request);
  for (const [key, value] of Object.entries(policy)) response.headers.set(key, value);
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static assets and image files, so the
     * Supabase session is refreshed and the content policy is set on page/data
     * requests only. The fixed security headers go on every path, from
     * next.config.ts.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
