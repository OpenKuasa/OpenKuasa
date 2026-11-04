/** The Supabase settings the browser needs, handed over in the page so one build fits every install. */

export type PublicConfig = { supabaseUrl: string | null; supabaseAnonKey: string | null };

export const PUBLIC_CONFIG_ID = 'okos-public-config';

/** JSON for a script tag: every `<` is escaped so the value cannot close the tag. */
export function serializePublicConfig(c: PublicConfig): string {
  return JSON.stringify(c).replace(/</g, '\\u003c');
}

/**
 * The config the server wrote into the page. Without it (on the server, or an old page) it reads the
 * environment: the runtime names on the server, the build-time ones in the browser.
 */
export function readPublicConfig(): PublicConfig {
  if (typeof document !== 'undefined') {
    const el = document.getElementById(PUBLIC_CONFIG_ID);
    if (el?.textContent) {
      try {
        return JSON.parse(el.textContent) as PublicConfig;
      } catch {
        // Fall through to the build-time values.
      }
    }
  }
  return {
    supabaseUrl: process.env.SUPABASE_PUBLIC_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null,
  };
}

/**
 * The auth cookie name, derived from the public URL (the same formula supabase-js uses for its
 * default storage key). Server and browser must both use the public URL, or sign-in loops.
 */
export function authCookieName(publicUrl: string): string {
  return `sb-${new URL(publicUrl).hostname.split('.')[0]}-auth-token`;
}

/**
 * A link the server's Supabase client made (signed or public) points at the address the server uses.
 * A browser cannot open that when it differs from the public one, so swap the prefix. Unchanged when
 * the two are equal, either is unset (always so in the browser, which has no server-only names), or
 * the link starts with something else. Holds no secrets: it only reads the URL settings.
 */
export function toPublicSupabaseUrl(url: string): string {
  const server = (
    process.env.SUPABASE_INTERNAL_URL ||
    process.env.SUPABASE_PUBLIC_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL
  )?.replace(/\/+$/, '');
  const pub = (process.env.SUPABASE_PUBLIC_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)?.replace(/\/+$/, '');
  if (!server || !pub || server === pub) return url;
  if (url !== server && !url.startsWith(`${server}/`)) return url;
  return pub + url.slice(server.length);
}
