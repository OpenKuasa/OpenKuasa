import { redirect } from 'next/navigation';
import { type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { safeAppPath } from '@/lib/security/safe-path';
import { createClient } from '@/lib/supabase/server';

const VALID_TYPES: EmailOtpType[] = [
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
];


/**
 * Verifies an email auth link (recovery, signup confirmation, magic link, …)
 * and establishes a session, then forwards the user on. Handles both the
 * token_hash form (custom email templates) and the PKCE `code` form.
 *
 * `redirect()` is used so the cookies set by Supabase during verification are
 * preserved on the response (NextResponse.redirect would drop them).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const code = searchParams.get('code');
  // Only an in-app path may be the post-verification destination.
  const next = safeAppPath(searchParams.get('next')) ?? '/command';

  const supabase = await createClient();

  if (tokenHash && type && VALID_TYPES.includes(type)) {
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) redirect(next);
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) redirect(next);
  }

  redirect('/login?notice=link_invalid');
}
