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
