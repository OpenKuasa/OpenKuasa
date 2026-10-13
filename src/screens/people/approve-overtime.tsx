import { overtimeApprovals } from '@/lib/people/approvals';
import { isTeamView } from '@/lib/people/own';
import { readTeamOvertime } from '@/lib/people/supabase';
import { teamScreenView } from '@/lib/people/tier';
import { ApprovalsScreen } from './approvals-screen';
import { loadPeople } from './parts';

/** Owners and admins, and a manager for their direct reports: anyone else gets the notice and nothing is read. */
export default async function ApproveOvertimeScreen() {
  const { model, viewer } = await loadPeople('approve-overtime', async (data, now, ctx) => ({
    // A manager's rows come from the pay-free function, never the table; HR and the demo read the table.
    queue: await overtimeApprovals(
      data,
      ctx.viewer,
      now,
      teamScreenView(ctx.viewer) === 'manager' && ctx.orgId ? await readTeamOvertime(ctx.client, ctx.orgId) : null,
    ),
    // Only a team viewer reads the employee list, for "Add overtime for…".
    employees: isTeamView(ctx.viewer)
      ? (await data.listEmployees()).filter((e) => e.status === 'active').map((e) => ({ id: e.id, name: e.name }))
      : [],
  }));
  return <ApprovalsScreen queue="overtime" model={model?.queue ?? null} viewer={viewer} employees={model?.employees ?? []} />;
}
