import type { ReactNode } from 'react';
import {
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  markSstReturnFiledAction,
  saveSstFiguresAction,
  saveSstSettingsAction,
  unmarkSstReturnFiledAction,
} from '@/app/(app)/finance/actions';
import { SstFiguresCard } from '@/components/finance/sst-figures-card';
import { SstPeriodsCard, type SstPeriodRow } from '@/components/finance/sst-periods-card';
import { SstReturnPicker } from '@/components/finance/sst-return-picker';
import { SstSettingsCard } from '@/components/finance/sst-settings-card';
import { getCompany } from '@/lib/account/data';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { expensesScreenPlan } from '@/lib/finance/expense-form';
import { rm } from '@/lib/finance/format';
import { type SstPeriod, type SstSettings, getSstSettings, sstPeriodLabel } from '@/lib/finance/sst';
import {
  type SstCreditRow,
  type SstFormLine,
  type SstLineRow,
  type SstPaidInvoice,
  type SstReturn,
  type SstTypedFigures,
  NO_TYPED_FIGURES,
  buildSstReturn,
  pickSstView,
  recentSstPeriods,
  sstCards,
} from '@/lib/finance/sst-return';
import {
  type SstNoInvoiceMoney,
  listSstFiled,
  listSstFigures,
  readSstNoInvoiceMoney,
  readSstPaidInvoices,
  readSstRows,
} from '@/lib/finance/sst-return-data';
import { displayDate } from '@/lib/finance/view-helpers';
import { todayInMalaysia } from '@/lib/people/dates';
import { createClient } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';
import { SAMPLE_TODAY } from './sales-sample';

/*
 * The SST-02 return (form of 2 October 2026), item by item, worked out from the workspace's invoices and credit
 * notes on invoice basis (#222 stage 2). SST has no input tax: the return takes deductions (item 13) off the
 * total tax (item 12). SST is administered by Customs (JKDM), and nothing is filed from this screen.
 */

/**
 * Without a database: the layout from an empty data set on these settings, all figures RM 0.00. Invoice basis,
 * so the sample needs no receipts.
 */
const SAMPLE_SETTINGS: SstSettings = {
  period_start_month: 9,
  service_tax_no: 'W10-2608-32000123',
  sales_tax_no: null,
  service_tax_basis: 'invoice',
};
const SAMPLE_COMPANY = 'Rimba Ventures Sdn Bhd';

