import { CalendarRange, ChartColumn } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { BarGroup, type Series } from '@/components/charts';
import { TimesheetGrid } from '@/components/people/timesheet-grid';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { buildTimesheet, type WeekView } from '@/lib/people/attendance';
import { addDays, formatDay, todayInMalaysia } from '@/lib/people/dates';
import { parseWeek } from '@/lib/people/roster';
import { EmployeeCell, HR_ONLY, LOAD_FAILED, Muted, loadPeople } from './parts';
import { WeekNav } from './week-nav';

const BY_EMPLOYEE_SERIES: Series[] = [
  { key: 'hours', label: 'Hours', color: 'var(--chart-1)' },
  { key: 'billable_hours', label: 'Billable', color: 'var(--chart-2)' },
];

const hours = (value: number | null) => (value === null ? '—' : value.toFixed(1));

const SUBTITLE: Record<WeekView, string> = {
  hr: 'Team hours',
  demo: 'Team hours',
  manager: "Your team's hours",
  self: 'Your hours',
};

/**
 * One week's hours (`?week=` is the Monday; this week without it). Staff type their own hours for this week and
 * last; owners and admins correct anyone's. HR and the demo see the team; a manager their direct reports and
 * themselves; anyone else their own row.
 */
export default async function TimesheetScreen({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = ((await searchParams) ?? {}).week;
  const { model } = await loadPeople('timesheet', async (data, now, ctx) => {
    const today = todayInMalaysia(now);
    const week = parseWeek(raw, today);
    const [entries, employees] = await Promise.all([data.listTimesheet(week, addDays(week, 6)), data.listEmployees()]);
    return buildTimesheet({
      entries,
      employees,
      viewer: ctx.viewer,
      today,
      week,
    });
  });

  const dash = '—';
  const team = model?.team ?? true;

  return (
    <ScreenContainer>
      <PageHeader
        title="Timesheet"
        subtitle={
          model
            ? `${SUBTITLE[model.view]} by day · week of ${formatDay(model.week_start)} to ${formatDay(model.week_end)}`
            : 'Hours by day'
        }
        actions={model ? <WeekNav path="/people/timesheet" nav={model.nav} /> : null}
      />

      <BentoGrid>
        {team ? (
          <>
            <BentoCard tone="primary" className="col-span-1 md:col-span-4">
              <BentoStat label="Total hours" value={model ? hours(model.totals.hours) : dash} onPrimary />
            </BentoCard>
            <BentoCard className="col-span-1 md:col-span-4">
              <BentoStat label="Billable hours" value={model ? hours(model.totals.billable_hours) : dash} />
            </BentoCard>
            <BentoCard className="col-span-2 md:col-span-4">
              <BentoStat
                label="Billable share"
                value={model?.totals.billable_share == null ? dash : `${model.totals.billable_share}%`}
              />
            </BentoCard>
          </>
        ) : null}

        <BentoCard
          title="Hours by employee"
          subtitle="Total and billable"
          icon={ChartColumn}
          className="col-span-2 md:col-span-12"
        >
          {!model ? (
            LOAD_FAILED
          ) : !model.team ? (
            HR_ONLY
          ) : model.by_employee.length === 0 ? (
            <Muted>No hours logged in this week</Muted>
          ) : (
            <BarGroup
              data={model.by_employee.map((row) => ({
                label: row.employee,
                hours: row.hours,
                billable_hours: row.billable_hours,
              }))}
              series={BY_EMPLOYEE_SERIES}
              height={260}
              showLegend
            />
          )}
        </BentoCard>

        <BentoCard
          title="Weekly timesheet"
          subtitle={
            team
              ? 'Hours logged per day'
              : model?.view === 'manager'
                ? 'You and the people who report to you'
                : model?.editable
                  ? 'Your records · you can record this week and last week'
                  : 'Your records'
          }
          icon={CalendarRange}
          flush
          className="col-span-2 md:col-span-12"
        >
          {!model ? (
            LOAD_FAILED
          ) : !model.editable && model.rows.length === 0 ? (
            <Muted>No hours logged in this week</Muted>
          ) : (
            <>
              {model.editable ? (
                <TimesheetGrid key={model.week_start} days={model.days} rows={model.rows} />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40">
                        <TableHead>Employee</TableHead>
                        {model.days.map((d) => (
                          <TableHead key={d.date} className="text-right">
                            {d.label}
                          </TableHead>
                        ))}
                        <TableHead className="text-right">Billable</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {model.rows.map((row) => (
                        <TableRow key={row.employee_id}>
                          <TableCell>
                            <EmployeeCell name={row.name} />
                          </TableCell>
                          {row.per_day.map((value, i) => (
                            <TableCell key={model.days[i].date} className="text-right tabular-nums">
                              {hours(value)}
                            </TableCell>
                          ))}
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {hours(row.billable)}
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">{hours(row.total)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {team ? (
                <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
                  <span>
                    {model.totals.members} {model.totals.members === 1 ? 'member' : 'members'}
                  </span>
                  <span className="tabular-nums">
                    {hours(model.totals.billable_hours)}h billable · {hours(model.totals.hours)}h total
                  </span>
                </div>
              ) : null}
            </>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
