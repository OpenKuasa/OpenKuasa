import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseAnonKey, supabaseServerUrl } from './env';

/**
 * A client that carries no session at all, whoever is asking. Reading a
 * public page (a form, a job board) must not depend on who happens to be
 * signed in.
 */
export function createAnonymousClient(): SupabaseClient {
  return createClient(
    supabaseServerUrl()!,
    supabaseAnonKey()!,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );
}
