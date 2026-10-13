import { PieChart, ReceiptText, TrendingUp, Users } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series, type Slice } from '@/components/charts';
import { PayslipDetail } from '@/components/people/payslip-detail';
import { PayslipEditor } from '@/components/people/payslip-editor';
import { PayslipDialog, RunActions, RunPayrollDialog, RunPicker } from '@/components/people/payroll-run-controls';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { todayInMalaysia } from '@/lib/people/dates';
import {
  DRAFT_BANNER,
  NO_MONTH_TO_RUN,
  draftBlocksRun,
  earlierOvertimeCount,
  earlierOvertimeLine,
  emptyRunNote,
  headcountNote,
  notOnRun,
  notOnRunLine,
  paidLine,
  readPayroll,
  runControls,
  runIdFromParam,
  runMonthChoice,
} from '@/lib/people/payroll';
import { centsToRinggit } from '@/lib/people/payroll-forms';
import type { StatutoryField } from '@/lib/people/types';
import { HrOnlyScreen, LOAD_FAILED, LaterButton, Muted, StatusPill, loadPeople } from './parts';

const COST_SERIES: Series[] = [{ key: 'value', label: 'Gross (RM)', color: 'var(--chart-1)' }];
const DEDUCTION_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

const STATUS_LABEL = { draft: 'Draft', paid: 'Paid', pending: 'Pending' } as const;

const FIGURE_CELL = 'whitespace-nowrap text-right tabular-nums text-muted-foreground';

/** A statutory figure in the table, with a small mark when an owner typed over the proposed amount. */
function Figure({ cents, field, setByHr }: { cents: number; field: StatutoryField; setByHr: StatutoryField[] }) {
  return (
    <TableCell className={FIGURE_CELL}>
      {setByHr.includes(field) ? (
        <span
          title="Set by HR"
          className="mr-1.5 rounded bg-muted px-1 py-0.5 align-middle text-[0.65rem] text-muted-foreground"
        >
          set by HR
        </span>
      ) : null}
      {centsToRinggit(cents)}
    </TableCell>
  );
}

/**
 * The payroll run chosen with `?run=` (else the newest) and its payslips. Owners and admins only. A draft can be
 * recalculated, marked as paid or deleted, and each payslip opens to be adjusted; a paid run can be undone.
 * In the demo the same screen is read-only.
 */
