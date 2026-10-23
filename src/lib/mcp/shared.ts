/** Helpers both the MCP key store and the caller use: a person's own client, and a log line that is token-safe. */

import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** A client of the person whose access token this is (the anon key and their JWT). One per use, so no session is shared. */
export function userClient(accessToken: string): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error('Supabase is not configured.');
  return createClient(url, anon, {
    global: { headers: { Authorization: 'Bearer ' + accessToken } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * One line for a failure that is otherwise swallowed: the operation and the error's class or code only. Never the
 * message, which can carry a token or an email.
 */
export function logFailure(prefix: string, operation: string, error: unknown): void {
  const withCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
  const raw = typeof withCode === 'string' && withCode ? withCode : error instanceof Error ? error.name : typeof error;
  const code = /^[A-Za-z0-9_.-]{1,40}$/.test(raw) ? raw : 'unknown';
  console.error(`[${prefix}] ${operation} failed: ${code}`);
}
