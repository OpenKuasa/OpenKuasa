import { overtimeApprovals } from '@/lib/people/approvals';
import { isTeamView } from '@/lib/people/own';
import { ApprovalsScreen } from './approvals-screen';
import { loadPeople } from './parts';

/** Owners and admins only: anyone else gets the notice and nothing is read. */
export default async function ApproveOvertimeScreen() {
  const { model, viewer } = await loadPeople('approve-overtime', async (data, now, ctx) => ({
    queue: await overtimeApprovals(data, ctx.viewer, now),
    // Only a team viewer reads the employee list, for "Add overtime for…".
    employees: isTeamView(ctx.viewer)
      ? (await data.listEmployees()).filter((e) => e.status === 'active').map((e) => ({ id: e.id, name: e.name }))
      : [],
  }));
  return <ApprovalsScreen queue="overtime" model={model?.queue ?? null} viewer={viewer} employees={model?.employees ?? []} />;
}
