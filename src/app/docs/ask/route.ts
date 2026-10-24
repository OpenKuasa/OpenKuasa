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

function goTo(path: string, request: NextRequest): NextResponse {
  const response = NextResponse.redirect(new URL(path, request.nextUrl));
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/**
 * "Ask Sari" from the docs. Signed in: Sari's page with the question in the input, unsent. Otherwise
 * sign-in first, which returns there. Nothing here sends a question or reaches the assistant.
 */
export async function GET(request: NextRequest) {
  const question = cleanAsk(request.nextUrl.searchParams.get('q'));
  if (!question) return goTo('/docs', request);

  const sari = sariAskPath(question);
  if (await signedIn()) return goTo(sari, request);
  return goTo(`/login?next=${encodeURIComponent(sari)}`, request);
}
