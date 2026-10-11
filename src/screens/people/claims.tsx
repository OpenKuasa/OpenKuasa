import { PieChart, Wallet } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { DonutStat, type Slice } from '@/components/charts';
import { NewClaimDialog } from '@/components/people/new-claim-dialog';
import { ReceiptLink } from '@/components/people/receipt-link';
import { Progress } from '@/components/ui/progress';
import { todayInMalaysia } from '@/lib/people/dates';
import { buildClaimsModel } from '@/lib/people/requests';
import { rm } from '@/lib/reach/format';
import { DEPARTMENT_COLORS, Muted, loadPeople } from './parts';
import { MyRequestsScreen, StatusCell, requestCancelCell, requestHeaderAction } from './my-requests';

const dash = '—';

/** Your own expense claims. */
export default async function ClaimsScreen() {
  const { model, viewer } = await loadPeople('claims', async (data, now, ctx) => {
    const today = todayInMalaysia(now);
    // Not linked to an employee: nothing to read, the builder answers "not linked".
    if (ctx.viewer.employeeId === null) return buildClaimsModel([], ctx.viewer, today);
    return buildClaimsModel(await data.listClaims(), ctx.viewer, today);
  });
  const claims = model?.linked ? model : null;

  const slices: Slice[] = (claims?.by_category ?? []).map((c, index) => ({
    key: c.category,
    label: c.label,
    value: c.cents / 100,
    color: DEPARTMENT_COLORS[index % DEPARTMENT_COLORS.length],
  }));

  return (
    <MyRequestsScreen
      title="Financial Claims"
      subtitle="Your expense claims and their status"
      laterLabel="New Claim"
      headerAction={requestHeaderAction({
        model,
        isDemo: viewer.isDemo,
        label: 'New Claim',
        apply: <NewClaimDialog />,
      })}
      model={model}
      kpis={[
        { label: 'Claimed this month', value: claims ? rm(claims.claimed_cents) : dash },
        { label: 'Approved', value: claims ? rm(claims.approved_cents) : dash, caption: 'this month' },
        {
          label: 'Pending',
          value: claims ? rm(claims.pending_cents) : dash,
          caption: claims ? `${claims.pending_count} ${claims.pending_count === 1 ? 'claim' : 'claims'}` : undefined,
        },
      ]}
      summary={
        <>
          <BentoCard
            title="Claims by category"
            subtitle="This month"
            icon={PieChart}
            className="col-span-2 md:col-span-5"
          >
            {slices.length === 0 ? (
              <Muted>No claims this month</Muted>
            ) : (
              <DonutStat
                data={slices}
                height={230}
                centerValue={rm(claims?.claimed_cents ?? 0)}
                centerLabel="claimed"
              />
            )}
          </BentoCard>
          <BentoCard
            title="Spend by category"
            subtitle="Share of this month's claims"
            icon={Wallet}
            className="col-span-2 md:col-span-7"
          >
            {!claims || claims.by_category.length === 0 ? (
              <Muted>No claims this month</Muted>
            ) : (
              <ul className="flex flex-col gap-4 py-1">
                {claims.by_category.map((c) => (
                  <li key={c.category}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{c.label}</span>
                      <span className="tabular-nums text-muted-foreground">{rm(c.cents)}</span>
                    </div>
                    <Progress value={c.percent ?? 0} className="mt-2 h-1.5" />
                  </li>
                ))}
              </ul>
            )}
          </BentoCard>
        </>
      }
      tableSubtitle="Expense claims and their status"
      columns={['Category', 'Amount', 'Date', 'Receipt', 'Status', 'Actions']}
      rows={(claims?.rows ?? []).map((r) => ({
        key: r.id,
        cells: [
          r.category,
          <span key="a" className="tabular-nums">{r.amount}</span>,
          r.date,
          <ReceiptLink key="r" claimId={r.id} hasFile={r.hasFile && !viewer.isDemo} ticked={r.receipt} />,
          <span key="s" className="flex flex-col gap-1">
            <StatusCell status={r.status} note={r.note} />
            {r.paidOn ? <span className="text-xs text-muted-foreground">Paid on {r.paidOn}</span> : null}
          </span>,
          <span key="c">{requestCancelCell({ cancellable: r.cancellable, isDemo: viewer.isDemo, kind: 'claim', id: r.id })}</span>,
        ],
      }))}
      emptyText="You haven't made any claims yet"
    />
  );
}
