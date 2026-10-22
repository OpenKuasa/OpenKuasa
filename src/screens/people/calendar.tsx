import Link from 'next/link';
import { CalendarClock, CalendarDays, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { buttonVariants } from '@/components/ui/button';
import {
  calendarSubtitle,
  loadPeopleCalendar,
  parsePeopleMonth,
  type PeopleCalendarEvent,
  type PeopleCalendarKind,
} from '@/lib/people/calendar';
import { readWorkWeek } from '@/lib/people/supabase';
import { cn } from '@/lib/utils';
import { LOAD_FAILED, Muted, loadPeople } from './parts';

const WEEKDAY_HEADINGS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** How many entries a day cell shows before '+N more'. */
const CELL_ITEMS = 3;

/**
 * One source for each kind's colours: the grid chips, the Upcoming dots and the legend all read from here.
 * Lekiu's primary is blue, so no other kind uses a blue hue.
 */
const KINDS: Record<PeopleCalendarKind, { label: string; chip: string; dot: string }> = {
  leave: { label: 'Leave', chip: 'bg-primary/10 text-primary border-primary/40', dot: 'bg-primary' },
  'time-off': {
    label: 'Time-off',
    chip: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/50',
    dot: 'bg-amber-500',
  },
  holiday: {
    label: 'Public holiday',
    chip: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/50',
    dot: 'bg-emerald-500',
  },
  training: {
    label: 'Training',
    chip: 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/50',
    dot: 'bg-slate-500',
  },
  birthday: {
    label: 'Birthday',
    chip: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/40',
    dot: 'bg-rose-400',
  },
  anniversary: {
    label: 'Work anniversary',
    chip: 'bg-muted text-muted-foreground border-border',
    dot: 'bg-muted-foreground/60',
  },
};

/** A pending request is drawn as an outline, not filled. */
const chipClass = (item: PeopleCalendarEvent) =>
  cn(
    'block truncate rounded border px-1.5 py-0.5 text-[10px] font-medium',
    KINDS[item.kind].chip,
    item.pending ? 'border-dashed bg-transparent' : 'border-transparent',
  );

const titleOf = (item: PeopleCalendarEvent) =>
  `${KINDS[item.kind].label}: ${item.label}${item.pending ? ' (pending)' : ''}`;

/**
 * Lekiu's Calendar: leave, time-off, public holidays, trainings, birthdays and work anniversaries on a month grid.
 * Read-only. The rows are what the database gives this viewer; see `src/lib/people/calendar.ts`.
 */
export default async function PeopleCalendarScreen({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = ((await searchParams) ?? {}).month;
  const { model, viewer } = await loadPeople('calendar', (data, now, ctx) => {
    const orgId = ctx.orgId;
    return loadPeopleCalendar(
      data,
      ctx.viewer,
      parsePeopleMonth(raw, now),
      now,
      // A manager or member cannot read the settings, so the work week comes from the members' function.
      orgId ? () => readWorkWeek(ctx.client, orgId) : undefined,
    );
  });
  const subtitle = calendarSubtitle(viewer);

  if (!model) {
    return (
      <ScreenContainer>
        <PageHeader title="Calendar" subtitle={subtitle} />
        {LOAD_FAILED}
      </ScreenContainer>
    );
  }

  const navButton = buttonVariants({ variant: 'ghost', size: 'icon' });

  return (
    <ScreenContainer>
      <PageHeader title="Calendar" subtitle={subtitle} />

      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat label="Away today" value={String(model.stats.awayToday)} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Away in the next 7 days" value={String(model.stats.away7)} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label={`Public holidays in ${model.title}`} value={String(model.stats.holidaysInMonth)} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Next 30 days" value={String(model.stats.next30)} />
        </BentoCard>

        <BentoCard
          title={model.title}
          icon={CalendarDays}
          action={
            <div className="flex items-center gap-1">
              <Link href={`/people/calendar?month=${model.prevMonth}`} aria-label="Previous month" className={navButton}>
                <ChevronLeft className="size-4" />
              </Link>
              <Link href="/people/calendar" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                Today
              </Link>
              <Link href={`/people/calendar?month=${model.nextMonth}`} aria-label="Next month" className={navButton}>
                <ChevronRight className="size-4" />
              </Link>
            </div>
          }
          className="col-span-2 md:col-span-8"
        >
          <div className="overflow-x-auto">
            <div className="min-w-[600px]">
              <div className="grid grid-cols-7">
                {WEEKDAY_HEADINGS.map((d) => (
                  <div key={d} className="pb-2 text-center text-xs font-medium text-muted-foreground">
                    {d}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {Array.from({ length: model.leadingEmpty }, (_, i) => (
                  <div key={`empty-${i}`} />
                ))}
                {model.days.map((day) => (
                  <div
                    key={day.iso}
                    className={cn(
                      'min-h-20 min-w-0 space-y-1 rounded-md border p-1.5',
                      day.nonWorking && 'bg-muted/50',
                      day.isToday && 'bg-primary/5 ring-1 ring-primary',
                    )}
                  >
                    <div className="text-xs text-muted-foreground">{day.day}</div>
                    {day.items.slice(0, CELL_ITEMS).map((item) => (
                      <Link key={`${item.kind}-${item.id}`} href={item.href} title={titleOf(item)} className={chipClass(item)}>
                        {item.label}
                        {item.pending ? ' · pending' : ''}
                      </Link>
                    ))}
                    {day.items.length > CELL_ITEMS ? (
                      <div className="px-1.5 text-[10px] text-muted-foreground">
                        +{day.items.length - CELL_ITEMS} more
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {Object.values(KINDS).map((kind) => (
              <li key={kind.label} className="flex items-center gap-1.5">
                <span className={cn('size-2 rounded-full', kind.dot)} />
                {kind.label}
              </li>
            ))}
            <li className="flex items-center gap-1.5">
              <span className="size-2 rounded-full border border-dashed border-muted-foreground" />
              Pending
            </li>
            <li className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm bg-muted" />
              Not a working day
            </li>
          </ul>
        </BentoCard>

        <BentoCard title="Upcoming" subtitle="Next 30 days" icon={CalendarClock} className="col-span-2 md:col-span-4">
          {model.upcoming.length === 0 ? (
            <Muted>Nothing in the next 30 days</Muted>
          ) : (
            <ul className="space-y-2">
              {model.upcoming.map((item) => (
                <li key={`${item.kind}-${item.id}`}>
                  <Link
                    href={item.href}
                    className="flex items-center gap-3 rounded-lg border bg-background/50 px-3 py-2 hover:bg-muted/50"
                  >
                    <span
                      className={cn(
                        'size-2.5 shrink-0 rounded-full',
                        item.pending ? 'border border-dashed border-muted-foreground' : KINDS[item.kind].dot,
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{item.label}</p>
                      <p className="flex items-start gap-1 text-xs text-muted-foreground">
                        <Clock className="mt-0.5 size-3 shrink-0" />
                        {KINDS[item.kind].label}
                        {item.pending ? ' (pending)' : ''} · {item.when}
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
              {model.stats.next30 > model.upcoming.length ? (
                <li className="text-xs text-muted-foreground">
                  and {model.stats.next30 - model.upcoming.length} more
                </li>
              ) : null}
            </ul>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
