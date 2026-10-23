import { redirect } from 'next/navigation';
import type { SupabaseClient } from '@supabase/supabase-js';

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';
export type CurrentOrg = { orgId: string; role: OrgRole };

export async function getCurrentOrg(client: SupabaseClient): Promise<CurrentOrg | null> {
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return null;
  return currentOrgFor(client, user.id);
}

/**
 * The person's current workspace, by the same rule as the database's private.current_org: the one they last chose
 * while they still belong to it, else their earliest membership. Null when they belong to none.
 */
export async function currentOrgFor(client: SupabaseClient, userId: string): Promise<CurrentOrg | null> {
  // Prefer the workspace the user last chose (profiles.current_org_id) if they
  // still belong to it; otherwise their earliest membership. Mirrors getViewer,
  // so a user who also joined the demo org isn't silently switched to it.
  const { data: profile } = await client
    .from('profiles')
    .select('current_org_id')
    .eq('user_id', userId)
    .maybeSingle();

  let row: { org_id: string; role: string } | null = null;
  if (profile?.current_org_id) {
    const { data } = await client
      .from('org_members')
      .select('org_id, role')
      .eq('user_id', userId)
      .eq('org_id', profile.current_org_id)
      .maybeSingle();
    row = data;
  }
  if (!row) {
    const { data, error } = await client
      .from('org_members')
      .select('org_id, role')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    row = data;
  }

  return row ? { orgId: row.org_id, role: row.role as OrgRole } : null;
}

export async function requireOrg(client: SupabaseClient): Promise<CurrentOrg> {
  const org = await getCurrentOrg(client);
  if (!org) redirect('/onboarding');
  return org;
}
