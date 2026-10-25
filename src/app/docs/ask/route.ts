import { NextResponse, type NextRequest } from 'next/server';
import { isOAuthClientToken } from '@/lib/auth/oauth-token';
import { hasSupabaseEnv } from '@/lib/auth/preview-mode';
import { cleanAsk, sariAskPath } from '@/lib/docs/ask';
import { createClient } from '@/lib/supabase/server';

/** Whether the request carries a real person's app session (not a demo guest, not an AI tool's token). */
async function signedIn(): Promise<boolean> {
  if (!hasSupabaseEnv()) return false;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.is_anonymous === true) return false;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return !(session && isOAuthClientToken(session.access_token));
}

/**
 * A same-site redirect with a relative Location, so the browser stays on the address it used. Behind the host's
 * proxy the request URL is the internal one (https://localhost:8080 on Railway), so an absolute URL built from it
 * would send people there.
 */
function goTo(path: string): NextResponse {
  return new NextResponse(null, {
    status: 307,
    headers: { Location: path, 'Cache-Control': 'no-store' },
  });
}

/**
 * "Ask Sari" from the docs. Signed in: Sari's page with the question in the input, unsent. Otherwise
 * sign-in first, which returns there. Nothing here sends a question or reaches the assistant.
 */
export async function GET(request: NextRequest) {
  const question = cleanAsk(request.nextUrl.searchParams.get('q'));
  if (!question) return goTo('/docs');

  const sari = sariAskPath(question);
  if (await signedIn()) return goTo(sari);
  return goTo(`/login?next=${encodeURIComponent(sari)}`);
}
