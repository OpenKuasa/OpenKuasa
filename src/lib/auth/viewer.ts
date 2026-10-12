import { cache } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import type { OrgRole } from './current-org';
import { MFA_VERIFY_PATH } from './mfa';
import { canSee, type Capability } from './permissions';
import {
  PREVIEW_BLOCKED_MESSAGE,
  deploymentMode,
  hasSupabaseEnv,
} from './preview-mode';

/** The signed-in person and their workspace, as shown in the app chrome. */
export type Viewer = {
  userId: string;
  orgId: string;
  name: string;
  email: string | null;
  initials: string;
  /** Public URL of the uploaded profile photo, if any. */
  avatarUrl: string | null;
  orgName: string;
  role: OrgRole;
  isDemo: boolean;
};

type ViewerUser = {
  id: string;
  email?: string | null;
  is_anonymous?: boolean;
  user_metadata?: Record<string, unknown> | null;
};

// Shown when no Supabase project is configured, so the app still runs
// without credentials: in development, or in production only when preview
// was asked for (see `preview-mode.ts` and `updateSession`).
const PREVIEW_VIEWER: Viewer = {
  userId: 'preview',
  orgId: 'preview',
  name: 'Guest',
  email: null,
  initials: 'G',
  avatarUrl: null,
  orgName: 'Preview workspace',
  role: 'viewer',
  isDemo: true,
};

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0]);
  return letters.join('').toUpperCase() || '?';
}

export function toViewer(
  user: ViewerUser,
  org: { id: string; name: string; role: OrgRole },
  profileName?: string | null,
  avatarUrl: string | null = null,
): Viewer {
  const isDemo = user.is_anonymous === true;
  const email = user.email || null;
  // profiles.full_name is the source of truth; auth metadata is a fallback.
  const fullName = profileName?.trim() || user.user_metadata?.full_name;
  const name =
    typeof fullName === 'string' && fullName.trim()
      ? fullName.trim()
      : isDemo
        ? 'Demo guest'
        : (email?.split('@')[0] ?? 'Member');

  return {
    userId: user.id,
    orgId: org.id,
    name,
    email,
    initials: initialsOf(name),
    avatarUrl,
    orgName: org.name,
    role: org.role,
    isDemo,
  };
}

/** Public URL for a path in the `avatars` storage bucket. */
export function avatarPublicUrl(path: string | null | undefined): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!path || !base) return null;
  return `${base}/storage/v1/object/public/avatars/${path}`;
}

export { hasSupabaseEnv };

/**
 * Resolves the signed-in viewer for the app and account layouts. Sends
 * signed-out visitors to /login and users without a workspace to /onboarding.
 */
export const getViewer = cache(async (): Promise<Viewer> => {
  if (!hasSupabaseEnv()) {
    // The proxy already answers 503 in this state; this covers any request
    // that reaches a page without passing through it.
    if (deploymentMode() === 'blocked') throw new Error(PREVIEW_BLOCKED_MESSAGE);
    return PREVIEW_VIEWER;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // A user with an authenticator must pass it before anything else loads.
  // Users without one skip the extra call entirely.
  if (user.factors?.some((f) => f.status === 'verified')) {
    const { data: aal } =
      await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel !== 'aal2') redirect(MFA_VERIFY_PATH);
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, avatar_path, current_org_id')
    .eq('user_id', user.id)
    .maybeSingle();

  // RLS lets a member read every row of their org, so scope to the caller.
  const memberships = () =>
    supabase
      .from('org_members')
      .select('role, orgs(id, name)')
      .eq('user_id', user.id);

  // Prefer the workspace the user last chose, if they still belong to it.
  let membership = profile?.current_org_id
    ? (await memberships().eq('org_id', profile.current_org_id).maybeSingle())
        .data
    : null;
  if (!membership) {
    const { data, error } = await memberships()
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    membership = data;
  }
  if (!membership) redirect('/onboarding');

  const org = (
    Array.isArray(membership.orgs) ? membership.orgs[0] : membership.orgs
  ) as { id: string; name: string } | null | undefined;
  if (!org) redirect('/onboarding');

  return toViewer(
    user,
    { id: org.id, name: org.name, role: membership.role as OrgRole },
    profile?.full_name,
    avatarPublicUrl(profile?.avatar_path),
  );
});

/** Page guard: members without the capability are sent back to account home. */
export async function requireAccess(capability: Capability): Promise<Viewer> {
  const viewer = await getViewer();
  if (!canSee(viewer, capability)) redirect('/account');
  return viewer;
}
