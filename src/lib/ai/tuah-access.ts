/**
 * The access Tuah's tools run with, built once for every way in (the chat route and MCP).
 * Each product gets what the caller's own session may do: a viewer gets no change tools,
 * and every change still waits for approval downstream.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { errorCodeOf } from '@/lib/ai/call-log';
import { ensureCrmPipeline, loadRequireLostReason, type CrmAccess } from '@/lib/ai/crm-tools';
import type { FinanceAccess, HireAccess, PeopleAccess, ReachAccess } from '@/lib/ai/agents/orchestrator';
import { peopleWriteFor, type ReceiptFile } from '@/lib/ai/people-tools';
import type { OrgRole } from '@/lib/auth/current-org';
import { can } from '@/lib/auth/permissions';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { createCvReader } from '@/lib/hire/cv-read';
import { getHireData } from '@/lib/hire/supabase';
import { createSupabasePeopleData } from '@/lib/people/supabase';
import { getPeopleViewer } from '@/lib/people/viewer';
import { getReachData } from '@/lib/reach/supabase';

export type TuahAccess = {
  reach: ReachAccess;
  crm: CrmAccess | null;
  hire: HireAccess;
  people: PeopleAccess | null;
  finance: FinanceAccess | null;
};

export async function buildTuahAccess(args: {
  supabase: SupabaseClient;
  org: { orgId: string; role: OrgRole } | null;
  userId: string;
  origin: string | null;
  /** Give Lekir a CV reader (the team, or MCP). The single agent is given no way to read a CV. */
  withCvReader: boolean;
  /** The receipt attached to the question, if any. */
  receipt: ReceiptFile | null;
}): Promise<TuahAccess> {
  const { supabase, org, userId, origin, withCvReader, receipt } = args;

  const data = await getReachData(supabase);
  // Only a non-viewer member gets change tools (and each still needs approval).
  // Scheduling the agent commits the workspace to spend, so that one is owner/admin only.
  const write =
    org && org.role !== 'viewer'
      ? {
          ctx: { client: supabase, orgId: org.orgId },
          canWrite: true,
          canManageAgents: can(org.role, 'manage-agents'),
        }
      : undefined;
  const reach: ReachAccess = { data, write };

  const hireData = await getHireData(supabase);
  // Lekir's change tools need the same write access as Jebat's.
  const hireBase = { data: hireData, write, origin };
  // Only Lekir, asked as a specialist, reads a CV: the single agent is given no way to.
  // The file is read with the member's own client, never the service role, and waits on a
  // shelf that belongs to this request alone until Lekir's model is shown it.
  const hire: HireAccess = withCvReader
    ? { ...hireBase, files: createCvReader(hasSupabaseEnv() ? supabase : null, hireData), cvShelf: [] }
    : hireBase;
  const crm = org
    ? {
        client: supabase,
        orgId: org.orgId,
        userId,
        canWrite: org.role !== 'viewer',
        // The workspace's lost-reason rule, so Tuah asks for a reason before offering to mark a deal lost.
        requireLostReason: org.role !== 'viewer' ? await loadRequireLostReason(supabase, org.orgId) : false,
      }
    : null;

  // A new workspace gets its starting pipeline here, as on the Deals screen: the lookups themselves never write.
  if (crm?.canWrite) await ensureCrmPipeline(supabase, crm.orgId);

  // HR is workspace-only, like the CRM: no workspace, no HR this turn (never the
  // sample data, and never a crash — a failed viewer load just drops HR).
  // Rows are the caller's own session's, so the database decides who sees what.
  // `peopleWriteFor` makes the one write-access decision both chat routes share, so a manager
  // gets their team's decide tools here just as on the screens and in Ask-Lekiu.
  let people: PeopleAccess | null = null;
  if (org) {
    try {
      const viewer = await getPeopleViewer(supabase, org);
      const peopleData = createSupabasePeopleData(supabase, org.orgId);
      const peopleWrite = peopleWriteFor(viewer, { client: supabase, orgId: org.orgId }, receipt, userId);
      people = { data: peopleData, viewer, write: peopleWrite };
    } catch (error) {
      console.error('[tuah] HR unavailable this turn:', errorCodeOf(error));
      people = null;
    }
  }

  // Finance is workspace-only, like the CRM: a non-viewer member gets the change tools (each still approved).
  const finance = org ? { client: supabase, orgId: org.orgId, canWrite: org.role !== 'viewer' } : null;

  return { reach, crm, hire, people, finance };
}
