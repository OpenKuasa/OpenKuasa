import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import {
  RECOVERY_COOKIE,
  issueRecoveryMarker,
  recoveryCookieOptions,
} from '@/lib/auth/recovery-marker';
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

// A verified recovery link is the only thing that unlocks the "set a new
// password" form, so leave proof of it for that form's action to check.
async function markRecovery(userId: string | undefined) {
  if (!userId) return;
  (await cookies()).set(
    RECOVERY_COOKIE,
    issueRecoveryMarker(userId),
    recoveryCookieOptions(),
  );
}

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
    const { data, error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) {
      // Verified as `recovery`: the token came from a link emailed to the
      // account's own inbox.
      if (type === 'recovery') await markRecovery(data.user?.id);
      redirect(next);
    }
  } else if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // The client library remembers that this code came from a reset request
      // and reports it here (the field is missing from its published types).
      const { redirectType } = data as { redirectType?: string | null };
      if (redirectType === 'recovery') await markRecovery(data.user?.id);
      redirect(next);
    }
  }

  redirect('/login?notice=link_invalid');
}
