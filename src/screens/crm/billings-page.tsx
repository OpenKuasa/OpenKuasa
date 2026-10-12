import Link from 'next/link';
import { ArrowUpRight, ChartColumn, Gauge, Receipt, TrendingUp, Users } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import { BarGroup, RadialGauge, type Series } from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { buttonVariants } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { createClient } from '@/lib/supabase/server';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { loadCrmBillings, type BillingsModel } from '@/lib/crm/billings';
import { formatDay } from '@/lib/crm/deal-stats';
import { rm, rmShort } from '@/lib/finance/format';
import type { InvoiceDisplayStatus } from '@/lib/finance/invoices';
import { INVOICE_STATUS_LABELS } from '@/lib/finance/sales-views';
import { cn } from '@/lib/utils';
import SampleBillingsScreen from './billings';

const SUBTITLE = 'Invoices and collections, from Bendahara.';
/** Where invoices are created and changed. */
const INVOICES_HREF = '/finance/invoices';

const STATUS_PILL: Record<InvoiceDisplayStatus, string> = {
  paid: 'bg-emerald-500/15 text-emerald-600',
  sent: 'bg-amber-500/15 text-amber-600',
  overdue: 'bg-red-500/15 text-red-600',
  draft: 'bg-muted text-muted-foreground',
  void: 'bg-muted text-muted-foreground line-through',
};

const BILLED_SERIES: Series[] = [{ key: 'billed', label: 'Billed (RM)', color: 'var(--chart-1)' }];
const STATUS_SERIES: Series[] = [{ key: 'count', label: 'Invoices', color: 'var(--chart-2)' }];

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function invoices(count: number) {
  return `${count} ${count === 1 ? 'invoice' : 'invoices'}`;
}

function OpenInBendahara({ label }: { label: string }) {
  return (
    <Link href={INVOICES_HREF} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      {label}
      <ArrowUpRight className="size-4" />
    </Link>
  );
}

/**
 * Kasturi's Billings: the workspace's sales invoices, read from Bendahara.
 * Nothing is changed here; invoices are created and edited on Bendahara's
 * Invoices screen. Falls back to the sample screen when no database is
 * configured.
 */
export default async function BillingsPage() {
  if (!hasSupabaseEnv()) return <SampleBillingsScreen />;

  let model: BillingsModel | null = null;
  try {
    const supabase = await createClient();
    const org = await getCurrentOrg(supabase);
    if (org) model = await loadCrmBillings(supabase, org.orgId, new Date());
  } catch (e) {
    console.error('[crm/billings] data error:', e);
  }

  if (!model) {
    return (
      <ScreenContainer>
        <PageHeader title="Billings" subtitle={SUBTITLE} />
        <Muted>Couldn&apos;t load your invoices — please refresh</Muted>
      </ScreenContainer>
    );
  }

  const { stats } = model;

  return (
    <ScreenContainer>
      <PageHeader
        title="Billings"
        subtitle={SUBTITLE}
        actions={<OpenInBendahara label="Manage invoices" />}
      />

      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label={`Billed in ${model.monthTitle}`}
            value={rmShort(stats.billedThisMonth)}
            delta={invoices(stats.billedThisMonthCount)}
            onPrimary
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Outstanding"
            value={rmShort(stats.outstanding)}
            delta={invoices(stats.outstandingCount)}
            deltaTone="flat"
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Overdue"
            value={rmShort(stats.overdue)}
            delta={invoices(stats.overdueCount)}
            deltaTone={stats.overdueCount > 0 ? 'down' : 'flat'}
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Received" value={rmShort(stats.received)} />
        </BentoCard>

        <BentoCard
          title="Billed by month"
          subtitle={`Last ${model.trend.length} months, by invoice date`}
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {model.trend.some((point) => point.billed > 0) ? (
            <BarGroup data={model.trend} series={BILLED_SERIES} height={240} />
          ) : (
            <Muted>Nothing billed in the last {model.trend.length} months</Muted>
          )}
        </BentoCard>
        <BentoCard
          title="Collection rate"
          subtitle="Received of everything billed"
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          {stats.collectionRate === null ? (
            <Muted>No invoices posted yet</Muted>
          ) : (
            <RadialGauge
              value={stats.collectionRate}
              valueLabel={`${stats.collectionRate}%`}
              label="received"
              color="var(--chart-2)"
              height={240}
            />
          )}
        </BentoCard>

        <BentoCard
          title="Invoices by status"
          subtitle={invoices(model.total)}
          icon={ChartColumn}
          className="col-span-2 md:col-span-6"
        >
          {model.total === 0 ? (
            <Muted>No invoices yet</Muted>
          ) : (
            <BarGroup
              data={model.byStatus.map(({ status, count }) => ({
                label: INVOICE_STATUS_LABELS[status],
                count,
              }))}
              series={STATUS_SERIES}
              horizontal
              height={200}
            />
          )}
        </BentoCard>
        <BentoCard
          title="Top customers"
          subtitle="By amount billed"
          icon={Users}
          className="col-span-2 md:col-span-6"
        >
          {model.topCustomers.length === 0 ? (
            <Muted>No invoices posted yet</Muted>
          ) : (
            <ul className="divide-y">
              {model.topCustomers.map((customer) => (
                <li key={customer.id} className="flex items-center gap-3 py-2.5">
                  <LiveDot active={customer.outstanding === 0} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{customer.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {customer.outstanding > 0 ? `${rm(customer.outstanding)} outstanding` : 'Nothing outstanding'}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">{rm(customer.billed)}</span>
                </li>
              ))}
            </ul>
          )}
        </BentoCard>

        <BentoCard
          title="Recent invoices"
          subtitle={
            model.total > model.recent.length
              ? `The newest ${model.recent.length} of ${model.total}`
              : 'Newest first'
          }
          icon={Receipt}
          action={<OpenInBendahara label="View all" />}
          className="col-span-2 md:col-span-12"
        >
          {model.recent.length === 0 ? (
            <Muted>No invoices yet. Create one on Bendahara&apos;s Invoices screen.</Muted>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Invoice #</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Deal</TableHead>
                    <TableHead className="whitespace-nowrap">Date</TableHead>
                    <TableHead className="whitespace-nowrap">Due</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {model.recent.map((invoice) => (
                    <TableRow
                      key={invoice.id}
                      className={cn(invoice.display_status === 'void' && 'opacity-60')}
                    >
                      <TableCell className="whitespace-nowrap font-medium">
                        {invoice.invoice_no ?? <span className="text-muted-foreground">Draft</span>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{invoice.customer_name}</TableCell>
                      <TableCell className="max-w-48 truncate">
                        {invoice.dealTitle ? (
                          <Link href="/crm/deals" className="hover:underline">
                            {invoice.dealTitle}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDay(invoice.invoice_date)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDay(invoice.due_date)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {rm(invoice.total)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {/* Nothing is owed on a void invoice, whatever it totalled. */}
                        {invoice.display_status === 'void' ? '—' : rm(invoice.balance)}
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={invoice.display_status === 'paid'} />
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_PILL[invoice.display_status],
                            )}
                          >
                            {INVOICE_STATUS_LABELS[invoice.display_status]}
                          </span>
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
