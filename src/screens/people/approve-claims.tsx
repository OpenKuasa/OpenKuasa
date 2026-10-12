import { claimApprovals } from '@/lib/people/approvals';
import { isTeamView } from '@/lib/people/own';
import { ApprovalsScreen } from './approvals-screen';
import { loadPeople } from './parts';

/** Owners and admins, and a manager for their direct reports: anyone else gets the notice and nothing is read. */
export default async function ApproveClaimsScreen() {
  const { model, viewer } = await loadPeople('approve-claims', async (data, now, ctx) => ({
    queue: await claimApprovals(data, ctx.viewer, now),
    // Only a team viewer reads the employee list, for "Add claim for…".
    employees: isTeamView(ctx.viewer)
      ? (await data.listEmployees()).filter((e) => e.status === 'active').map((e) => ({ id: e.id, name: e.name }))
      : [],
  }));
  return <ApprovalsScreen queue="claims" model={model?.queue ?? null} viewer={viewer} employees={model?.employees ?? []} />;
}
