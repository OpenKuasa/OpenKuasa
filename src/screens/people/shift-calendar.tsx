import { ArrowLeftRight, CalendarDays, Moon } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { RosterGrid } from '@/components/people/roster-grid';
import { ShiftPill } from '@/components/people/shift-pill';
import { ShiftTypesPanel } from '@/components/people/shift-types-panel';
import { SwapButtons } from '@/components/people/swap-buttons';
import { SwapRequestForm } from '@/components/people/swap-request-form';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { buildShiftCalendar, type WeekView } from '@/lib/people/attendance';
import { addDays, formatDay, todayInMalaysia } from '@/lib/people/dates';
import { parseWeek } from '@/lib/people/roster';
import { ensureShiftTypes } from '@/lib/people/roster-writes';
import { type MySwaps, type SwapChoices, buildMySwaps, listSwapOptions, listSwaps, swapChoices } from '@/lib/people/swaps';
import { EmployeeCell, LOAD_FAILED, Muted, loadPeople } from './parts';
import { SwapTable } from './swap-table';
import { WeekNav } from './week-nav';

/** The swaps card: null when it is not shown (the demo, no linked record), 'unavailable' when its reads failed. */
type SwapsCard = { mine: MySwaps; choices: SwapChoices } | 'unavailable' | null;

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
    const [shifts, employees, listed] = await Promise.all([
      data.listShifts(from, addDays(week, 6)),
      data.listEmployees(),
      data.listShiftTypes(),
    ]);
    let types = listed;
    // A workspace made after shift types arrived has none until an owner or admin first opens this screen.
    if (types.length === 0 && ctx.viewer.isHr && !ctx.viewer.isDemo && ctx.orgId) {
      if ((await ensureShiftTypes({ client: ctx.client, orgId: ctx.orgId })) > 0) types = await data.listShiftTypes();
    }
    const calendar = buildShiftCalendar({ shifts, employees, viewer: ctx.viewer, today, week, types });
    // Shift swaps, for anyone linked to a record outside the demo. Read apart, so a failure leaves the roster up.
    let swaps: SwapsCard = null;
    if (ctx.orgId && ctx.viewer.employeeId && !ctx.viewer.isDemo) {
      try {
        const read = { client: ctx.client, orgId: ctx.orgId };
        const [list, options] = await Promise.all([listSwaps(read), listSwapOptions(read)]);
        const byId = Object.fromEntries(types.map((t) => [t.id, t]));
        swaps = {
          mine: buildMySwaps({ swaps: list, viewer: ctx.viewer, employees, types: byId, today }),
          choices: swapChoices({ options, types: byId, swaps: list }),
        };
      } catch (error) {
        console.error('[people/shift-calendar] swaps:', error instanceof Error ? error.message : 'error');
        swaps = 'unavailable';
      }
    }
    return { ...calendar, swaps };
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
              <BentoStat label="Shifts this week" value={model ? model.working_count : dash} onPrimary />
            </BentoCard>
            <BentoCard className="col-span-1 md:col-span-6">
              <BentoStat label="Days off this week" value={model ? model.off_count : dash} />
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
            <>
              <RosterGrid
                key={model.week_start}
                weekStart={model.week_start}
                days={model.days}
                rows={model.rows}
                previous={model.previous}
                types={model.types}
                activeTypes={model.active_types}
                disabled={false}
              />
              <ShiftTypesPanel types={model.type_list} />
            </>
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
                          {cell && model.types[cell] ? <ShiftPill type={model.types[cell]} /> : null}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </BentoCard>

        {model?.swaps ? (
          <BentoCard
            title="Shift swaps"
            subtitle="Swap one of your shifts with a colleague's. They accept, then a manager or HR approves."
            icon={ArrowLeftRight}
            className="col-span-2 md:col-span-12"
          >
            {model.swaps === 'unavailable' ? (
              LOAD_FAILED
            ) : (
              <div className="space-y-5">
                {model.swaps.mine.waiting_for_you > 0 ? (
                  <p className="text-sm font-medium">
                    {model.swaps.mine.waiting_for_you === 1
                      ? 'A colleague asks to swap shifts with you.'
                      : `${model.swaps.mine.waiting_for_you} colleagues ask to swap shifts with you.`}
                  </p>
                ) : null}
                {model.swaps.mine.open.length > 0 ? (
                  <SwapTable
                    rows={model.swaps.mine.open}
                    action={(row) => <SwapButtons id={row.id} reply={row.can_reply} cancel={row.can_cancel} />}
                  />
                ) : null}
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">Ask for a swap</h3>
                  <SwapRequestForm choices={model.swaps.choices} disabled={false} />
                </div>
                {model.swaps.mine.recent.length > 0 ? (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium">Recent swaps</h3>
                    <SwapTable rows={model.swaps.mine.recent} />
                  </div>
                ) : null}
              </div>
            )}
          </BentoCard>
        ) : null}

        <BentoCard title="Shift types" subtitle="Used this week · times are Malaysia time" icon={Moon} className="col-span-2 md:col-span-12">
          {!model ? (
            LOAD_FAILED
          ) : model.by_type.length === 0 ? (
            <Muted>No shifts are set for this week</Muted>
          ) : (
            <ul className="flex flex-wrap gap-3">
              {model.by_type.map(({ type, count }) => (
                <li key={type.id} className="flex items-center gap-2 text-sm">
                  <ShiftPill type={type} />
                  <span className="tabular-nums text-muted-foreground">× {count}</span>
                </li>
              ))}
            </ul>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
