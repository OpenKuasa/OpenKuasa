/**
 * What the consent screen and its actions share: the plain messages, the shape of a request id, and the check that
 * the person in front of the screen may answer it (signed in, not the demo, second factor done).
 */

import 'server-only';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { getMfaStatus, mfaVerifyHref } from '@/lib/auth/mfa';
import { createClient } from '@/lib/supabase/server';

export const NOT_VALID = 'This sign-in link is not valid. Start connecting again from your AI tool.';
export const EXPIRED = 'This sign-in request has expired. Start connecting again from your AI tool.';
export const OTHER_ACCOUNT = 'This sign-in request is for another account. Sign out, then connect again from your AI tool.';
export const DEMO = "The demo can't connect to AI tools. Sign in with your own OpenKuasa account.";
export const NO_WORKSPACE = 'Open a workspace in OpenKuasa first, then connect again from your AI tool.';
export const WORKSPACE_CHANGED = 'Your open workspace changed. Reload this page to see which workspace you are allowing.';
export const FAILED = 'Could not connect just now. Try again.';

/** The auth server's request id goes into its URL path: letters, digits, `-` and `_` only. */
const AUTHORIZATION_ID = /^[A-Za-z0-9_-]{1,200}$/;

export function authorizationIdOf(value: unknown): string | null {
  return typeof value === 'string' && AUTHORIZATION_ID.test(value) ? value : null;
}

export function consentPath(authorizationId: string): string {
  return `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`;
}

export type Gate =
  | { kind: 'ok'; supabase: SupabaseClient; user: User }
  | { kind: 'redirect'; to: string }
  | { kind: 'refuse'; message: string };

/**
 * The person answering this request, with their own cookie session. Signed-out visitors go to sign-in and a session
 * that still owes its code goes to the code prompt, both coming back to this request; demo guests are refused.
 */
export async function answeringPerson(authorizationId: string): Promise<Gate> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: 'redirect', to: `/login?next=${encodeURIComponent(consentPath(authorizationId))}` };
  if (user.is_anonymous) return { kind: 'refuse', message: DEMO };
  if ((await getMfaStatus(supabase)).challengeRequired) {
    return { kind: 'redirect', to: mfaVerifyHref(consentPath(authorizationId)) };
  }
  return { kind: 'ok', supabase, user };
}
