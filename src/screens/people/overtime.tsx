import { Clock, TrendingUp, Wallet } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { BarGroup, type Series } from '@/components/charts';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { LiveDot } from '@/components/ui/live-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { OVERTIME_TABLE_LIMIT, buildOvertimeView } from '@/lib/people/attendance';
import { formatDay, todayInMalaysia } from '@/lib/people/dates';
import { overtimeAmountText } from '@/lib/people/overtime';
import { REQUEST_STATUS_LABEL } from '@/lib/people/own';
import { rm } from '@/lib/reach/format';
import { EmployeeCell, HR_ONLY, LOAD_FAILED, Muted, StatusPill, loadPeople, requestTone } from './parts';

const MONTH_SERIES: Series[] = [{ key: 'hours', label: 'OT hours', color: 'var(--chart-2)' }];

/** Overtime hours and cost. HR and the demo see the team; anyone else sees only their own records. */
export default async function OvertimeScreen() {
  const { model } = await loadPeople('overtime', async (data, now, ctx) => {
    const [records, employees] = await Promise.all([data.listOvertime(), data.listEmployees()]);
    return buildOvertimeView({ records, employees, viewer: ctx.viewer, today: todayInMalaysia(now) });
  });

  const dash = '—';
  const team = model?.team ?? true;
  const month = model?.model.month;
  const hasHistory = (model?.model.by_month ?? []).some((b) => b.value > 0);

  return (
    <ScreenContainer>
      <PageHeader title="Overtime" subtitle={team ? 'Overtime hours and cost' : 'Your overtime records'} />

      <BentoGrid>
        {team ? (
          <>
            <BentoCard tone="primary" className="col-span-1 md:col-span-3">
              <BentoStat
                label="Hours this month"
                value={month ? month.hours : dash}
                delta={month ? `${month.approved_hours} approved` : undefined}
                deltaTone="flat"
                onPrimary
              />
            </BentoCard>
            <BentoCard className="col-span-1 md:col-span-3">
              <BentoStat
                label="Cost this month"
                value={month ? rm(month.amount_cents) : dash}
                delta="approved and pending"
                deltaTone="flat"
              />
            </BentoCard>
            <BentoCard className="col-span-1 md:col-span-3">
              <BentoStat
                label="Pending approval"
                value={month ? `${month.pending_hours}h` : dash}
                delta={month ? `${month.pending_count} ${month.pending_count === 1 ? 'claim' : 'claims'}` : undefined}
                deltaTone="flat"
              />
            </BentoCard>
            <BentoCard className="col-span-1 md:col-span-3">
              <BentoStat label="People with overtime" value={model ? model.model.people_with_overtime : dash} />
            </BentoCard>
          </>
        ) : null}

        <BentoCard
          title="Hours by month"
          subtitle="Approved and pending · last 6 months"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {!model ? (
            LOAD_FAILED
          ) : !model.team ? (
            HR_ONLY
          ) : !hasHistory ? (
            <Muted>No overtime in the last six months</Muted>
          ) : (
            <BarGroup data={model.model.by_month.map((b) => ({ label: b.label, hours: b.value }))} series={MONTH_SERIES} height={240} />
          )}
        </BentoCard>
        <BentoCard
          title={team ? 'Rates in use' : 'Rates on your records'}
          subtitle={team ? 'Multipliers on all records' : 'Multipliers on record'}
          icon={Clock}
          className="col-span-2 md:col-span-4"
        >
          {!model ? (
            LOAD_FAILED
          ) : model.model.by_rate.length === 0 ? (
            <Muted>No overtime recorded yet</Muted>
          ) : (
            <ul className="divide-y text-sm">
              {model.model.by_rate.map((entry) => (
                <li key={entry.rate} className="flex items-center justify-between py-2">
                  <span className="font-medium tabular-nums">{entry.label}</span>
                  {model.team ? (
                    <span className="tabular-nums text-muted-foreground">
                      {entry.hours}h · {rm(entry.amount_cents)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </BentoCard>

        <BentoCard
          title="Overtime records"
          subtitle={
            model
              ? `${team ? 'Newest first' : 'Your records, newest first'}${model.truncated ? ` · latest ${OVERTIME_TABLE_LIMIT}` : ''}`
              : undefined
          }
          icon={Wallet}
          flush
          className="col-span-2 md:col-span-12"
        >
          {!model ? (
            LOAD_FAILED
          ) : model.records.length === 0 ? (
            <Muted>No overtime records yet</Muted>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Employee</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Hours</TableHead>
                    <TableHead>Rate</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {model.records.map((record) => (
                    <TableRow key={record.id}>
                      <TableCell>
                        <EmployeeCell name={record.employee_name} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatDay(record.work_date)}</TableCell>
                      <TableCell className="text-right tabular-nums">{record.hours}</TableCell>
                      <TableCell className="tabular-nums">{record.rate_multiplier}x</TableCell>
                      <TableCell className="whitespace-nowrap text-right font-medium tabular-nums">
                        {overtimeAmountText(record)}
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={record.status === 'pending'} />
                          <StatusPill tone={requestTone(record.status)}>{REQUEST_STATUS_LABEL[record.status]}</StatusPill>
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
