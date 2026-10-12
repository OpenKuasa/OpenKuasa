import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Signs the user out everywhere except the session making this request. Run
 * it after a password change so a session opened with the old password stops
 * working. Returns false when the auth server refused; the password change
 * itself has already happened, so callers carry on and say so.
 */
export async function endOtherSessions(
  supabase: SupabaseClient,
): Promise<boolean> {
  const { error } = await supabase.auth.signOut({ scope: 'others' });
  if (error) {
    console.error('could not end other sessions after a password change');
    return false;
  }
  return true;
}