export default async function PayrollScreen({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const runId = runIdFromParam(((await searchParams) ?? {}).run);
  const { model: loaded, viewer } = await loadPeople('payroll', async (data, _now, ctx) => {
    const payroll = await readPayroll(data, ctx.viewer, runId);
    // Who is not on a draft: the directory is readable by the team, and a draft is the only run that can change.
    const employees = payroll?.latest?.status === 'draft' ? await data.listEmployees() : [];
    return { payroll, employees };
  });
  const model = loaded?.payroll ?? null;
  if (!viewer.isHr && !viewer.isDemo) return <HrOnlyScreen title="Payroll" />;

  const latest = model?.latest ?? null;
  const controls = runControls(latest, viewer);
  const dash = '—';
  // "Other" is left out of the donut and its legend when it is nothing.
  const slices: Slice[] = (model?.deductions ?? []).filter((d) => d.key !== 'other' || d.value > 0).map((d, index) => ({
    key: d.key,
    label: d.label,
    value: d.value / 100,
    color: DEDUCTION_COLORS[index % DEDUCTION_COLORS.length],
  }));
  const noRun = <Muted>No payroll run yet</Muted>;
  const blocked = draftBlocksRun(model?.runs ?? []);
  const monthChoice = runMonthChoice(model?.runs ?? [], todayInMalaysia(new Date()));
  // Facts about the draft itself, worked out from its payslips each time the page loads, so they outlast the dialog.
  const draftNotes =
    latest && latest.status === 'draft'
      ? [
          earlierOvertimeLine(earlierOvertimeCount(latest.slips, latest.period_month)),
          notOnRunLine(notOnRun(loaded?.employees ?? [], latest.slips, latest.run_id, latest.period_month)),
        ].filter((note): note is string => note !== null)
      : [];
  const emptyNote = latest ? emptyRunNote(latest) : null;

  return (
    <ScreenContainer>
      <PageHeader
        title="Payroll"
        subtitle={latest ? `${latest.label} · ${STATUS_LABEL[latest.status]}` : 'Monthly payroll runs'}
        actions={
          <>
            {model ? <RunPicker runs={model.runs} currentId={latest?.run_id ?? null} /> : null}
            <LaterButton variant="outline" size="sm" compact>Export</LaterButton>
            {viewer.isDemo || !model ? (
              <LaterButton size="sm">Run payroll</LaterButton>
            ) : blocked !== null || monthChoice === null ? (
              <span className="inline-flex items-center gap-2">
                <Button type="button" size="sm" disabled>
                  Run payroll
                </Button>
                <span className="text-xs text-muted-foreground">{blocked ?? NO_MONTH_TO_RUN}</span>
              </span>
            ) : (
              <RunPayrollDialog choice={monthChoice} />
            )}
          </>
        }
      />

      <BentoGrid>
        {latest && (latest.status === 'draft' || latest.paid_at) ? (
          <BentoCard className="col-span-2 md:col-span-12">
            <div className="space-y-3">
              <p className="text-sm font-medium">
                {latest.status === 'draft' ? `${latest.label}: ${DRAFT_BANNER}` : `${latest.label}: ${paidLine(latest)}`}
              </p>
              {emptyNote ? <p className="text-sm text-muted-foreground">{emptyNote}</p> : null}
              {draftNotes.map((note) => (
                <p key={note} className="text-sm text-muted-foreground">
                  {note}
                </p>
              ))}
              {controls.recalculate || controls.undoPaid ? (
                <RunActions
                  runId={latest.run_id}
                  monthText={latest.label}
                  headcount={latest.headcount}
                  controls={controls}
                />
              ) : null}
            </div>
          </BentoCard>
        ) : null}

        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Gross payroll"
            value={model ? (latest ? centsToRinggit(latest.gross_cents) : dash) : dash}
            delta={latest?.label}
            deltaTone="flat"
            onPrimary
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Net pay"
            value={model ? (latest ? centsToRinggit(latest.net_cents) : dash) : dash}
            delta={latest ? STATUS_LABEL[latest.status] : undefined}
            deltaTone="flat"
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Deductions"
            value={model ? (latest ? centsToRinggit(latest.deductions_cents) : dash) : dash}
            delta={latest ? 'EPF, SOCSO, EIS, PCB, other' : undefined}
            deltaTone="flat"
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Headcount paid"
            value={model ? (latest ? latest.headcount : dash) : dash}
            delta={latest ? headcountNote(latest) : undefined}
            deltaTone="flat"
          />
        </BentoCard>

        <BentoCard
          title="Gross payroll by month"
          subtitle="The runs on record"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {!model ? LOAD_FAILED : model.by_month.length === 0 ? noRun : (
            <AreaTrend data={model.by_month} series={COST_SERIES} height={240} />
          )}
        </BentoCard>
        <BentoCard
          title="Deductions breakdown"
          subtitle={latest ? latest.label : 'Latest run'}
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          {!model ? LOAD_FAILED : !latest || latest.deductions_cents === 0 ? (
            <Muted>No deductions recorded</Muted>
          ) : (
            <DonutStat
              data={slices}
              height={240}
              centerValue={centsToRinggit(latest.deductions_cents)}
              centerLabel="deductions"
            />
          )}
        </BentoCard>

        <BentoCard
          title="Payslips"
          subtitle={latest ? `${latest.label} · open a name to see the payslip` : 'Latest run'}
          icon={ReceiptText}
          flush
          className="col-span-2 md:col-span-12"
        >
          {!model ? LOAD_FAILED : !latest ? noRun : latest.slips.length === 0 ? (
            <Muted>This run has no payslips</Muted>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead>Employee</TableHead>
                      <TableHead className="text-right">Gross</TableHead>
                      <TableHead className="text-right">EPF</TableHead>
                      <TableHead className="text-right">SOCSO</TableHead>
                      <TableHead className="text-right">EIS</TableHead>
                      <TableHead className="text-right">PCB</TableHead>
                      <TableHead className="text-right">Other</TableHead>
                      <TableHead className="text-right">Deductions</TableHead>
                      <TableHead className="text-right">Net</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {latest.slips.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="whitespace-nowrap font-medium">
                          <PayslipDialog name={s.employee_name} monthText={latest.label}>
                            {controls.recalculate ? (
                              <PayslipEditor payslip={s} />
                            ) : (
                              <PayslipDetail payslip={s} editable={false} />
                            )}
                          </PayslipDialog>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">
                          {centsToRinggit(s.gross_cents)}
                        </TableCell>
                        <Figure cents={s.epf_cents} field="epf" setByHr={s.set_by_hr} />
                        <Figure cents={s.socso_cents} field="socso" setByHr={s.set_by_hr} />
                        <Figure cents={s.eis_cents} field="eis" setByHr={s.set_by_hr} />
                        <Figure cents={s.pcb_cents} field="pcb" setByHr={s.set_by_hr} />
                        <TableCell className={FIGURE_CELL}>{centsToRinggit(s.other_deductions_cents)}</TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">
                          {centsToRinggit(s.deductions_cents)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums">
                          {centsToRinggit(s.net_cents)}
                        </TableCell>
                        <TableCell>
                          <StatusPill tone={s.status === 'paid' ? 'good' : 'pending'}>
                            {STATUS_LABEL[s.status]}
                          </StatusPill>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="flex items-center gap-2 border-t px-4 py-3 text-sm text-muted-foreground">
                <Users className="size-4" />
                <span>
                  {latest.slips.length} {latest.slips.length === 1 ? 'payslip' : 'payslips'} in this run
                </span>
              </div>
            </>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
