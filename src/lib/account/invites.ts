import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrgRole } from '@/lib/auth/current-org';

// Kept free of server-only imports so the client forms can share the role
// list, types and messages.

/** Roles an invite or a role change may grant; ownership is never handed out. */
export const INVITE_ROLES = ['admin', 'member', 'viewer'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export type PendingInvite = {
  id: string;
  email: string;
  role: InviteRole;
  token: string;
  expiresAt: string;
};

/** What the public accept page knows about an invite link. */
export type InviteDetails = {
  orgName: string;
  email: string;
  role: OrgRole;
  status: InviteStatus;
};

export type TeamActionState =
  | { error?: string; notice?: string; link?: string; email?: string }
  | undefined;

export type InviteAcceptState =
  | { error?: string; notice?: string; fullName?: string }
  | undefined;

export const TEAM_DEMO_ERROR =
  'The demo workspace is read-only. Sign up to manage a team.';
export const TEAM_ROLE_ERROR = 'Only owners and admins can manage members.';

/** Shown after sign-up from an invite while the address still has to be confirmed. */
export const INVITE_CONFIRM_NOTICE =
  'Check your email to confirm your address. The link in that email brings you back to this invite, where you can join.';

/** Shown when someone tries to join before confirming the invited address. */
export const INVITE_CONFIRM_FIRST =
  'Confirm your email address first: open the link we emailed you, then come back to this invite to join.';

// Messages raised by the invite and member database functions.
const RPC_MESSAGES: Record<string, string> = {
  'not authenticated': 'Please sign in and try again.',
  'second factor required':
    'Enter the code from your authenticator app first, then try again.',
  'not allowed': TEAM_ROLE_ERROR,
  'invalid role': 'Please choose a valid role.',
  'invalid email': 'Please enter a valid email address.',
  'already a member': 'That person is already a member of this workspace.',
  'invite not found': 'This invite link is not valid.',
  'invite no longer valid':
    'This invite has expired or was already used. Ask for a new one.',
  'invite is for another email':
    'This invite was sent to a different email address.',
  'email not confirmed': INVITE_CONFIRM_FIRST,
  'cannot change your own role': 'You cannot change your own role.',
  'cannot change the owner': 'The owner’s role cannot be changed.',
  'not a member': 'That person is no longer a member of this workspace.',
  'cannot remove yourself': 'You cannot remove yourself from the workspace.',
  'cannot remove the owner': 'The owner cannot be removed.',
};

/** Turns a database error into a sentence that is safe to show. */
export function friendlyRpcError(
  error: { message?: string | null } | null | undefined,
  fallback = 'Something went wrong. Please try again.',
): string {
  const message = error?.message?.trim().toLowerCase() ?? '';
  return RPC_MESSAGES[message] ?? fallback;
}

/** Why an invite link cannot be used, or null while it is still pending. */
export function inviteProblem(status: InviteStatus): string | null {
  switch (status) {
    case 'pending':
      return null;
    case 'accepted':
      return 'This invite has already been accepted. Sign in to open the workspace.';
    case 'revoked':
      return 'This invite was cancelled. Ask the person who invited you for a new link.';
    case 'expired':
      return 'This invite has expired. Ask the person who invited you for a new link.';
  }
}

export function isPendingInvite(
  invite: {
    accepted_at: string | null;
    revoked_at: string | null;
    expires_at: string;
  },
  now: Date = new Date(),
): boolean {
  return (
    invite.accepted_at === null &&
    invite.revoked_at === null &&
    new Date(invite.expires_at).getTime() > now.getTime()
  );
}

/** Absolute origin of the current request, from its headers. */
export function originFromHeaders(h: {
  get(name: string): string | null;
}): string {
  const origin = h.get('origin');
  if (origin) return origin;
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'https';
  return host ? `${proto}://${host}` : 'https://openkuasa.com';
}

export function inviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/invite/${token}`;
}

/**
 * Where the confirmation email sends someone who signed up from an invite:
 * through the link check, then back to the same invite, signed in.
 */
export function inviteConfirmUrl(origin: string, token: string): string {
  const next = encodeURIComponent(`/invite/${token}`);
  return `${origin.replace(/\/+$/, '')}/auth/confirm?next=${next}`;
}

/** Open invites for a workspace. RLS only returns rows to its owners and admins. */
export async function getPendingInvites(
  supabase: SupabaseClient,
  orgId: string,
): Promise<PendingInvite[]> {
  const { data, error } = await supabase
    .from('org_invites')
    .select('id, email, role, token, expires_at, accepted_at, revoked_at')
    .eq('org_id', orgId)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;

  return (data ?? [])
    .filter((row) => isPendingInvite(row))
    .map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role as InviteRole,
      token: row.token,
      expiresAt: row.expires_at,
    }));
}

/** Looks up an invite by its token; works signed-out. Null when unknown. */
export async function getInvite(
  supabase: SupabaseClient,
  token: string,
): Promise<InviteDetails | null> {
  const { data, error } = await supabase.rpc('get_invite', { p_token: token });
  if (error) return null;
  const row = (Array.isArray(data) ? data[0] : data) as
    | { org_name: string; email: string; role: string; status: string }
    | null
    | undefined;
  if (!row) return null;
  return {
    orgName: row.org_name,
    email: row.email,
    role: row.role as OrgRole,
    status: row.status as InviteStatus,
  };
}
