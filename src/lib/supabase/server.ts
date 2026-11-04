import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { REMEMBER_COOKIE, isPersistent, sessionize } from './remember';
import { supabaseAnonKey, supabasePublicUrl, supabaseServerUrl } from './env';
import { authCookieName } from './public-config';

/**
 * Supabase client for use in Server Components, Route Handlers, and Server Actions.
 *
 * `cookies()` is async in Next.js 15+, so this helper is async too.
 *
 * Pass `remember` to force the auth cookie lifetime (used by the sign-in
 * action). When omitted, the persistence is read from the `ok_remember`
 * cookie so every token refresh keeps the user's earlier choice.
 */
export async function createClient(options?: { remember?: boolean }) {
  const cookieStore = await cookies();
  const persist =
    options?.remember ??
    isPersistent(cookieStore.get(REMEMBER_COOKIE)?.value);

  return createServerClient(
    supabaseServerUrl()!,
    supabaseAnonKey()!,
    {
      cookieOptions: { name: authCookieName(supabasePublicUrl()!) },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, sessionize(options, persist)),
            );
          } catch {
            // Called from a Server Component where cookies are read-only.
            // Safe to ignore when the proxy (`updateSession`) refreshes the session.
          }
        },
      },
    },
  );
}
