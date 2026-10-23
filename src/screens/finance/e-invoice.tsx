import {
  AlertTriangle,
  CircleCheck,
  FileText,
  Gauge,
  ListChecks,
  PieChart,
  RefreshCw,
  Send,
  ShieldCheck,
  TrendingUp,
  XCircle,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import {
  AreaTrend,
  DonutStat,
  RadialGauge,
  Sparkline,
  type Series,
  type Slice,
} from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/* ---- mock data (Rimba Ventures Sdn Bhd · LHDN MyInvois) ----------- */

const SUBMISSIONS_TREND = [
  { label: 'May', submitted: 96, validated: 92 },
  { label: 'Jun', submitted: 104, validated: 101 },
  { label: 'Jul', submitted: 112, validated: 109 },
  { label: 'Aug', submitted: 118, validated: 115 },
  { label: 'Sep', submitted: 124, validated: 121 },
  { label: 'Oct', submitted: 128, validated: 124 },
];
const SUBMISSIONS_SERIES: Series[] = [
  { key: 'submitted', label: 'Submitted', color: 'var(--chart-1)' },
  { key: 'validated', label: 'Validated', color: 'var(--chart-2)' },
];

const BY_STATUS: Slice[] = [
  { key: 'validated', label: 'Validated', value: 124, color: 'var(--chart-2)' },
  { key: 'pending', label: 'Pending', value: 3, color: 'var(--chart-4)' },
  { key: 'rejected', label: 'Rejected', value: 1, color: 'var(--chart-3)' },
];

type ReadinessStatus = 'Ready' | 'Attention' | 'Action needed';

type ReadinessCheck = {
  name: string;
  description: string;
  status: ReadinessStatus;
};

const READINESS: ReadinessCheck[] = [
  {
    name: 'MyInvois portal connected',
    description: 'API link to LHDN MyInvois is live',
    status: 'Ready',
  },
  {
    name: 'Digital certificate valid',
    description: 'e-Cert expires 14 Mar 2027',
    status: 'Ready',
  },
  {
    name: 'TIN & SSM verified',
    description: 'C20231045678 · 202301012345 (Rimba Ventures Sdn Bhd)',
    status: 'Ready',
  },
  {
    name: 'Buyer TIN capture',
    description: '2 customers missing TIN for B2B e-Invoice',
    status: 'Attention',
  },
  {
    name: 'Consolidated e-Invoice',
    description: 'October consolidation due by 07 Nov 2026',
    status: 'Attention',
  },
  {
    name: 'Rejected document',
    description: 'INV-1038 rejected — fix TIN & resubmit',
    status: 'Action needed',
  },
];

const READINESS_PILL: Record<ReadinessStatus, string> = {
  Ready: 'bg-emerald-500/15 text-emerald-600',
  Attention: 'bg-amber-500/15 text-amber-600',
  'Action needed': 'bg-red-500/15 text-red-600',
};

function ReadinessIcon({ status }: { status: ReadinessStatus }) {
  if (status === 'Ready') {
    return <CircleCheck className="size-5 shrink-0 text-emerald-600" />;
  }
  if (status === 'Attention') {
    return <AlertTriangle className="size-5 shrink-0 text-amber-600" />;
  }
  return <XCircle className="size-5 shrink-0 text-red-600" />;
}

type MyInvoisStatus = 'Validated' | 'Pending' | 'Rejected';

type EInvoice = {
  id: string;
  no: string;
  customer: string;
  date: string;
  amount: string;
  status: MyInvoisStatus;
  uuid: string;
};

const INVOICES: EInvoice[] = [
  { id: '1', no: 'INV-1042', customer: 'Aisyah Trading', date: '07 Oct 2026', amount: 'RM 1,240.00', status: 'Validated', uuid: 'F9D3K2M8P1Q7R4S6T0V5W2X9Y1' },
  { id: '2', no: 'INV-1041', customer: 'Zaki Enterprise', date: '06 Oct 2026', amount: 'RM 3,500.00', status: 'Validated', uuid: 'C7D4N2B8H5J1K9L3M6P0Q4R2S8' },
  { id: '3', no: 'INV-1040', customer: 'Nurul Boutique', date: '06 Oct 2026', amount: 'RM 860.00', status: 'Pending', uuid: 'E9F0A1C3D5G7H9J2K4L6M8N0P2' },
  { id: '4', no: 'INV-1039', customer: 'Seri Mutiara Enterprise', date: '05 Oct 2026', amount: 'RM 2,150.00', status: 'Validated', uuid: '3B8A7C6D5E4F3G2H1J9K8L7M6N' },
  { id: '5', no: 'INV-1038', customer: 'Lim Hardware', date: '04 Oct 2026', amount: 'RM 4,720.00', status: 'Rejected', uuid: '9C21B5D7E3F1G9H5J7K3L1M9N5' },
  { id: '6', no: 'INV-1037', customer: 'Printhub Sdn Bhd', date: '03 Oct 2026', amount: 'RM 540.00', status: 'Pending', uuid: '5D6E4A2C8B0F6G4H2J0K8L6M4N' },
  { id: '7', no: 'INV-1036', customer: 'Aisyah Trading', date: '02 Oct 2026', amount: 'RM 1,980.00', status: 'Validated', uuid: 'F2A7B6C5D4E3F2G1H9J8K7L6M5' },
  { id: '8', no: 'INV-1035', customer: 'Langkawi Fresh', date: '01 Oct 2026', amount: 'RM 6,300.00', status: 'Validated', uuid: 'A1C2E3G4J5L6N7P8R9T0V1X2Z3' },
];

const STATUS_STYLES: Record<MyInvoisStatus, string> = {
  Validated: 'bg-emerald-500/15 text-emerald-600',
  Pending: 'bg-amber-500/15 text-amber-600',
  Rejected: 'bg-red-500/15 text-red-600',
};

function StatusPill({ status }: { status: MyInvoisStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        STATUS_STYLES[status],
      )}
    >
      {status}
    </span>
  );
}

