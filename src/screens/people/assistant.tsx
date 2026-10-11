import Link from 'next/link';
import {
  Bot,
  Cake,
  CalendarDays,
  ClipboardCheck,
  Gauge,
  PieChart,
  Plane,
  TrendingUp,
  Users,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import {
  AreaTrend,
  BarGroup,
  DonutStat,
  Sparkline,
  type Series,
  type Slice,
} from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { formatDay } from '@/lib/people/dates';
import { approvalsHeading, buildPeopleOverviewModel } from '@/lib/people/overview';
import { AskLekiuHero } from '@/screens/people/ask-lekiu-hero';
import { DEPARTMENT_COLORS, HR_ONLY, LOAD_FAILED, Muted, NOT_AVAILABLE, NotLinkedCard, loadPeople } from '@/screens/people/parts';

/* ---- static config ------------------------------------------------ */

const HEADCOUNT_SERIES: Series[] = [{ key: 'headcount', label: 'Headcount', color: 'var(--chart-1)' }];
const LEAVE_SERIES: Series[] = [{ key: 'days', label: 'Days', color: 'var(--chart-2)' }];

/** Sample crew, shown in the demo workspace only. */
const AGENTS = [
  { name: 'Leave Approver', active: true },
  { name: 'Payroll Assistant', active: true },
  { name: 'Onboarding Guide', active: true },
  { name: 'Attendance Monitor', active: false },
];

const PROMPTS = [
  "Who's on leave today?",
  'Headcount by dept',
  'Pending approvals',
  'Draft a Hari Raya leave notice',
];

const initials = (name: string) =>
  name
    .split(' ')
    .map((w) => w[0])
    .join('');

/* ------------------------------------------------------------------ */

export default async function OverviewScreen() {
  const { model, viewer, chatDemo, hasWorkspace } = await loadPeople('overview', buildPeopleOverviewModel);
  const headcount = model?.totals.headcount ?? 0;
  const noStaff = headcount === 0;
  // Without HR rights the database returns only the viewer's own leave and attendance,
  // so team-titled figures built from them would mislead.
  const teamView = viewer.isHr || viewer.isDemo;
  const heading = approvalsHeading(teamView);
  // A member whose HR record is not linked sees the directory but none of their own records.
  // Only worth saying when there is a team to see: an empty workspace gets the "No employees yet" card.
  const notLinked = hasWorkspace && !teamView && viewer.employeeId === null && model !== null && headcount > 0;
  const noEmployees = hasWorkspace && model !== null && headcount === 0;
  const noWorkspace = !hasWorkspace && model !== null;
  const departmentMix: Slice[] = (model?.departments ?? []).map((d, index) => ({
    key: d.department,
    label: d.department,
    value: d.headcount,
    color: DEPARTMENT_COLORS[index % DEPARTMENT_COLORS.length],
  }));
  const clockedIn = model?.totals.clocked_in_so_far ?? 0;

  return (
    <ScreenContainer>
      <BentoGrid>
        {/* Ask-Lekiu hero */}
        <BentoCard tone="primary" className="col-span-2 md:col-span-12">
          <AskLekiuHero prompts={PROMPTS} isDemo={chatDemo} />
        </BentoCard>

        {notLinked ? (
          <NotLinkedCard />
        ) : null}

        {noEmployees ? (
          <BentoCard title="No employees yet" icon={Users} className="col-span-2 md:col-span-12">
            <p className="text-sm text-muted-foreground">
              {viewer.isHr ? (
                <>
                  No employees have been added yet.{' '}
                  <Link href="/people/employees" className="font-medium text-primary underline-offset-4 hover:underline">
                    Add your first employee
                  </Link>
                  .
                </>
              ) : (
                'No employees have been added yet. An owner or admin of this workspace can add them.'
              )}
            </p>
          </BentoCard>
        ) : null}

        {noWorkspace ? (
          <BentoCard title="No workspace yet" icon={Users} className="col-span-2 md:col-span-12">
            <p className="text-sm text-muted-foreground">
              Create or join a workspace to see your team here.
            </p>
          </BentoCard>
        ) : null}

        {/* KPI row */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Headcount"
            value={model ? String(headcount) : '—'}
            onPrimary
            chart={
              model && !noStaff ? (
                <Sparkline
                  data={model.trend.map((t) => t.headcount)}
                  color="var(--primary-foreground)"
                  height={36}
                />
              ) : undefined
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Clocked in so far today"
            value={model && teamView ? String(clockedIn) : '—'}
          />
          {model && !teamView ? <p className="mt-1 text-xs text-muted-foreground">Shown to HR admins</p> : null}
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="On leave today"
            value={model && teamView ? String(model.totals.on_leave_today) : '—'}
          />
          {model && !teamView ? <p className="mt-1 text-xs text-muted-foreground">Shown to HR admins</p> : null}
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label={heading.title} value={model ? String(model.totals.pending_approvals) : '—'} />
        </BentoCard>

        {/* Headcount trend + department mix */}
        <BentoCard
          title="Headcount over time"
          subtitle="Last 8 months, by join date"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {!model ? LOAD_FAILED : noStaff ? (
            <Muted>No employees yet</Muted>
          ) : (
            <AreaTrend data={model.trend} series={HEADCOUNT_SERIES} height={240} />
          )}
        </BentoCard>
        <BentoCard title="By department" icon={PieChart} className="col-span-2 md:col-span-4">
          {!model ? LOAD_FAILED : noStaff ? (
            <Muted>No employees yet</Muted>
          ) : (
            <DonutStat data={departmentMix} height={240} centerValue={String(headcount)} centerLabel="staff" />
          )}
        </BentoCard>

        {/* Leave by type + attendance + agents */}
        <BentoCard
          title="Leave by type"
          subtitle="Approved days this month"
          icon={Plane}
          className="col-span-2 md:col-span-4"
        >
          {!model ? LOAD_FAILED : !teamView ? HR_ONLY : model.leaveByType.length === 0 ? (
            <Muted>No approved leave this month</Muted>
          ) : (
            <BarGroup data={model.leaveByType} series={LEAVE_SERIES} horizontal height={200} />
          )}
        </BentoCard>
        <BentoCard
          title="Clocked in so far"
          subtitle="Present or late today, not yet a rate"
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          {!model ? LOAD_FAILED : !teamView ? HR_ONLY : clockedIn === 0 ? (
            <Muted>Nobody has clocked in yet today</Muted>
          ) : (
            <p className="text-5xl font-semibold tabular-nums">{clockedIn}</p>
          )}
        </BentoCard>
        <BentoCard
          title="HR AI agents"
          subtitle="Your always-on crew"
          icon={Bot}
          className="col-span-2 md:col-span-4"
        >
          {viewer.isDemo ? (
            <div className="grid grid-cols-1 gap-2">
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
            NOT_AVAILABLE
          )}
        </BentoCard>

        {/* Today's leave + approvals + occasions */}
        <BentoCard
          title="On leave today"
          subtitle={model ? formatDay(model.today) : undefined}
          icon={Plane}
          className="col-span-2 md:col-span-4"
        >
          {!model ? LOAD_FAILED : !teamView ? HR_ONLY : model.onLeave.length === 0 ? (
            <Muted>Nobody is on leave today</Muted>
          ) : (
            <ul className="space-y-2">
              {model.onLeave.map((p) => (
                <li
                  key={`${p.name}-${p.when}`}
                  className="flex items-center gap-3 rounded-lg border bg-background/50 px-3 py-2"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {initials(p.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{p.kind}</p>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{p.when}</span>
                </li>
              ))}
            </ul>
          )}
        </BentoCard>
        <BentoCard
          title={heading.title}
          subtitle={heading.subtitle}
          icon={ClipboardCheck}
          className="col-span-2 md:col-span-4"
        >
          {!model ? LOAD_FAILED : model.approvals.length === 0 ? (
            <Muted>{heading.empty}</Muted>
          ) : (
            <ul className="divide-y">
              {model.approvals.slice(0, 6).map((a) => (
                <li key={`${a.kind}-${a.id}`} className="flex items-center gap-3 py-2">
                  <LiveDot active />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{a.employee}</p>
                    <p className="truncate text-xs text-muted-foreground">{a.detail}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                    {a.type}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </BentoCard>
        <BentoCard
          title="Birthdays & anniversaries"
          subtitle="In the next 30 days"
          icon={Users}
          className="col-span-2 md:col-span-4"
        >
          {!model ? LOAD_FAILED : model.occasions.length === 0 ? (
            <Muted>Nothing coming up</Muted>
          ) : (
            <ul className="space-y-2">
              {model.occasions.slice(0, 5).map((o) => {
                const Icon = o.kind === 'birthday' ? Cake : CalendarDays;
                return (
                  <li
                    key={`${o.name}-${o.occasion}`}
                    className="flex items-center gap-3 rounded-lg border bg-background/50 px-3 py-2"
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{o.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{o.occasion}</p>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{o.when}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
