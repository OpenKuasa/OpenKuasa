import { leaveApprovals } from '@/lib/people/approvals';
import { isTeamView } from '@/lib/people/own';
import { ApprovalsScreen } from './approvals-screen';
import { loadPeople } from './parts';

/** Owners and admins only: anyone else gets the notice and nothing is read. */
export default async function ApproveLeaveScreen() {
  const { model, viewer } = await loadPeople('approve-leave', async (data, now, ctx) => ({
    queue: await leaveApprovals(data, ctx.viewer, now),
    // Only a team viewer reads the employee list, for "Add leave for…".
    employees: isTeamView(ctx.viewer)
      ? (await data.listEmployees()).filter((e) => e.status === 'active').map((e) => ({ id: e.id, name: e.name }))
      : [],
  }));
  return <ApprovalsScreen queue="leave" model={model?.queue ?? null} viewer={viewer} employees={model?.employees ?? []} />;
}
