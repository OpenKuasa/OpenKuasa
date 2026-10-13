import type { SupabaseClient } from '@supabase/supabase-js';
import type { CurrentOrg } from '@/lib/auth/current-org';
import { can } from '@/lib/auth/permissions';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { readMyTeam } from './my-team';
import { DEMO_EMPLOYEE_ID, DEMO_ORG_SLUG, type PeopleViewer } from './types';

/** No project configured (dev, preview, tests): the sample company, seen as a demo visitor sees it. */
export const PREVIEW_PEOPLE_VIEWER: PeopleViewer = { employeeId: DEMO_EMPLOYEE_ID, isHr: false, isDemo: true };
/** Signed in but in no workspace. */
export const NO_WORKSPACE_VIEWER: PeopleViewer = { employeeId: null, isHr: false, isDemo: false };

/**
 * Who is looking at Lekiu. This is for wording and defaults only: which rows
 * someone may read is decided by the database, not by anything returned here.
 * "Demo" means the current workspace is the demo workspace, which is the same
 * condition the database policies use, so a real account that has opened the
 * demo sees what an anonymous guest sees.
 */
export async function getPeopleViewer(client: SupabaseClient, org: CurrentOrg | null): Promise<PeopleViewer> {
  if (!hasSupabaseEnv()) return PREVIEW_PEOPLE_VIEWER;
  if (!org) return NO_WORKSPACE_VIEWER;

  const {
    data: { user },
  } = await client.auth.getUser();
  const isHr = can(org.role, 'approve');
  const [workspace, linked, team] = await Promise.all([
    client.from('orgs').select('slug').eq('id', org.orgId).maybeSingle(),
    user
      ? client.from('hr_employees').select('id,name').eq('org_id', org.orgId).eq('user_id', user.id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    // Only a caller who is not an owner or admin can be a manager here. A failed read is "no team".
    isHr ? Promise.resolve([] as string[]) : readMyTeam(client, org.orgId),
  ]);
  if (workspace.error) throw workspace.error;
  if (linked.error) throw linked.error;

  const isDemo = workspace.data?.slug === DEMO_ORG_SLUG;
  const linkedRow = linked.data as { id: string; name?: string | null } | null;
  return {
    employeeId: linkedRow?.id ?? (isDemo ? DEMO_EMPLOYEE_ID : null),
    isHr,
    isDemo,
    // Left out, not false, for everyone else: callers compare viewers whole.
    ...(!isHr && !isDemo && linkedRow && team.length > 0 ? { managesTeam: true } : {}),
    // Left out, not false, for everyone but the owner: callers compare viewers whole.
    ...(org.role === 'owner' && !isDemo ? { isOwner: true } : {}),
    // Left out, not null, when unknown: callers compare viewers whole.
    ...(linkedRow?.name ? { employeeName: linkedRow.name } : {}),
  };
}
