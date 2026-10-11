import { PieChart, Scale } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { DonutStat, type Slice } from '@/components/charts';
import { ApplyLeaveDialog } from '@/components/people/apply-leave-dialog';
import { Progress } from '@/components/ui/progress';
import { todayInMalaysia } from '@/lib/people/dates';
import { buildLeaveModel } from '@/lib/people/requests';
import { DEPARTMENT_COLORS, Muted, loadPeople } from './parts';
import { MyRequestsScreen, StatusCell, requestCancelCell, requestHeaderAction } from './my-requests';

const dash = '—';

/** Your own leave: balances, what you have taken and every request you made. */
export default async function LeaveScreen() {
  const { model, viewer } = await loadPeople('leave', async (data, now, ctx) => {
    const today = todayInMalaysia(now);
    // Not linked to an employee: nothing to read, the builder answers "not linked".
    if (ctx.viewer.employeeId === null) return buildLeaveModel([], [], ctx.viewer, today);
    const [requests, balances] = await Promise.all([
      data.listLeaveRequests(),
      data.listLeaveBalances(Number(today.slice(0, 4))),
    ]);
    return buildLeaveModel(requests, balances, ctx.viewer, today);
  });
  const leave = model?.linked ? model : null;

  const slices: Slice[] = (leave?.by_type ?? []).map((t, index) => ({
    key: t.leave_type,
    label: t.label,
    value: t.days,
    color: DEPARTMENT_COLORS[index % DEPARTMENT_COLORS.length],
  }));

  return (
    <MyRequestsScreen
      title="Leave"
      subtitle="Your leave balance and requests"
      laterLabel="Apply Leave"
      headerAction={requestHeaderAction({
        model,
        isDemo: viewer.isDemo,
        label: 'Apply Leave',
        apply: <ApplyLeaveDialog />,
      })}
      model={model}
      kpis={[
        {
          label: 'Annual balance',
          value: leave?.annual ? leave.annual.remaining : dash,
          caption: leave?.annual ? `of ${leave.annual.entitled} days` : undefined,
        },
        { label: 'Used this year', value: leave ? leave.used_ytd : dash, caption: 'days approved' },
        { label: 'Pending', value: leave ? leave.pending : dash, caption: leave?.pending === 1 ? 'request' : 'requests' },
        {
          label: 'Medical leave taken',
          value: leave?.medical ? leave.medical.taken : dash,
          caption: leave?.medical ? `of ${leave.medical.entitled} days` : undefined,
        },
      ]}
      summary={
        <>
          <BentoCard
            title="Leave used by type"
            subtitle="This year · approved days"
            icon={PieChart}
            className="col-span-2 md:col-span-5"
          >
            {slices.length === 0 ? (
              <Muted>No leave taken this year</Muted>
            ) : (
              <DonutStat
                data={slices}
                height={230}
                centerValue={String(leave?.used_ytd ?? 0)}
                centerLabel="days taken"
              />
            )}
          </BentoCard>
          <BentoCard
            title="Entitlement used"
            subtitle="Days taken of your yearly entitlement"
            icon={Scale}
            className="col-span-2 md:col-span-7"
          >
            {!leave || leave.balances.length === 0 ? (
              <Muted>No leave balances recorded for this year</Muted>
            ) : (
              <ul className="flex flex-col gap-4 py-1">
                {leave.balances.map((b) => (
                  <li key={b.leave_type}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{b.label}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {b.used} / {b.entitled} days
                      </span>
                    </div>
                    <Progress value={b.percent ?? 0} className="mt-2 h-1.5" />
                  </li>
                ))}
              </ul>
            )}
            {leave && leave.unpaid_days > 0 ? (
              <p className="mt-4 text-xs text-muted-foreground">Unpaid leave: {leave.unpaid_days} days</p>
            ) : null}
          </BentoCard>
        </>
      }
      tableSubtitle="Leave applications and their status"
      columns={['Type', 'From', 'To', 'Days', 'Status', 'Applied', 'Actions']}
      rows={(leave?.rows ?? []).map((r) => ({
        key: r.id,
        cells: [r.type, r.from, r.to, <span key="d" className="tabular-nums">{r.days}</span>, <StatusCell key="s" status={r.status} note={r.note} />, <span key="a" className="text-muted-foreground">{r.applied}</span>, <span key="c">{requestCancelCell({ cancellable: r.cancellable, isDemo: viewer.isDemo, kind: 'leave', id: r.id })}</span>],
      }))}
      emptyText="You haven't applied for any leave yet"
    />
  );
}
