import 'server-only';
import { getCompany } from '@/lib/account/data';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { createClient } from '@/lib/supabase/server';

/** What every product's Settings shows first: the workspace, which is changed in Account. */
export type WorkspaceOverview = {
  companyName: string;
  registrationNo: string;
  /** null when the count could not be read: shown as unknown, never as zero. */
  members: number | null;
  /** False when the viewer can only look at the company in Account; the card's link then says View. */
  canEdit?: boolean;
};

/** The sample workspace, for screens running without a database. */
export const SAMPLE_WORKSPACE: WorkspaceOverview = {
  companyName: 'Rimba Ventures Sdn Bhd',
  registrationNo: '202601012345',
  members: 3,
};

/**
 * The company and member count for the Workspace card. Never throws: a failed company read returns null so
 * the card says it couldn't load rather than showing the wrong company; a failed count shows as unknown.
 */
export async function loadWorkspaceOverview(): Promise<WorkspaceOverview | null> {
  if (!hasSupabaseEnv()) return SAMPLE_WORKSPACE;
  try {
    const { orgId, isDemo, role } = await getViewer();
    const supabase = await createClient();
    const [company, count] = await Promise.all([
      getCompany(),
      supabase.from('org_members').select('user_id', { count: 'exact', head: true }).eq('org_id', orgId),
    ]);
    return {
      companyName: company.name,
      registrationNo: company.registrationNo,
      // Every demo visitor joins the one demo workspace, so its head count means nothing.
      members: isDemo || count.error ? null : (count.count ?? 0),
      canEdit: !isDemo && can(role, 'manage-company'),
    };
  } catch (error) {
    console.error('[settings] could not load the workspace overview', error);
    return null;
  }
}
