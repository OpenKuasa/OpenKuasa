import {
  CalendarClock,
  FileText,
  Landmark,
  ListChecks,
  Receipt,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/*
 * Sample data, laid out item by item as the SST-02 return (form of 2 October 2026), as agreed in #222.
 * This is a service tax return on payment basis. SST has no input tax: the return takes deductions (item 13)
 * off the total tax (item 12). SST is administered by Customs (JKDM), and nothing is filed from this screen.
 */

type FormLine = { item: string; label: string; value?: string; tax: string; typed?: boolean };

/** Part A. */
const PART_A: { label: string; value: string }[] = [
  { label: 'SST registration no.', value: 'Service tax number, from settings' },
  { label: 'Name', value: 'Rimba Ventures Sdn Bhd' },
  { label: 'Taxable period', value: '1 Sep 2026 – 31 Oct 2026' },
  { label: 'Return and payment due', value: '30 Nov 2026' },
];

/** Part B1: taxable services by kind. Column (10) includes debit notes. */
const PART_B1 = [
  { id: '1', description: 'Consultancy', code: '—', value: 'RM 20,000.00', ownUse: 'RM 0.00' },
  { id: '2', description: 'Delivery', code: '—', value: 'RM 5,000.00', ownUse: 'RM 0.00' },
];

/** Part B2: value and tax at each rate, then item 12. */
const PART_B2: FormLine[] = [
  { item: '11(c)', label: 'Service tax 6%', value: 'RM 5,000.00', tax: 'RM 300.00' },
  { item: '11(d)', label: 'Service tax 8%', value: 'RM 20,000.00', tax: 'RM 1,600.00' },
  { item: '11(e)', label: 'Credit and charge cards, RM25 each', value: '0 cards', tax: 'RM 0.00', typed: true },
];

/** Item 13 on a service tax return, and item 14 = 12 − 13(a) − 13(c) − 13(d). */
const DEDUCTIONS: FormLine[] = [
  { item: '13(a)', label: 'Tax from credit notes', tax: 'RM 80.00' },
  { item: '13(c)', label: 'Approved service tax deduction', tax: 'RM 0.00', typed: true },
  { item: '13(d)', label: 'Bad debt relief (approved)', tax: 'RM 0.00', typed: true },
];

/** Part D on a service tax return: item 18(c). */
const PART_D: FormLine[] = [
  { item: '18(c)(1)', label: 'B2B: services between registered persons', tax: 'RM 3,000.00' },
  { item: '18(c)(2)', label: 'Group relief', tax: 'RM 0.00' },
  { item: '18(c)(3)', label: 'Other exemption', tax: 'RM 0.00' },
  { item: '18(c)(4)', label: 'Other non-taxable services', tax: 'RM 0.00' },
];

type PeriodStatus = 'Not filed' | 'Marked filed';

const PERIODS: { id: string; period: string; due: string; payable: string; status: PeriodStatus; filed?: string }[] = [
  { id: '1', period: '1 Sep – 31 Oct 2026', due: '30 Nov 2026', payable: 'RM 1,820.00', status: 'Not filed' },
  { id: '2', period: '1 Jul – 31 Aug 2026', due: '30 Sep 2026', payable: 'RM 1,540.00', status: 'Marked filed', filed: '28 Sep 2026' },
  { id: '3', period: '1 May – 30 Jun 2026', due: '31 Jul 2026', payable: 'RM 0.00', status: 'Marked filed', filed: '30 Jul 2026' },
];

const STATUS_STYLES: Record<PeriodStatus, string> = {
  'Not filed': 'bg-amber-500/15 text-amber-600',
  'Marked filed': 'bg-emerald-500/15 text-emerald-600',
};

/** One numbered line of the form: item, label, an optional value, and the amount. */
function FormRow({ line, strong }: { line: FormLine; strong?: boolean }) {
  return (
    <li className={cn('flex items-baseline gap-3 py-2 text-sm', strong && 'font-semibold')}>
      <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">{line.item}</span>
      <span className="min-w-0 flex-1">
        {line.label}
        {line.typed ? <span className="ml-1.5 text-xs text-muted-foreground">(typed in)</span> : null}
      </span>
      {line.value !== undefined ? (
        <span className="hidden shrink-0 text-right tabular-nums text-muted-foreground sm:block sm:w-32">
          {line.value}
        </span>
      ) : null}
      <span className="w-28 shrink-0 text-right tabular-nums">{line.tax}</span>
    </li>
  );
}

/* ------------------------------------------------------------------ */

export default function SstReportScreen() {
  return (
    <ScreenContainer>
      <PageHeader
        title="SST Report"
        subtitle="A summary of your SST-02 return to copy into MySST. Nothing is sent to Customs (JKDM) from here."
        actions={
          <>
            <Select defaultValue="service">
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="service">Service tax</SelectItem>
                <SelectItem value="sales">Sales tax</SelectItem>
              </SelectContent>
            </Select>
            <Select defaultValue="sepoct">
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sepoct">1 Sep – 31 Oct 2026</SelectItem>
                <SelectItem value="julaug">1 Jul – 31 Aug 2026</SelectItem>
                <SelectItem value="mayjun">1 May – 30 Jun 2026</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm">
              <FileText className="size-4" />
              CSV
            </Button>
          </>
        }
      />

      <BentoGrid>
        {/* Items 12, 13, 14 and the due date */}
        <BentoCard tone="primary" className="col-span-2 md:col-span-3">
          <BentoStat label="Total tax (item 12)" value="RM 1,900.00" delta="this period" deltaTone="flat" onPrimary />
        </BentoCard>
        <BentoCard className="col-span-2 md:col-span-3">
          <BentoStat label="Deductions (item 13)" value="RM 80.00" delta="credit notes" deltaTone="flat" />
        </BentoCard>
        <BentoCard className="col-span-2 md:col-span-3">
          <BentoStat label="Tax payable (item 14)" value="RM 1,820.00" delta="to Customs (JKDM)" deltaTone="flat" />
        </BentoCard>
        <BentoCard className="col-span-2 md:col-span-3">
          <BentoStat label="Return and payment due" value="30 Nov" delta="last day of the next month" deltaTone="flat" />
        </BentoCard>

        {/* Part A */}
        <BentoCard title="Part A" subtitle="The business and the period" icon={Landmark} className="col-span-2 md:col-span-5">
          <dl className="divide-y text-sm">
            {PART_A.map((a) => (
              <div key={a.label} className="flex gap-3 py-2">
                <dt className="w-28 shrink-0 sm:w-40 text-muted-foreground">{a.label}</dt>
                <dd className="min-w-0 flex-1 font-medium">{a.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            Not on the form: service tax is counted when payment is received (payment basis), unless Customs has
            approved invoice basis.
          </p>
        </BentoCard>

        {/* Part B1 */}
        <BentoCard title="Part B1" subtitle="Taxable services, by kind · value includes debit notes" icon={ListChecks} className="col-span-2 md:col-span-7">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Description</TableHead>
                  <TableHead>Service type code</TableHead>
                  <TableHead className="text-right">Value of taxable service (10)</TableHead>
                  <TableHead className="text-right">Own use or free</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {PART_B1.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="whitespace-nowrap font-medium">{b.description}</TableCell>
                    <TableCell className="text-muted-foreground">{b.code}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{b.value}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{b.ownUse}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-t-2 bg-muted/30 font-semibold">
                  <TableCell>Total</TableCell>
                  <TableCell />
                  <TableCell className="whitespace-nowrap text-right tabular-nums">RM 25,000.00</TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">RM 0.00</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </BentoCard>

        {/* Part B2 and item 12 */}
        <BentoCard title="Part B2" subtitle="Value and tax at each rate" icon={Receipt} className="col-span-2 md:col-span-6">
          <ul className="divide-y">
            {PART_B2.map((l) => (
              <FormRow key={l.item} line={l} />
            ))}
            <FormRow line={{ item: '12', label: 'Total tax', tax: 'RM 1,900.00' }} strong />
          </ul>
        </BentoCard>

        {/* Item 13 and item 14 */}
        <BentoCard title="Deductions and tax payable" subtitle="Items 13 and 14" icon={FileText} className="col-span-2 md:col-span-6">
          <ul className="divide-y">
            {DEDUCTIONS.map((l) => (
              <FormRow key={l.item} line={l} />
            ))}
            <FormRow line={{ item: '14', label: 'Tax payable (12 less 13)', tax: 'RM 1,820.00' }} strong />
          </ul>
        </BentoCard>

        {/* Part D */}
        <BentoCard title="Part D" subtitle="Exempt and non-taxable services" icon={ShieldCheck} className="col-span-2 md:col-span-7">
          <ul className="divide-y">
            {PART_D.map((l) => (
              <FormRow key={l.item} line={l} />
            ))}
          </ul>
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <p className="text-xs text-muted-foreground">
              Not on the form: RM 1,200.00 of sales at 0% have no exemption reason yet. Give each one a reason before
              you file, so it lands on a line above.
            </p>
          </div>
        </BentoCard>

        {/* Periods */}
        <BentoCard
          title="Periods"
          subtitle="Bendahara cannot see MySST, so you mark a return as filed"
          icon={CalendarClock}
          className="col-span-2 md:col-span-5"
        >
          <ul className="divide-y">
            {PERIODS.map((p) => (
              <li key={p.id} className="flex items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{p.period}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    Due {p.due} · payable {p.payable}
                    {p.filed ? ` · filed ${p.filed}` : ''}
                  </span>
                </span>
                <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium', STATUS_STYLES[p.status])}>
                  {p.status}
                </span>
              </li>
            ))}
          </ul>
        </BentoCard>

        {/* What the summary does not count yet */}
        <BentoCard tone="muted" className="col-span-2 md:col-span-12">
          <p className="text-xs text-muted-foreground">
            Not counted yet: imported services (they are recorded as supplier bills) and debit notes. Items 15 and 16
            (late payment penalty) are worked out by Customs when the return is keyed into MySST, so they are not shown.
          </p>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
