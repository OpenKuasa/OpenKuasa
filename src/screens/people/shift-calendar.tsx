import { CalendarDays, Moon } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { RosterGrid } from '@/components/people/roster-grid';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SHIFT_LABEL, buildShiftCalendar, type WeekView } from '@/lib/people/attendance';
import { addDays, formatDay, todayInMalaysia } from '@/lib/people/dates';
import { parseWeek } from '@/lib/people/roster';
import type { ShiftKind } from '@/lib/people/types';
import { cn } from '@/lib/utils';
import { EmployeeCell, LOAD_FAILED, Muted, loadPeople } from './parts';
import { WeekNav } from './week-nav';

const SHIFT_CLASS: Record<ShiftKind, string> = {
  morning: 'bg-primary/10 text-primary',
  night: 'bg-slate-500/10 text-slate-600',
  off: 'bg-muted text-muted-foreground',
};

const SUBTITLE: Record<WeekView, string> = {
  hr: 'Weekly shift schedule',
  demo: 'Weekly shift schedule',
  manager: "Your team's shifts",
  self: 'Your shifts',
};

/**
 * One week's roster (`?week=` is the Monday; this week without it). Owners and admins edit it in the grid and save
 * the week; the demo and everyone else read. A manager sees their direct reports' shifts and their own; anyone
 * else their own.
 */
export default async function ShiftCalendarScreen({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = ((await searchParams) ?? {}).week;
  const { model } = await loadPeople('shift-calendar', async (data, now, ctx) => {
    const today = todayInMalaysia(now);
    const week = parseWeek(raw, today);
    // HR also reads last week, for "Copy last week".
    const from = ctx.viewer.isHr && !ctx.viewer.isDemo ? addDays(week, -7) : week;
    const [shifts, employees] = await Promise.all([data.listShifts(from, addDays(week, 6)), data.listEmployees()]);
    return buildShiftCalendar({ shifts, employees, viewer: ctx.viewer, today, week });
  });

  const dash = '—';
  const team = model?.team ?? true;

  return (
    <ScreenContainer>
      <PageHeader
        title="Shift Calendar"
        subtitle={
          model
            ? `${SUBTITLE[model.view]} · week of ${formatDay(model.week_start)} to ${formatDay(model.week_end)}`
            : 'Weekly shift schedule'
        }
        actions={model ? <WeekNav path="/people/shift-calendar" nav={model.nav} /> : null}
      />

      <BentoGrid>
        {team ? (
          <>
            <BentoCard tone="primary" className="col-span-1 md:col-span-6">
              <BentoStat label="Morning shifts" value={model ? model.morning_count : dash} onPrimary />
            </BentoCard>
            <BentoCard className="col-span-1 md:col-span-6">
              <BentoStat label="Night shifts" value={model ? model.night_count : dash} />
            </BentoCard>
          </>
        ) : null}

        <BentoCard
          title="Shift grid"
          subtitle={
            model?.editable
              ? 'Pick a shift in any cell, then save the week'
              : team
                ? 'Monday to Sunday'
                : model?.view === 'manager'
                  ? 'You and the people who report to you · Monday to Sunday'
                  : 'Your records · Monday to Sunday'
          }
          icon={CalendarDays}
          flush
          className="col-span-2 md:col-span-12"
        >
          {!model ? (
            LOAD_FAILED
          ) : model.editable ? (
            <RosterGrid
              key={model.week_start}
              weekStart={model.week_start}
              days={model.days}
              rows={model.rows}
              previous={model.previous}
              disabled={false}
            />
          ) : model.rows.length === 0 ? (
            <Muted>No shifts are set for this week</Muted>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Employee</TableHead>
                    {model.days.map((d) => (
                      <TableHead key={d.date}>{d.label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {model.rows.map((row) => (
                    <TableRow key={row.employee_id}>
                      <TableCell>
                        <EmployeeCell name={row.name} sub={row.department} />
                      </TableCell>
                      {row.cells.map((cell, i) => (
                        <TableCell key={model.days[i].date}>
                          {cell ? (
                            <span
                              className={cn(
                                'inline-flex whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium',
                                SHIFT_CLASS[cell],
                              )}
                            >
                              {SHIFT_LABEL[cell]}
                            </span>
                          ) : null}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </BentoCard>

        <BentoCard title="Shift types" subtitle="Used in this roster" icon={Moon} className="col-span-2 md:col-span-12">
          <ul className="flex flex-wrap gap-2">
            {(Object.keys(SHIFT_LABEL) as ShiftKind[]).map((kind) => (
              <li
                key={kind}
                className={cn('inline-flex items-center rounded px-2 py-1 text-xs font-medium', SHIFT_CLASS[kind])}
              >
                {SHIFT_LABEL[kind]}
              </li>
            ))}
          </ul>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
