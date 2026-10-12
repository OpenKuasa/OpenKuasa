import { timeOffApprovals } from '@/lib/people/approvals';
import { ApprovalsScreen } from './approvals-screen';
import { loadPeople } from './parts';

/** Owners and admins, and a manager for their direct reports: anyone else gets the notice and nothing is read. */
export default async function ApproveTimeOffScreen() {
  const { model, viewer } = await loadPeople('approve-time-off', (data, now, ctx) => timeOffApprovals(data, ctx.viewer, now));
  return <ApprovalsScreen queue="time_off" model={model} viewer={viewer} />;
}
