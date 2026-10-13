import { AlarmClock, CalendarCheck, Clock, LogIn, LogOut, TrendingUp, Umbrella } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, HeatGrid, type Series, type Slice } from '@/components/charts';
import { ClockButtons } from '@/components/people/clock-buttons';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { Button } from '@/components/ui/button';
import { LiveDot } from '@/components/ui/live-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { attendanceWindowStart, buildMyAttendance, clockButtonLabel, ownDayToday, workWeekFor } from '@/lib/people/attendance';
import { clockAction, todayLine, todayState, type TodayState } from '@/lib/people/attendance-forms';
import { timeInMalaysia, todayInMalaysia } from '@/lib/people/dates';
import { LOAD_FAILED, Muted, NotLinkedCard, StatusPill, loadPeople } from './parts';
import { DEMO_SIGN_UP_NOTE } from './my-requests';

const HOURS_SERIES: Series[] = [{ key: 'hours', label: 'Hours worked', color: 'var(--chart-1)' }];
const LEAVE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-3)', 'var(--muted-foreground)'];

/** The signed-in employee's own attendance. An owner's is the owner's, never the team's. */
export default async function MyAttendanceScreen() {
  const { model: loaded, viewer } = await loadPeople('my-attendance', async (data, now, ctx) => {
    const today = todayInMalaysia(now);
    // Not linked to an employee: nothing to read, the builder answers "not linked".
    if (ctx.viewer.employeeId === null) {
      const model = buildMyAttendance({ days: [], leave: [], balances: [], viewer: ctx.viewer, today });
      return { model, state: { kind: 'not_linked' } as TodayState };
    }
    // Only HR (and the sample company) may read the work week; `workWeekFor` says what anyone else gets.
    const knowsWeek = ctx.viewer.isHr || ctx.viewer.isDemo;
    const [days, leave, balances, holidays, settings] = await Promise.all([
      data.listAttendance(attendanceWindowStart(today), today),
      data.listLeaveRequests(),
      data.listLeaveBalances(Number(today.slice(0, 4))),
      data.listPublicHolidays(),
      knowsWeek ? data.getSettings() : Promise.resolve(null),
    ]);
    const model = buildMyAttendance({ days, leave, balances, viewer: ctx.viewer, today });
    const state = todayState({
      today,
      day: ownDayToday(days, ctx.viewer, today),
      workWeek: workWeekFor(settings),
      holidays,
      leave,
      employeeId: ctx.viewer.employeeId,
      nowHm: timeInMalaysia(now),
    });
    return { model, state };
  });
  const model = loaded?.model ?? null;
  const state = loaded?.state ?? null;
  const action = state ? clockAction(state) : null;

  const dash = '—';
  const leaveMix: Slice[] = (model?.leave_by_type ?? []).map((row, index) => ({
    key: row.key,
    label: row.label,
    value: row.days,
    color: LEAVE_COLORS[index % LEAVE_COLORS.length],
  }));

  return (
    <ScreenContainer>
      <PageHeader
        title="My Attendance"
        subtitle="Your clock-ins, hours and leave balance."
      />

      <BentoGrid>
        {model && !model.linked ? (
          <NotLinkedCard />
        ) : (
          <>
            {state ? (
              <BentoCard title="Today" icon={LogIn} className="col-span-2 md:col-span-12">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <p className="text-sm font-medium" data-testid="today-line">
                    {todayLine(state)}
                  </p>
                  {viewer.isDemo ? (
                    <span className="flex flex-col items-start gap-1 md:items-end">
                      {action ? (
                        <Button type="button" size="sm" disabled>
                          {action === 'in' ? <LogIn aria-hidden /> : <LogOut aria-hidden />}
                          {clockButtonLabel(action, false)}
                        </Button>
                      ) : null}
                      <span className="text-xs text-muted-foreground">{DEMO_SIGN_UP_NOTE}</span>
                    </span>
                  ) : (
                    <ClockButtons action={action} />
                  )}
                </div>
              </BentoCard>
            ) : null}
            <BentoCard tone="primary" className="col-span-1 md:col-span-3">
              <BentoStat
                label="Days present"
                value={model ? model.month.present : dash}
                delta={model ? `of ${model.month.recorded} recorded days` : undefined}
                deltaTone="flat"
                onPrimary
              />
            </BentoCard>
            <BentoCard className="col-span-1 md:col-span-3">
              <BentoStat label="Average clock-in" value={model?.month.avg_clock_in ?? dash} />
            </BentoCard>
            <BentoCard className="col-span-1 md:col-span-3">
              <BentoStat
                label="Late this month"
                value={model ? model.month.late : dash}
                delta={model ? 'this month' : undefined}
                deltaTone="flat"
              />
            </BentoCard>
            <BentoCard className="col-span-1 md:col-span-3">
              <BentoStat
                label="Annual leave left"
                value={model?.annual_left ?? dash}
                delta={model?.annual_left != null ? 'days left' : undefined}
                deltaTone="flat"
              />
            </BentoCard>

            <BentoCard
              title="Hours worked"
              subtitle="Last 10 recorded days"
              icon={TrendingUp}
              className="col-span-2 md:col-span-8"
            >
              {!model ? (
                LOAD_FAILED
              ) : model.hours.length === 0 ? (
                <Muted>No completed days recorded yet</Muted>
              ) : (
                <AreaTrend data={model.hours} series={HOURS_SERIES} height={240} />
              )}
            </BentoCard>
            <BentoCard
              title="Attendance pattern"
              subtitle="Hours per day · 8 weeks, by week starting"
              icon={CalendarCheck}
              className="col-span-2 md:col-span-4"
              bodyClassName="flex items-center"
            >
              {!model ? (
                LOAD_FAILED
              ) : model.pattern.values.flat().every((v) => v === 0) ? (
                <Muted>No hours recorded in the last 8 weeks</Muted>
              ) : (
                <HeatGrid
                  xLabels={model.pattern.days}
                  yLabels={model.pattern.weeks}
                  values={model.pattern.values}
                  color="var(--chart-1)"
                />
              )}
            </BentoCard>

            <BentoCard
              title="Leave taken by type"
              subtitle="Approved · this year"
              icon={Umbrella}
              className="col-span-2 md:col-span-4"
            >
              {!model ? (
                LOAD_FAILED
              ) : leaveMix.length === 0 ? (
                <Muted>No approved leave this year</Muted>
              ) : (
                <DonutStat
                  data={leaveMix}
                  height={240}
                  centerValue={String(model.leave_total)}
                  centerLabel="days taken"
                />
              )}
            </BentoCard>

            <BentoCard
              title="Recent clock-ins"
              subtitle="Clock-in and clock-out history"
              icon={Clock}
              flush
              className="col-span-2 md:col-span-8"
            >
              {!model ? (
                LOAD_FAILED
              ) : model.recent.length === 0 ? (
                <Muted>No attendance recorded yet</Muted>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40">
                        <TableHead>Date</TableHead>
                        <TableHead>Clock In</TableHead>
                        <TableHead>Clock Out</TableHead>
                        <TableHead>Hours</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {model.recent.map((row) => (
                        <TableRow key={row.work_date}>
                          <TableCell className="whitespace-nowrap font-medium">
                            <span className="flex items-center gap-2">
                              {row.is_today ? <LiveDot active /> : null}
                              {row.date_label}
                            </span>
                          </TableCell>
                          <TableCell className="tabular-nums">
                            <span className="flex items-center gap-1.5">
                              {row.status === 'late' ? <AlarmClock className="size-3.5 text-amber-600" aria-hidden /> : null}
                              {row.clock_in ?? dash}
                            </span>
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {row.no_clock_out ? (
                              <span className="text-xs text-amber-600">No clock-out</span>
                            ) : (
                              (row.clock_out ?? dash)
                            )}
                          </TableCell>
                          <TableCell className="tabular-nums">{row.hours === null ? dash : row.hours.toFixed(1)}</TableCell>
                          <TableCell>
                            <span className="flex flex-col items-start gap-1">
                              <span className="flex items-center gap-2">
                                <StatusPill tone={row.tone}>{row.status_label}</StatusPill>
                                {row.corrected ? <StatusPill tone="neutral">Corrected</StatusPill> : null}
                              </span>
                              {row.corrected && row.correction_note ? (
                                <span className="max-w-56 whitespace-normal text-xs text-muted-foreground">
                                  Note: {row.correction_note}
                                </span>
                              ) : null}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </BentoCard>
          </>
        )}
      </BentoGrid>
    </ScreenContainer>
  );
}
