import 'server-only';
import type { PublicConfig } from './public-config';

/** Supabase settings read when the server runs. The NEXT_PUBLIC_ names still work, so existing hosts change nothing. */

/** Where the server reaches Supabase (may be an address only the container network knows). */
export function supabaseServerUrl(): string | undefined {
  return (
    process.env.SUPABASE_INTERNAL_URL ||
    process.env.SUPABASE_PUBLIC_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    undefined
  );
}

/** Where a browser or an outside client reaches Supabase. */
export function supabasePublicUrl(): string | undefined {
  return process.env.SUPABASE_PUBLIC_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || undefined;
}

export function supabaseAnonKey(): string | undefined {
  return process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || undefined;
}

export function demoEnabled(): boolean {
  return process.env.OPENKUASA_DEMO_ENABLED === '1' || process.env.NEXT_PUBLIC_DEMO_ENABLED === '1';
}

export function vapidPublicKey(): string {
  return (process.env.VAPID_PUBLIC_KEY || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '').trim();
}

export function publicConfig(): PublicConfig {
  return { supabaseUrl: supabasePublicUrl() ?? null, supabaseAnonKey: supabaseAnonKey() ?? null };
}

/**
 * A link the server's Supabase client made (signed or public) points at the address the server uses.
 * A browser cannot open that when it differs from the public one, so swap the prefix. Unchanged when
 * the two are equal, either is unset, or the link starts with something else.
 */
export function toPublicSupabaseUrl(url: string): string {
  const server = supabaseServerUrl()?.replace(/\/+$/, '');
  const pub = supabasePublicUrl()?.replace(/\/+$/, '');
  if (!server || !pub || server === pub) return url;
  if (url !== server && !url.startsWith(`${server}/`)) return url;
  return pub + url.slice(server.length);
}