/* ------------------------------------------------------------------ */

export default function EInvoiceScreen() {
  const issues = READINESS.filter((c) => c.status === 'Action needed').length;

  return (
    <ScreenContainer>
      <PageHeader
        title="e-Invoice LHDN"
        subtitle="MyInvois submission, validation & compliance."
        badge={
          <Badge variant="secondary" className="gap-1.5">
            <LiveDot active />
            MyInvois live
          </Badge>
        }
        actions={
          <>
            <Button variant="outline" size="sm">
              <RefreshCw className="size-4" />
              Sync LHDN
            </Button>
            <Button size="sm">
              <Send className="size-4" />
              Submit batch
            </Button>
          </>
        }
      />

      <BentoGrid>
        {/* KPI row */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Submitted (MTD)"
            value="128"
            delta="+9%"
            onPrimary
            chart={
              <Sparkline
                data={[96, 104, 112, 118, 124, 128]}
                color="var(--primary-foreground)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Validated"
            value="124"
            delta="+8%"
            deltaTone="up"
            chart={
              <Sparkline
                data={[92, 101, 109, 115, 121, 124]}
                color="var(--chart-2)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Pending"
            value="3"
            delta="awaiting LHDN"
            deltaTone="flat"
            chart={
              <Sparkline
                data={[5, 4, 4, 3, 4, 3]}
                color="var(--chart-4)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Rejected"
            value="1"
            delta="needs fix"
            deltaTone="down"
            chart={
              <Sparkline
                data={[2, 1, 2, 1, 0, 1]}
                color="var(--chart-3)"
                height={36}
              />
            }
          />
        </BentoCard>

        {/* Submissions trend + compliance gauge */}
        <BentoCard
          title="Submissions over time"
          subtitle="Submitted vs validated · last 6 months"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          <AreaTrend
            data={SUBMISSIONS_TREND}
            series={SUBMISSIONS_SERIES}
            height={240}
            showLegend
          />
        </BentoCard>
        <BentoCard
          title="Compliance rate"
          subtitle="Validated of submitted"
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          <RadialGauge
            value={97}
            valueLabel="97%"
            label="validated"
            color="var(--chart-2)"
            height={240}
          />
        </BentoCard>

        {/* Status mix + LHDN readiness checklist */}
        <BentoCard
          title="By status"
          subtitle="Current e-Invoice book"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          <DonutStat
            data={BY_STATUS}
            height={240}
            centerValue="128"
            centerLabel="documents"
          />
        </BentoCard>
        <BentoCard
          title="LHDN readiness"
          subtitle="MyInvois compliance checklist"
          icon={ListChecks}
          className="col-span-2 md:col-span-8"
        >
          <div className="grid gap-3 md:grid-cols-12">
            <div className="flex flex-col justify-center gap-2 rounded-lg border bg-background/50 p-3 md:col-span-4">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-5 shrink-0 text-emerald-600" />
                <p className="text-sm font-semibold">Compliant</p>
              </div>
              <p className="text-xs text-muted-foreground">
                124 of 128 documents validated with LHDN.
              </p>
              <div className="mt-1 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2">
                <AlertTriangle className="size-4 shrink-0 text-red-600" />
                <p className="text-sm font-medium">
                  {issues} document{issues === 1 ? '' : 's'} need action
                </p>
              </div>
            </div>
            <div className="divide-y rounded-lg border bg-background/50 md:col-span-8">
              {READINESS.map((check) => (
                <div
                  key={check.name}
                  className="flex items-center justify-between gap-4 p-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <ReadinessIcon status={check.status} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{check.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {check.description}
                      </p>
                    </div>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium',
                      READINESS_PILL[check.status],
                    )}
                  >
                    {check.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </BentoCard>

        {/* e-Invoice table */}
        <BentoCard
          title="e-Invoice documents"
          subtitle="Each carries an LHDN MyInvois UUID"
          icon={FileText}
          action={
            <Button variant="outline" size="sm">
              View all
            </Button>
          }
          className="col-span-2 md:col-span-12"
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Invoice no.</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="whitespace-nowrap">Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>MyInvois status</TableHead>
                  <TableHead className="whitespace-nowrap">LHDN UUID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {INVOICES.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="whitespace-nowrap font-medium">
                      {i.no}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{i.customer}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {i.date}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {i.amount}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <LiveDot active={i.status === 'Validated'} />
                        <StatusPill status={i.status} />
                      </span>
                    </TableCell>
                    <TableCell>
                      <code
                        className="block max-w-40 truncate font-mono text-xs text-muted-foreground"
                        title={i.uuid}
                      >
                        {i.uuid}
                      </code>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
