import { createBrowserClient } from '@supabase/ssr';
import { authCookieName, readPublicConfig } from './public-config';

/**
 * Supabase client for use in Client Components (browser).
 *
 * The settings come from the page (see the root layout), so one build fits every install.
 */
export function createClient() {
  const { supabaseUrl, supabaseAnonKey } = readPublicConfig();
  return createBrowserClient(supabaseUrl!, supabaseAnonKey!, {
    cookieOptions: { name: authCookieName(supabaseUrl!) },
  });
}