/** One numbered line of the form: item, label, an optional value, and the amount. */
function FormRow({ line, strong }: { line: { item: string; label: string; value?: string; tax: string; typed?: boolean }; strong?: boolean }) {
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

/** A form line with its figures formatted. A typed-in card count (11(e)) shows as cards, never as ringgit. */
const shown = (l: SstFormLine) => ({
  item: l.item,
  label: l.label,
  value: l.item === '11(e)' ? sstCards(l.value ?? 0) : l.value === null ? undefined : rm(l.value),
  tax: rm(l.tax),
  typed: l.typed,
});

const lines = (n: number) => (n === 1 ? '1 line' : `${n} lines`);

/**
 * The "Not on the form" notes of a return: lines with no form item, lines with no tax type, an item 14 below
 * zero, and on a service return the money received with no invoice behind it.
 *
 * On a period already marked filed the no-invoice note says so, because the step it asks for is refused there:
 * an invoice dated inside a filed period stops on FIN72 (`20261129090000_bendahara_post_into_filed_period.sql`)
 * and a receipt that pays one stops on FIN77 (`20261202100000_bendahara_payment_into_filed_period.sql`). A
 * receipt with no invoice behind it trips neither, because it pays nothing and moves no figure, so the note
 * names the two refusals that do apply and voids that receipt before asking for the invoice. Both refusals
 * name the routes the note then gives: date it in the current period, or take the mark off and file an amended
 * return (Pindaan).
 */
function notesOf(
  ret: SstReturn,
  settings: SstSettings,
  noInvoice?: SstNoInvoiceMoney,
  filedOn?: string | null,
): string[] {
  const notes: string[] = [];
  const one = (n: number) => n === 1;
  if (ret.offForm.count > 0) {
    const found = `${lines(ret.offForm.count)} (${rm(ret.offForm.value)})`;
    notes.push(
      ret.type === 'sales'
        ? `Not on the form: ${found} ${one(ret.offForm.count) ? 'is' : 'are'} at a rate with no item on this return. If the rate or tax type is wrong, fix it before you file. If it is a Part C (item 17) good, a Schedule 2 good taxed at a rate other than 5% or 10%, add it on the form yourself: this return does not count Part C yet.`
        : `Not on the form: ${found} ${one(ret.offForm.count) ? 'is' : 'are'} at a rate with no item on this return. Either the rate is wrong or the line needs another tax type. Fix it before you file.`,
    );
  }
  if (ret.untyped.count > 0) {
    notes.push(
      `Not on the form: ${lines(ret.untyped.count)} (${rm(ret.untyped.value)}) ${one(ret.untyped.count) ? 'has' : 'have'} no SST tax type. Set one before you file.`,
    );
  }
  if (ret.item14 < 0) {
    notes.push(
      "Not on the form: item 14 is below zero because this period's deductions are more than its tax. Check with Customs (JKDM) how to claim it before you file.",
    );
  }
  // Money in that settles no invoice carries no rate, so it is on no item of a service return. Named, not
  // guessed into a line: much of it may not be for a taxable service at all. The way to count it depends on the
  // basis: a payment-basis return counts receipts against invoices, and a posted receipt's split cannot be
  // changed (FIN09), so the receipt is voided and recorded again; an invoice-basis return counts the invoice.
  // On a filed period neither of those is possible inside it, so the note gives the routes that are.
  if (ret.type === 'service' && noInvoice && noInvoice.count > 0) {
    const across = noInvoice.count > 1 ? `, across ${noInvoice.count} receipts` : '';
    const head = `Not counted: ${rm(noInvoice.amount_myr)} received with no invoice${across}.`;
    if (filedOn) {
      // A receipt with no invoice is neither an invoice nor a receipt that pays one, so neither FIN72 nor FIN77
      // refuses it: the two refusals below are what the step inside the filed period meets, and both clear in
      // the current period. The note keeps the "if any of it" condition, because much of this money may be
      // capital, a loan or interest, and names the refusals without their codes, because it is read by owners.
      const route =
        settings.service_tax_basis === 'payment'
          ? 'If any of it is payment for a taxable service: this period is filed, so neither an invoice nor a receipt that pays one can be dated inside it. Void the receipt, issue the invoice in the current period and record the receipt against it there, so its tax is counted in the current return, or take the filed mark off the return and file an amended return (Pindaan).'
          : 'If any of it is payment for a taxable service that has no invoice yet: this period is filed, so an invoice cannot be dated inside it. Issue the invoice in the current period, so its tax is counted there, or take the filed mark off the return and file an amended return (Pindaan).';
      notes.push(`${head} ${route}`);
    } else {
      const fix =
        settings.service_tax_basis === 'payment'
          ? 'void the receipt and record it again against the invoice for that service (issue one first if there is none), so its tax is counted.'
          : 'and the service has no invoice yet, issue one so its tax is counted.';
      notes.push(`${head} If any of it is payment for a taxable service, ${fix}`);
    }
  }
  return notes;
}

function basisNote(type: SstReturn['type'], settings: SstSettings): string {
  if (type === 'sales') return 'Sales tax is counted when the goods are sold, by the invoice date.';
  return settings.service_tax_basis === 'payment'
    ? 'Service tax is counted when the payment is received (payment basis), less any credit note issued since.'
    : 'Service tax is counted when the invoice is issued (invoice basis, approved by Customs).';
}

/**
 * The return for one period: the four stats, Part A, then B1, B2 with item 12, the deductions with item 14 and
 * any "Not on the form" note, and Part D. Payment basis is worked out from the money received, so its service
 * return reads the same parts as an invoice-basis one.
 */
export function SstReturnBody({
  ret,
  settings,
  companyName,
  noInvoice,
  filedOn,
}: {
  ret: SstReturn;
  settings: SstSettings;
  companyName: string;
  /** Money received in this period with no invoice behind it (service returns only). */
  noInvoice?: SstNoInvoiceMoney;
  /** The date the shown period was marked filed, if it was: a receipt or invoice dated inside it is refused. */
  filedOn?: string | null;
}) {
  const service = ret.type === 'service';
  const registration = (service ? settings.service_tax_no : settings.sales_tax_no) || 'Not registered: add the number in SST settings above';
  const deductionsTotal = ret.deductions.reduce((s, d) => s + Math.round(d.tax * 100), 0) / 100;
  const notes = notesOf(ret, settings, noInvoice, filedOn);
  // The items the tile sums.
  const deductionsHint = service ? '13(a), 13(c) and 13(d)' : '13(a), 13(b), 13A and 13(d)';
  const partA = [
    { label: service ? 'Service tax no.' : 'Sales tax no.', value: registration },
    { label: 'Name', value: companyName },
    { label: 'Taxable period', value: sstPeriodLabel(ret.period) },
    { label: 'Return and payment due', value: displayDate(ret.period.due) },
  ];

  return (
    <>
      {/* Items 12, 13, 14 and the due date */}
      <BentoCard tone="primary" className="col-span-2 md:col-span-3">
        <BentoStat label="Total tax (item 12)" value={rm(ret.item12)} delta="this period" deltaTone="flat" onPrimary />
      </BentoCard>
      <BentoCard className="col-span-2 md:col-span-3">
        <BentoStat label="Deductions (item 13)" value={rm(deductionsTotal)} delta={deductionsHint} deltaTone="flat" />
      </BentoCard>
      <BentoCard className="col-span-2 md:col-span-3">
        <BentoStat label="Tax payable (item 14)" value={rm(ret.item14)} delta="to Customs (JKDM)" deltaTone="flat" />
      </BentoCard>
      <BentoCard className="col-span-2 md:col-span-3">
        <BentoStat label="Return and payment due" value={displayDate(ret.period.due)} delta="last day of the next month" deltaTone="flat" />
      </BentoCard>

      {/* Part A */}
      <BentoCard title="Part A" subtitle="The business and the period" icon={Landmark} className="col-span-2 md:col-span-5">
        <dl className="divide-y text-sm">
          {partA.map((a) => (
            <div key={a.label} className="flex gap-3 py-2">
              <dt className="w-28 shrink-0 text-muted-foreground sm:w-40">{a.label}</dt>
              <dd className="min-w-0 flex-1 break-words font-medium">{a.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">{basisNote(ret.type, settings)}</p>
      </BentoCard>

          {/* Part B1 */}
          <BentoCard
            title="Part B1"
            subtitle="Sales / Service Details"
            icon={ListChecks}
            className="col-span-2 md:col-span-7"
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Description</TableHead>
                    {/* The long column names wrap, so the four columns fit the card without a sideways scroll. */}
                    <TableHead className="h-auto py-2 whitespace-normal">{service ? 'Service type code' : 'Tariff code'}</TableHead>
                    <TableHead className="h-auto py-2 text-right whitespace-normal">{service ? 'Value of taxable service (10)' : 'Value of goods sold (8)'}</TableHead>
                    <TableHead className="h-auto py-2 text-right whitespace-normal">
                      {service ? 'Value of free services' : 'Value of goods (for own use / disposed)'}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ret.b1.map((b) => (
                    <TableRow key={b.key}>
                      <TableCell className="font-medium">{b.description || '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{b.code ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(b.value)}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(b.ownUse)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="border-t-2 bg-muted/30 font-semibold">
                    <TableCell>Total</TableCell>
                    <TableCell />
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(ret.b1Total)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(0)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </BentoCard>

          {/* Part B2 and item 12 */}
          <BentoCard title="Part B2" subtitle="Value and tax at each rate" icon={Receipt} className="col-span-2 md:col-span-6">
            <ul className="divide-y">
              {ret.b2.map((l) => (
                <FormRow key={l.item} line={shown(l)} />
              ))}
              <FormRow line={{ item: '12', label: 'Total tax', tax: rm(ret.item12) }} strong />
            </ul>
          </BentoCard>

          {/* Item 13 and item 14 */}
          <BentoCard title="Deductions and tax payable" subtitle="Items 13 and 14" icon={FileText} className="col-span-2 md:col-span-6">
            <ul className="divide-y">
              {ret.deductions.map((l) => (
                <FormRow key={l.item} line={shown(l)} />
              ))}
              <FormRow line={{ item: '14', label: 'Tax payable (12 less 13)', tax: rm(ret.item14) }} strong />
            </ul>
          </BentoCard>

          {notes.length > 0 ? (
            <BentoCard className="col-span-2 md:col-span-12">
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <div className="space-y-1">
                  {notes.map((n) => (
                    <p key={n} className="text-xs text-muted-foreground">
                      {n}
                    </p>
                  ))}
                </div>
              </div>
            </BentoCard>
          ) : null}
      {/* Part D */}
      <BentoCard
        title="Part D"
        subtitle="Sales / services exempted from tax / non-taxable service"
        icon={ShieldCheck}
        className="col-span-2 md:col-span-12"
      >
        <p className="text-sm text-muted-foreground">
          {service ? 'Part D is' : 'Item 18 (sales of taxable goods / taxable services) is'} worked out once invoice lines can carry
          an exemption reason.
        </p>
      </BentoCard>
    </>
  );
}

/* ------------------------------------------------------------------ */

type Loaded = {
  settings: SstSettings | null;
  suggestedNumber: string | null;
  companyName: string;
  today: string;
  /** An owner or admin outside the demo: saves the settings and marks returns filed. */
  canDecide: boolean;
  rows: (span: { start: string; end: string }) => Promise<{ lines: SstLineRow[]; credits: SstCreditRow[] }>;
  filed: (type: SstReturn['type']) => Promise<Record<string, string>>;
  /** The typed-in figures of one tax type: period start → figures. */
  figures: (type: SstReturn['type']) => Promise<Record<string, SstTypedFigures>>;
  /** The invoices a payment-basis service return follows: the money received and the credit notes issued. */
  paid: (span: { start: string; end: string }) => Promise<SstPaidInvoice[]>;
  /** Money received in the period that settles no invoice, which the return cannot count. */
  noInvoice: (span: { start: string; end: string }) => Promise<SstNoInvoiceMoney>;
};

/**
 * What the screen is built from. Every member reads it; an owner or admin outside the demo is given Save and the
 * filed marks, by the same check the Expenses screen offers Approve with (`sign-off-finance`). A failed settings
 * or rows read throws, so a form is never shown empty over numbers that are stored. The company's SST no. is only
 * a suggestion. Without a database: the sample settings over no rows.
 */
async function load(): Promise<Loaded> {
  if (!hasSupabaseEnv()) {
    return {
      settings: SAMPLE_SETTINGS,
      suggestedNumber: null,
      companyName: SAMPLE_COMPANY,
      today: SAMPLE_TODAY,
      canDecide: false,
      rows: async () => ({ lines: [], credits: [] }),
      filed: async () => ({}),
      figures: async () => ({}),
      paid: async () => [],
      noInvoice: async () => ({ count: 0, amount_myr: 0 }),
    };
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const [settings, company] = await Promise.all([
    getSstSettings(ctx),
    // Only a suggestion and a name: when the company details cannot be read, the screen is shown without them.
    getCompany().then(
      (c) => c,
      (error: unknown) => {
        console.error('[finance] the company details could not be read:', error);
        return null;
      },
    ),
  ]);
  return {
    settings,
    suggestedNumber: company?.sstNo.trim() || null,
    companyName: company?.name || viewer.orgName,
    today: todayInMalaysia(new Date()),
    canDecide: expensesScreenPlan(viewer.role, viewer.isDemo).canDecide,
    rows: (span) => readSstRows(ctx, span),
    filed: (type) => listSstFiled(ctx, type),
    figures: (type) => listSstFigures(ctx, type),
    paid: (span) => readSstPaidInvoices(ctx, span),
    noInvoice: (span) => readSstNoInvoiceMoney(ctx, span),
  };
}

export default async function SstReportScreen({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const params = searchParams ? await searchParams : {};
  const data = await load();
  const { settings, today } = data;

  const card = (
    <SstSettingsCard
      settings={settings}
      suggestedNumber={data.suggestedNumber}
      today={today}
      save={data.canDecide ? saveSstSettingsAction : undefined}
    />
  );

  if (!settings) {
    return (
      <ScreenContainer>
        <Header />
        <BentoGrid>
          {card}
          <BentoCard tone="muted" className="col-span-2 md:col-span-12">
            <p className="text-sm text-muted-foreground">Set your taxable period above to see your return.</p>
          </BentoCard>
        </BentoGrid>
      </ScreenContainer>
    );
  }

  const view = pickSstView(params, settings, today);
  const periods = recentSstPeriods(today, settings.period_start_month);
  // One read covers the shown period (which may be older than the list) and the twelve listed periods.
  const oldest = periods[periods.length - 1].start;
  const span = { start: view.period.start < oldest ? view.period.start : oldest, end: periods[0].end };
  // The figures are read once too, and each period is built with its own (none is zeros).
  // Payment basis counts money received, so its service return reads the receipts as well (and only then).
  const onPayments = view.type === 'service' && settings.service_tax_basis === 'payment';
  const [{ lines: rows, credits }, filed, figures, paid, noInvoice] = await Promise.all([
    data.rows(span),
    data.filed(view.type),
    data.figures(view.type),
    onPayments ? data.paid(span) : Promise.resolve([]),
    // Money that settles no invoice is named on the shown period alone: no figure of the return is built from it.
    view.type === 'service' ? data.noInvoice(view.period) : Promise.resolve(undefined),
  ]);
  const build = (period: SstPeriod) =>
    buildSstReturn(view.type, period, rows, credits, figures[period.start], {
      basis: onPayments ? 'payment' : 'invoice',
      paid,
    });

  const ret = build(view.period);
  const periodRows: SstPeriodRow[] = periods.map((p) => ({
    start: p.start,
    label: sstPeriodLabel(p),
    due: displayDate(p.due),
    payable: rm(build(p).item14),
    filedOn: filed[p.start] ? displayDate(filed[p.start]) : null,
    ended: today > p.end,
  }));
  const choices: SstPeriod[] = periods.some((p) => p.start === view.period.start) ? periods : [...periods, view.period];

  return (
    <ScreenContainer>
      <Header
        actions={
          <SstReturnPicker
            type={view.type}
            periodStart={view.period.start}
            periods={choices.map((p) => ({ start: p.start, label: sstPeriodLabel(p) }))}
          />
        }
      />
      <BentoGrid>
        {card}
        <SstReturnBody
          ret={ret}
          settings={settings}
          companyName={data.companyName}
          noInvoice={noInvoice}
          filedOn={filed[view.period.start] ?? null}
        />
        <SstFiguresCard
          key={`${view.type}-${view.period.start}`}
          type={view.type}
          periodStart={view.period.start}
          figures={figures[view.period.start] ?? NO_TYPED_FIGURES}
          filed={Boolean(filed[view.period.start])}
          save={data.canDecide ? saveSstFiguresAction : undefined}
        />
        <SstPeriodsCard
          type={view.type}
          shownStart={view.period.start}
          rows={periodRows}
          mark={data.canDecide ? markSstReturnFiledAction : undefined}
          unmark={data.canDecide ? unmarkSstReturnFiledAction : undefined}
        />
        {/* What the return does not count yet */}
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

function Header({ actions }: { actions?: ReactNode }) {
  return (
    <PageHeader
      title="SST Report"
      subtitle="A summary of your SST-02 return to copy into MySST. Nothing is sent to Customs (JKDM) from here."
      actions={actions}
    />
  );
}
