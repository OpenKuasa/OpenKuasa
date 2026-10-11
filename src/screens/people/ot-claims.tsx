import { BarChart3, Clock } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { BarGroup, type Series } from '@/components/charts';
import { NewOvertimeDialog } from '@/components/people/new-overtime-dialog';
import { todayInMalaysia } from '@/lib/people/dates';
import { buildOtModel } from '@/lib/people/requests';
import { rm } from '@/lib/reach/format';
import { Muted, loadPeople } from './parts';
import { MyRequestsScreen, StatusCell, requestCancelCell, requestHeaderAction } from './my-requests';

const dash = '—';
const OT_SERIES: Series[] = [{ key: 'hours', label: 'OT hours', color: 'var(--chart-1)' }];

/** Your own overtime claims. */
export default async function OtClaimsScreen() {
  const { model, viewer } = await loadPeople('ot-claims', async (data, now, ctx) => {
    const today = todayInMalaysia(now);
    // Not linked to an employee: nothing to read, the builder answers "not linked".
    if (ctx.viewer.employeeId === null) return buildOtModel([], ctx.viewer, today);
    return buildOtModel(await data.listOvertime(), ctx.viewer, today);
  });
  const ot = model?.linked ? model : null;
  const month = ot?.overtime.month;
  const hasHistory = (ot?.overtime.by_month ?? []).some((b) => b.value > 0);

  return (
    <MyRequestsScreen
      title="OT Claims"
      subtitle="Your overtime claims and their status"
      laterLabel="Claim OT"
      headerAction={requestHeaderAction({
        model,
        isDemo: viewer.isDemo,
        label: 'Claim OT',
        apply: <NewOvertimeDialog />,
      })}
      model={model}
      kpis={[
        { label: 'OT hours this month', value: month ? month.hours : dash, caption: 'hours' },
        { label: 'OT pay this month', value: month ? rm(month.amount_cents) : dash, caption: 'approved and pending' },
        { label: 'Pending', value: month ? month.pending_hours : dash, caption: 'hours' },
        { label: 'Approved', value: month ? month.approved_hours : dash, caption: 'hours this month' },
      ]}
      summary={
        <>
          <BentoCard
            title="OT by month"
            subtitle="Hours logged"
            icon={BarChart3}
            className="col-span-2 md:col-span-8"
          >
            {!hasHistory ? (
              <Muted>No overtime in the last six months</Muted>
            ) : (
              <BarGroup
                data={(ot?.overtime.by_month ?? []).map((b) => ({ label: b.label, hours: b.value }))}
                series={OT_SERIES}
                height={230}
              />
            )}
          </BentoCard>
          <BentoCard title="By rate" subtitle="Hours and pay per multiplier" icon={Clock} className="col-span-2 md:col-span-4">
            {!ot || ot.overtime.by_rate.length === 0 ? (
              <Muted>No overtime claimed yet</Muted>
            ) : (
              <ul className="divide-y">
                {ot.overtime.by_rate.map((r) => (
                  <li key={r.rate} className="flex items-center gap-3 py-3">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.label}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{r.hours}h</span>
                    <span className="shrink-0 text-right text-sm font-semibold tabular-nums">{rm(r.amount_cents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </BentoCard>
        </>
      }
      tableSubtitle="Overtime claims and their status"
      columns={['Date', 'Hours', 'Day', 'Rate', 'Amount', 'Status', 'Actions']}
      rows={(ot?.rows ?? []).map((r) => ({
        key: r.id,
        cells: [
          r.date,
          <span key="h" className="tabular-nums">{r.hours}</span>,
          r.dayKind,
          r.rate,
          <span key="a" className="tabular-nums">{r.amount}</span>,
          <StatusCell key="s" status={r.status} note={r.note} />,
          <span key="c">{requestCancelCell({ cancellable: r.cancellable, isDemo: viewer.isDemo, kind: 'overtime', id: r.id })}</span>,
        ],
      }))}
      emptyText="You haven't claimed any overtime yet"
    />
  );
}
