import Link from 'next/link';
import { CalendarClock, CalendarDays, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import { buttonVariants } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import {
  loadCrmCalendar,
  parseMonth,
  type CalendarKind,
  type CalendarModel,
} from '@/lib/crm/calendar';
import { cn } from '@/lib/utils';
import SampleCalendarScreen from './calendar';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** How many entries a day cell shows before '+N more'. */
const CELL_ITEMS = 3;

const KINDS: Record<CalendarKind, { label: string; href: string; chip: string; dot: string }> = {
  appointment: {
    label: 'Appointment',
    href: '/crm/appointments',
    chip: 'bg-primary/10 text-primary',
    dot: 'bg-primary',
  },
  'follow-up': {
    label: 'Follow-up',
    href: '/crm/contacts',
    chip: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
    dot: 'bg-amber-500',
  },
  deal: {
    label: 'Deal closing',
    href: '/crm/deals',
    chip: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
    dot: 'bg-blue-500',
  },
};

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * Kasturi's Calendar: the workspace's appointments, open follow-ups and
 * expected deal closes on a month grid. It falls back to the sample screen in
 * `./calendar` when no database is configured.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!hasSupabaseEnv()) return <SampleCalendarScreen />;

  const now = new Date();
  const month = parseMonth((await searchParams).month, now);
  let model: CalendarModel | null = null;
  try {
    const supabase = await createClient();
    const org = await getCurrentOrg(supabase);
    if (org) model = await loadCrmCalendar(supabase, org.orgId, month, now);
  } catch (e) {
    console.error('[crm/calendar] data error:', e);
  }

  if (!model) {
    return (
      <ScreenContainer>
        <PageHeader title="Calendar" subtitle="Appointments, follow-ups and deals closing." />
        <Muted>Couldn&apos;t load your calendar — please refresh</Muted>
      </ScreenContainer>
    );
  }

  const navButton = buttonVariants({ variant: 'ghost', size: 'icon' });

  return (
    <ScreenContainer>
      <PageHeader title="Calendar" subtitle="Appointments, follow-ups and deals closing." />

      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat label="Today" value={String(model.stats.today)} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Next 7 days" value={String(model.stats.next7)} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label={`In ${model.title}`} value={String(model.stats.inMonth)} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Next 30 days" value={String(model.stats.next30)} />
        </BentoCard>

        <BentoCard
          title={model.title}
          icon={CalendarDays}
          action={
            <div className="flex items-center gap-1">
              <Link
                href={`/crm/calendar?month=${model.prevMonth}`}
                aria-label="Previous month"
                className={navButton}
              >
                <ChevronLeft className="size-4" />
              </Link>
              <Link href="/crm/calendar" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                Today
              </Link>
              <Link
                href={`/crm/calendar?month=${model.nextMonth}`}
                aria-label="Next month"
                className={navButton}
              >
                <ChevronRight className="size-4" />
              </Link>
            </div>
          }
          className="col-span-2 md:col-span-8"
        >
          <div className="overflow-x-auto">
            <div className="min-w-[600px]">
              <div className="grid grid-cols-7">
                {WEEKDAYS.map((d) => (
                  <div
                    key={d}
                    className="pb-2 text-center text-xs font-medium text-muted-foreground"
                  >
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
                      day.isToday && 'bg-primary/5 ring-1 ring-primary',
                    )}
                  >
                    <div className="text-xs text-muted-foreground">{day.day}</div>
                    {day.items.slice(0, CELL_ITEMS).map((item) => (
                      <Link
                        key={`${item.kind}-${item.id}`}
                        href={KINDS[item.kind].href}
                        title={`${KINDS[item.kind].label}: ${item.label}${item.time ? ` · ${item.time}` : ''}`}
                        className={cn(
                          'block truncate rounded px-1.5 py-0.5 text-[10px] font-medium',
                          KINDS[item.kind].chip,
                        )}
                      >
                        {item.label}
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
          </ul>
        </BentoCard>

        <BentoCard
          title="Upcoming"
          subtitle="Next 30 days"
          icon={CalendarClock}
          className="col-span-2 md:col-span-4"
        >
          {model.upcoming.length === 0 ? (
            <Muted>Nothing in the next 30 days</Muted>
          ) : (
            <ul className="space-y-2">
              {model.upcoming.map((item) => (
                <li key={`${item.kind}-${item.id}`}>
                  <Link
                    href={KINDS[item.kind].href}
                    className="flex items-center gap-3 rounded-lg border bg-background/50 px-3 py-2 hover:bg-muted/50"
                  >
                    <span className={cn('size-2.5 shrink-0 rounded-full', KINDS[item.kind].dot)} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{item.label}</p>
                      <p className="flex items-start gap-1 text-xs text-muted-foreground">
                        <Clock className="mt-0.5 size-3 shrink-0" />
                        {KINDS[item.kind].label} · {item.when}
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
