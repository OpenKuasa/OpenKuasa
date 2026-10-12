import {
  BadgeCheck,
  Bot,
  CreditCard,
  Filter,
  Gauge,
  HandCoins,
  PieChart,
  TrendingUp,
  Users,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import {
  AreaTrend,
  BarGroup,
  DonutStat,
  FunnelFlow,
  RadialGauge,
  Sparkline,
  type Series,
  type Slice,
} from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { AskBendaharaHero } from '@/components/finance/ask-bendahara-hero';
import { createClient } from '@/lib/supabase/server';
import { isLiveChatAllowed } from '@/lib/ai/access';
import { getViewer } from '@/lib/auth/viewer';
import { listBills } from '@/lib/finance/bills';
import { rm } from '@/lib/finance/format';
import { listInvoices } from '@/lib/finance/invoices';
import { buildFinanceOverview, type FinanceOverview } from '@/lib/finance/overview';
import { displayDate, todayUtc } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

/* ---- mock data (Rimba Ventures Sdn Bhd · 201901027453) ------------ */

/** Operational cash in vs out, weekly (RM k). Distinct from the monthly
 *  balance trend on the Dashboard. */
const CASHFLOW_TREND = [
  { label: 'Wk1', inflow: 9.2, outflow: 6.1 },
  { label: 'Wk2', inflow: 11.4, outflow: 7.0 },
  { label: 'Wk3', inflow: 8.6, outflow: 5.4 },
  { label: 'Wk4', inflow: 12.8, outflow: 8.2 },
  { label: 'Wk5', inflow: 10.5, outflow: 6.8 },
  { label: 'Wk6', inflow: 13.2, outflow: 7.9 },
  { label: 'Wk7', inflow: 11.8, outflow: 7.1 },
  { label: 'Wk8', inflow: 14.0, outflow: 8.6 },
];
const CASHFLOW_SERIES: Series[] = [
  { key: 'inflow', label: 'Cash in (RM k)', color: 'var(--chart-2)' },
  { key: 'outflow', label: 'Cash out (RM k)', color: 'var(--chart-3)' },
];

/** Revenue by category, this month (RM k) — sums to 42.8 = Revenue MTD. */
const REVENUE_BY_CATEGORY: Slice[] = [
  { key: 'services', label: 'Services', value: 18.4, color: 'var(--chart-1)' },
  { key: 'projects', label: 'Projects', value: 12.2, color: 'var(--chart-2)' },
  { key: 'supplies', label: 'Supplies', value: 8.0, color: 'var(--chart-5)' },
  { key: 'maintenance', label: 'Maintenance', value: 4.2, color: 'var(--chart-3)' },
];

/** Collections funnel — invoice counts (not RM). */
const COLLECTIONS: Slice[] = [
  { key: 'issued', label: 'Issued', value: 164, color: 'var(--chart-1)' },
  { key: 'sent', label: 'Sent', value: 150, color: 'var(--chart-2)' },
  { key: 'viewed', label: 'Viewed', value: 128, color: 'var(--chart-5)' },
  { key: 'paid', label: 'Paid', value: 106, color: 'var(--chart-4)' },
];

/** Outstanding (AR) by customer (RM k) — sums to 16.9 = Outstanding KPI.
 *  Not due 9.7 (Siti + Zaki) + overdue 7.2 (Nurul + Hakim + Lestari); ties to
 *  the Dashboard's AR ageing buckets (9.7 / 4.2 / 2.0 / 1.0). */
const AR_BY_CUSTOMER = [
  { label: 'Siti Decor', amount: 6.2 },
  { label: 'Nurul Boutique', amount: 4.2 },
  { label: 'Zaki Enterprise', amount: 3.5 },
  { label: 'Hakim Logistics', amount: 2.0 },
  { label: 'Lestari Group', amount: 1.0 },
];
const AR_SERIES: Series[] = [
  { key: 'amount', label: 'Outstanding (RM k)', color: 'var(--chart-2)' },
];

type Receivable = { id: string; customer: string; amount: string; age: string; overdue: boolean };
/** Past-due invoices — sum RM 7,200 = the 1–30d + 31–60d + 60d+ ageing buckets. */
const RECEIVABLES: Receivable[] = [
  { id: 'INV-1040', customer: 'Nurul Boutique', amount: 'RM 4,200', age: '12 days overdue', overdue: true },
  { id: 'INV-1037', customer: 'Hakim Logistics', amount: 'RM 2,000', age: '38 days overdue', overdue: true },
  { id: 'INV-1029', customer: 'Lestari Group', amount: 'RM 1,000', age: '65 days overdue', overdue: true },
];

type Bill = { id: string; supplier: string; amount: string; due: string };
/** Upcoming supplier bills — sums to RM 9,300 = Payable (AP) KPI. */
const UPCOMING_BILLS: Bill[] = [
  { id: 'BILL-304', supplier: 'Lim Hardware', amount: 'RM 3,300', due: '14 Oct' },
  { id: 'BILL-302', supplier: 'Nusantara Logistics', amount: 'RM 2,800', due: '18 Oct' },
  { id: 'BILL-301', supplier: 'Langkawi Fresh', amount: 'RM 1,900', due: '22 Oct' },
  { id: 'BILL-299', supplier: 'Seri Mutiara Enterprise', amount: 'RM 1,300', due: '28 Oct' },
];

type EInvoiceStatus = 'Validated' | 'Pending' | 'Rejected';
type EInvoiceRow = { id: string; customer: string; status: EInvoiceStatus };
const EINVOICE: EInvoiceRow[] = [
  { id: 'INV-1042', customer: 'Aisyah Trading', status: 'Validated' },
  { id: 'INV-1041', customer: 'Zaki Enterprise', status: 'Validated' },
  { id: 'INV-1040', customer: 'Nurul Boutique', status: 'Pending' },
  { id: 'INV-1039', customer: 'Lim Hardware', status: 'Validated' },
  { id: 'INV-1037', customer: 'Hakim Logistics', status: 'Rejected' },
];
const EINVOICE_PILL: Record<EInvoiceStatus, string> = {
  Validated: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  Pending: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  Rejected: 'bg-red-500/15 text-red-600 dark:text-red-400',
};

const EINVOICE_LABEL: Record<'validated' | 'pending' | 'rejected', EInvoiceStatus> = {
  validated: 'Validated',
  pending: 'Pending',
  rejected: 'Rejected',
};

const AGENTS = [
  { name: 'Invoice Chaser', active: true },
  { name: 'Receipt Reader', active: true },
  { name: 'Reconciler', active: true },
  { name: 'e-Invoice Submitter', active: true },
  { name: 'Cashflow Forecaster', active: false },
  { name: 'Tax Estimator', active: false },
];

const PROMPTS = [
  'Overdue invoices',
  'Who owes us the most?',
  'Draft an invoice',
  'Unpaid supplier bills',
];

const AR_LIVE_SERIES: Series[] = [
  { key: 'amount', label: 'Outstanding (RM)', color: 'var(--chart-2)' },
];

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function overdueAge(days: number): string {
  if (days <= 0) return 'Due today';
  return `${days} day${days === 1 ? '' : 's'} overdue`;
}

/* ------------------------------------------------------------------ */

export default async function OverviewScreen() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isDemo = !isLiveChatAllowed(user);

  // A signed-in person sees only their own workspace's figures. Anything with no real
  // source yet shows "Not available yet" rather than the sample numbers.
  let model: FinanceOverview | null = null;
  if (!isDemo) {
    try {
      const viewer = await getViewer();
      const ctx = { client: supabase, orgId: viewer.orgId };
      const [invoices, bills] = await Promise.all([listInvoices(ctx), listBills(ctx)]);
      model = buildFinanceOverview(invoices, bills, todayUtc());
    } catch (e) {
      console.error('[finance/assistant] data error:', e);
    }
  }
  const failed = <Muted>Couldn&apos;t load your dashboard — please refresh</Muted>;
  const na = <Muted>Not available yet</Muted>;
  const live = (children: (m: FinanceOverview) => React.ReactNode, empty: string) =>
    !model ? failed : model.isEmpty ? <Muted>{empty}</Muted> : children(model);

  return (
    <ScreenContainer>
      <BentoGrid>
        {/* Ask-Bendahara hero */}
        <BentoCard tone="primary" className="col-span-2 md:col-span-12">
          <AskBendaharaHero prompts={PROMPTS} isDemo={isDemo} />
        </BentoCard>

        {/* KPI row */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          {isDemo ? (
            <BentoStat
              label="Cash balance"
              value="RM 84,200"
              delta="+6%"
              onPrimary
              chart={
                <Sparkline
                  data={[71, 74, 72, 78, 80, 81, 83, 84]}
                  color="var(--primary-foreground)"
                  height={36}
                />
              }
            />
          ) : (
            <BentoStat label="Cash balance" value="—" delta="Not available yet" deltaTone="flat" onPrimary />
          )}
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          {isDemo ? (
            <BentoStat
              label="Revenue · MTD"
              value="RM 42,800"
              delta="+14%"
              deltaTone="up"
              chart={<Sparkline data={[28, 31, 33, 36, 39, 41, 42, 43]} height={36} />}
            />
          ) : (
            <BentoStat label="Revenue · MTD" value="—" delta="Not available yet" deltaTone="flat" />
          )}
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          {isDemo ? (
            <BentoStat
              label="Outstanding · AR"
              value="RM 16,900"
              delta="−5%"
              deltaTone="up"
              chart={
                <Sparkline
                  data={[21, 20, 19, 18, 18, 17, 17, 16.9]}
                  color="var(--chart-2)"
                  height={36}
                />
              }
            />
          ) : (
            <BentoStat
              label="Outstanding · AR"
              value={model ? rm(model.receivable.total) : '—'}
              delta={model && model.receivable.overdue > 0 ? `${rm(model.receivable.overdue)} overdue` : undefined}
              deltaTone="down"
            />
          )}
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          {isDemo ? (
            <BentoStat
              label="Payable · AP"
              value="RM 9,300"
              delta="+RM 1.2k"
              deltaTone="down"
              chart={
                <Sparkline
                  data={[6.8, 7.1, 7.4, 7.9, 8.2, 8.6, 9.0, 9.3]}
                  color="var(--chart-3)"
                  height={36}
                />
              }
            />
          ) : (
            <BentoStat
              label="Payable · AP"
              value={model ? rm(model.payable.total) : '—'}
              delta={model && model.payable.overdue > 0 ? `${rm(model.payable.overdue)} overdue` : undefined}
              deltaTone="down"
            />
          )}
        </BentoCard>

        {/* Cash flow + revenue mix */}
        <BentoCard
          title="Cash in vs out"
          subtitle="Weekly · last 8 weeks"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {isDemo ? (
            <AreaTrend data={CASHFLOW_TREND} series={CASHFLOW_SERIES} height={240} showLegend />
          ) : (
            na
          )}
        </BentoCard>
        <BentoCard
          title="Revenue by category"
          subtitle="This month"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          {isDemo ? (
            <DonutStat
              data={REVENUE_BY_CATEGORY}
              height={240}
              centerValue="RM 42.8k"
              centerLabel="revenue"
            />
          ) : (
            na
          )}
        </BentoCard>

        {/* Collections funnel + AR by customer + collection rate */}
        <BentoCard
          title="Collections"
          subtitle="Issued → paid"
          icon={Filter}
          className="col-span-2 md:col-span-4"
        >
          {isDemo ? <FunnelFlow data={COLLECTIONS} height={200} /> : na}
        </BentoCard>
        <BentoCard
          title="Outstanding by customer"
          subtitle={isDemo ? 'Receivables (RM k)' : 'Receivables (RM)'}
          icon={Users}
          className="col-span-2 md:col-span-4"
        >
          {isDemo ? (
            <BarGroup data={AR_BY_CUSTOMER} series={AR_SERIES} horizontal height={200} />
          ) : (
            live(
              (m) =>
                m.outstandingByCustomer.length > 0 ? (
                  <BarGroup
                    data={m.outstandingByCustomer}
                    series={AR_LIVE_SERIES}
                    horizontal
                    height={200}
                  />
                ) : (
                  <Muted>Nothing outstanding</Muted>
                ),
              'No invoices yet',
            )
          )}
        </BentoCard>
        <BentoCard
          title="Collection rate"
          subtitle="Collected of billed"
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          {isDemo ? (
            <RadialGauge value={82} label="collected" valueLabel="82%" color="var(--chart-2)" height={200} />
          ) : (
            na
          )}
        </BentoCard>

        {/* Needs collecting + e-Invois status */}
        <BentoCard
          title="Overdue invoices"
          subtitle="Receivables to chase"
          icon={HandCoins}
          className="col-span-2 md:col-span-8"
        >
          {isDemo ? (
            <ul className="divide-y">
              {RECEIVABLES.map((r) => (
                <li key={r.id} className="flex items-center gap-3 py-2.5">
                  <LiveDot active={!r.overdue} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{r.customer}</p>
                    <p className="truncate text-xs text-muted-foreground">{r.id}</p>
                  </div>
                  <span
                    className={cn(
                      'hidden shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium sm:inline-block',
                      r.overdue
                        ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {r.age}
                  </span>
                  <span className="w-20 shrink-0 text-right text-sm font-semibold tabular-nums">
                    {r.amount}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            live(
              (m) =>
                m.overdueInvoices.length > 0 ? (
                  <ul className="divide-y">
                    {m.overdueInvoices.map((r) => (
                      <li key={r.id} className="flex items-center gap-3 py-2.5">
                        <LiveDot active={false} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{r.customer}</p>
                          <p className="truncate text-xs text-muted-foreground">{r.number}</p>
                        </div>
                        <span className="hidden shrink-0 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-600 sm:inline-block dark:text-red-400">
                          {overdueAge(r.daysOverdue)}
                        </span>
                        <span className="w-28 shrink-0 text-right text-sm font-semibold tabular-nums">
                          {rm(r.balance)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Muted>No overdue invoices</Muted>
                ),
              'No invoices yet',
            )
          )}
        </BentoCard>
        <BentoCard
          title="e-Invois · LHDN MyInvois"
          subtitle={isDemo ? 'Submission status' : 'Status you recorded'}
          icon={BadgeCheck}
          className="col-span-2 md:col-span-4"
        >
          {isDemo ? (
            <ul className="space-y-2">
              {EINVOICE.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center gap-2.5 rounded-lg border bg-background/50 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{e.customer}</p>
                    <p className="truncate text-xs text-muted-foreground">{e.id}</p>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                      EINVOICE_PILL[e.status],
                    )}
                  >
                    {e.status}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            live(
              (m) =>
                m.eInvoices.length > 0 ? (
                  <ul className="space-y-2">
                    {m.eInvoices.map((e) => (
                      <li
                        key={e.id}
                        className="flex items-center gap-2.5 rounded-lg border bg-background/50 px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{e.customer}</p>
                          <p className="truncate text-xs text-muted-foreground">{e.number}</p>
                        </div>
                        <span
                          className={cn(
                            'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                            EINVOICE_PILL[EINVOICE_LABEL[e.status]],
                          )}
                        >
                          {EINVOICE_LABEL[e.status]}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Muted>No e-Invois status recorded</Muted>
                ),
              'No invoices yet',
            )
          )}
        </BentoCard>

        {/* Upcoming bills + finance agents */}
        <BentoCard
          title="Upcoming bills"
          subtitle={
            isDemo
              ? 'Payables due · RM 9,300'
              : model
                ? `Payables due · ${rm(model.payable.total)}`
                : 'Payables due'
          }
          icon={CreditCard}
          className="col-span-2 md:col-span-6"
        >
          {isDemo ? (
            <ul className="divide-y">
              {UPCOMING_BILLS.map((b) => (
                <li key={b.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{b.supplier}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {b.id} · due {b.due}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">
                    {b.amount}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            live(
              (m) =>
                m.unpaidBills.length > 0 ? (
                  <ul className="divide-y">
                    {m.unpaidBills.map((b) => (
                      <li key={b.id} className="flex items-center gap-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{b.supplier}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {b.number} · due {displayDate(b.dueDate)}
                            {b.overdue ? ' · overdue' : ''}
                          </p>
                        </div>
                        <span className="shrink-0 text-sm font-semibold tabular-nums">
                          {rm(b.balance)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Muted>No unpaid bills</Muted>
                ),
              'No bills yet',
            )
          )}
        </BentoCard>
        <BentoCard
          title="Finance AI agents"
          subtitle="Your always-on crew"
          icon={Bot}
          className="col-span-2 md:col-span-6"
        >
          {isDemo ? (
            <div className="grid grid-cols-2 gap-2">
              {AGENTS.map((a) => (
                <div
                  key={a.name}
                  className="flex items-center gap-2 rounded-lg border bg-background/50 px-3 py-2"
                >
                  <LiveDot active={a.active} />
                  <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {a.active ? 'Active' : 'Paused'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            na
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
