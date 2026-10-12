import 'server-only';
import { createAnonymousClient } from '@/lib/supabase/anonymous';

export type PasswordCheck = 'ok' | 'wrong' | 'unavailable';

/**
 * Checks a user's current password without touching the session they are
 * signed in with. The sign-in happens on a client that stores nothing and
 * never sees the request's cookies, so the caller's session (and its
 * two-factor level) is exactly as it was afterwards.
 *
 * Use this wherever a signed-in user is asked to confirm their password.
 * Calling `signInWithPassword` on the cookie-bound client instead would
 * replace their session.
 */
export async function verifyCurrentPassword(
  email: string,
  password: string,
): Promise<PasswordCheck> {
  const throwaway = createAnonymousClient();
  const { data, error } = await throwaway.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.session) {
    const rejected =
      error?.code === 'invalid_credentials' ||
      /invalid login credentials/i.test(error?.message ?? '');
    return rejected ? 'wrong' : 'unavailable';
  }

  // The check created a real session on the auth server; end it so it does
  // not sit there unused until it expires.
  const { error: signOutErr } = await throwaway.auth.signOut({ scope: 'local' });
  if (signOutErr) {
    console.error('password check: could not end the check session');
  }
  return 'ok';
}

export const PASSWORD_CHECK_ERRORS: Record<Exclude<PasswordCheck, 'ok'>, string> = {
  wrong: 'Your current password is incorrect.',
  unavailable: 'Could not check your password right now. Please try again.',
};
