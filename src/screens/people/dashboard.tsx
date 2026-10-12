import { Banknote, ChartColumn, Download, PieChart, TrendingUp, UsersRound } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, BarGroup, DonutStat, Sparkline, type Series, type Slice } from '@/components/charts';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { buildDashboardModel, dashboardAttendanceFrom } from '@/lib/people/company';
import { monthYearLabel, todayInMalaysia } from '@/lib/people/dates';
import { isTeamView } from '@/lib/people/own';
import { rm } from '@/lib/reach/format';
import { HR_ONLY, LOAD_FAILED, LaterButton, Muted, loadPeople } from './parts';

const ATTENDANCE_SERIES: Series[] = [{ key: 'rate', label: 'Present or late, of recorded days', color: 'var(--chart-1)' }];
const DEPT_SERIES: Series[] = [{ key: 'headcount', label: 'Headcount', color: 'var(--chart-1)' }];
const JOINER_SERIES: Series[] = [{ key: 'joiners', label: 'Joiners', color: 'var(--chart-2)' }];
const PAYROLL_SERIES: Series[] = [{ key: 'payroll', label: 'Gross pay (RM)', color: 'var(--chart-3)' }];
const LEAVE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-5)', 'var(--chart-3)', 'var(--chart-4)'];

/**
 * Company-wide HR figures. Everyone sees the headcount and the departments (the
 * staff directory is shared); the rest is built from rows the database only
 * returns to HR (or in the demo), so a member sees a notice in its place.
 */
export default async function DashboardScreen() {
  const { model } = await loadPeople('dashboard', async (data, now, ctx) => {
    const today = todayInMalaysia(now);
    const team = isTeamView(ctx.viewer);
    const employees = await data.listEmployees();
    if (!team) {
      return buildDashboardModel({ employees, leave: [], attendance: [], runs: [], payslips: [] }, today, false);
    }
    const [leave, attendance, runs, payslips] = await Promise.all([
      data.listLeaveRequests(),
      data.listAttendance(dashboardAttendanceFrom(today), today),
      data.listPayrollRuns(),
      data.listPayslips(),
    ]);
    return buildDashboardModel({ employees, leave, attendance, runs, payslips }, today, true);
  });

  const dash = '—';
  const clockedIn = model?.attendanceToday?.clocked_in;
  const latest = model?.payroll?.latest ?? null;
  const leaveSlices: Slice[] = (model?.leaveByType ?? []).map((entry, index) => ({
    key: entry.label,
    label: entry.label,
    value: entry.days,
    color: LEAVE_COLORS[index % LEAVE_COLORS.length],
  }));
  const leaveTotal = Math.round(leaveSlices.reduce((sum, s) => sum + s.value, 0) * 10) / 10;
  // Weeks with no recorded days are left out rather than plotted as 0.
  const attendanceRows: { label: string; rate: number }[] = [];
  for (const week of model?.weeklyAttendance ?? []) {
    if (week.value !== null) attendanceRows.push({ label: week.label, rate: week.value });
  }
  const departmentRows = (model?.departments ?? []).map((d) => ({ label: d.department, headcount: d.headcount }));

  return (
    <ScreenContainer>
      <PageHeader
        title="HR Dashboard"
        subtitle="People operations across your workspace."
        actions={
          <LaterButton variant="outline" size="sm" icon={Download}>
            Export
          </LaterButton>
        }
      />

      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Headcount"
            value={model ? model.headcount : dash}
            onPrimary
            chart={
              model ? (
                <Sparkline data={model.trend.map((t) => t.headcount)} color="var(--primary-foreground)" height={36} />
              ) : undefined
            }
          />
          <p className="mt-1 text-xs text-primary-foreground/70">Today&apos;s staff by join date</p>
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-4">
          <BentoStat
            label="Clocked in so far today"
            value={!model || !model.team || clockedIn == null ? dash : String(clockedIn)}
          />
          {model && !model.team ? <p className="mt-1 text-xs text-muted-foreground">Shown to HR admins</p> : null}
        </BentoCard>
        <BentoCard className="col-span-2 md:col-span-5">
          <BentoStat
            label="Payroll, latest run"
            value={!model || !model.team || !latest ? dash : rm(latest.gross_cents)}
          />
          {model && !model.team ? (
            <p className="mt-1 text-xs text-muted-foreground">Shown to HR admins</p>
          ) : latest ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {monthYearLabel(latest.period_month)}
              {latest.headcount === 0 ? ' · no payslips' : ''}
            </p>
          ) : null}
        </BentoCard>

        <BentoCard
          title="Attendance trend"
          subtitle="Present or late, share of recorded days per week"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {!model ? (
            LOAD_FAILED
          ) : !model.team ? (
            HR_ONLY
          ) : attendanceRows.length === 0 ? (
            <Muted>No attendance recorded in the last 8 weeks</Muted>
          ) : (
            <AreaTrend data={attendanceRows} series={ATTENDANCE_SERIES} height={240} />
          )}
        </BentoCard>
        <BentoCard
          title="Leave this month"
          subtitle="Approved days"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          {!model ? (
            LOAD_FAILED
          ) : !model.team ? (
            HR_ONLY
          ) : leaveSlices.length === 0 ? (
            <Muted>No approved leave this month</Muted>
          ) : (
            <DonutStat data={leaveSlices} height={240} centerValue={String(leaveTotal)} centerLabel="days" />
          )}
        </BentoCard>

        <BentoCard
          title="Headcount by department"
          subtitle="Active employees"
          icon={ChartColumn}
          className="col-span-2 md:col-span-8"
        >
          {!model ? (
            LOAD_FAILED
          ) : departmentRows.length === 0 ? (
            <Muted>No employees yet</Muted>
          ) : (
            <BarGroup data={departmentRows} series={DEPT_SERIES} height={240} />
          )}
        </BentoCard>
        <BentoCard
          title="Joiners"
          subtitle="Last 6 months, by join date"
          icon={UsersRound}
          className="col-span-2 md:col-span-4"
        >
          {!model ? (
            LOAD_FAILED
          ) : !model.team ? (
            HR_ONLY
          ) : model.joiners?.every((j) => j.joiners === 0) ? (
            <Muted>Nobody joined in the last 6 months</Muted>
          ) : (
            <BarGroup data={model.joiners ?? []} series={JOINER_SERIES} height={240} />
          )}
        </BentoCard>

        <BentoCard
          title="Payroll cost"
          subtitle="Gross pay by month"
          icon={Banknote}
          className="col-span-2 md:col-span-12"
        >
          {!model ? (
            LOAD_FAILED
          ) : !model.team ? (
            HR_ONLY
          ) : !model.payroll || model.payroll.byMonth.length === 0 ? (
            <Muted>No payroll runs yet</Muted>
          ) : (
            <AreaTrend data={model.payroll.byMonth} series={PAYROLL_SERIES} height={220} />
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
