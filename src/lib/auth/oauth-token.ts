/**
 * Telling a Supabase OAuth access token (issued to an AI tool through "Sign in with OpenKuasa") from an app session.
 *
 * Such a token is a full session of the person, so only the MCP endpoint may accept it: never the app's cookie
 * session, never key making. The claims are read without checking the signature, so this only ever refuses;
 * nothing is granted on what it says.
 */

/** A JWT's payload claims, unverified; null when it is not a JWT with an object payload. */
export function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** True when the access token was issued to an OAuth client (it carries a top-level `client_id` claim). */
export function isOAuthClientToken(accessToken: string | null | undefined): boolean {
  if (typeof accessToken !== 'string' || !accessToken) return false;
  const claims = jwtClaims(accessToken);
  return !!claims && claims.client_id !== undefined && claims.client_id !== null;
}
