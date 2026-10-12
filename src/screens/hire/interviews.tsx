import {
  BarChart3,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  MapPin,
  Phone,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import { BarGroup, type Series } from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import { cn } from '@/lib/utils';
import { tagsFor, timeCell } from '@/lib/hire/interview-dialog-state';
import { ROWS_SHOWN, buildInterviewsModel, type InterviewsModel } from '@/lib/hire/lists';
import { DeletionNotice } from '@/screens/hire/delete-dialog';
import { InterviewHeaderButtons, InterviewRowMenu } from '@/screens/hire/interview-actions';
import { InterviewDialogHost } from '@/screens/hire/interview-dialog';
import { LOAD_FAILED, Muted, loadHire } from '@/screens/hire/parts';

type Interview = InterviewsModel['rows'][number];

const STATUS_STYLES: Record<Interview['status'], string> = {
  Scheduled: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  Completed: 'bg-muted text-muted-foreground',
  Cancelled: 'bg-red-500/15 text-red-600 dark:text-red-400',
  'No-show': 'bg-red-500/15 text-red-600 dark:text-red-400',
};

const TYPE_ICONS: Record<Interview['type'], LucideIcon> = {
  Video,
  Onsite: MapPin,
  Phone,
};

const WEEK_SERIES: Series[] = [
  { key: 'count', label: 'Interviews', color: 'var(--chart-1)' },
];

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

function UpcomingRow({ interview }: { interview: Interview }) {
  const TypeIcon = TYPE_ICONS[interview.type];
  return (
    <li className="flex items-center gap-3 rounded-xl border bg-card p-3 shadow-sm transition-colors hover:border-primary/40">
      <div className="flex w-14 shrink-0 flex-col items-center rounded-lg bg-primary/10 px-2 py-1 text-primary">
        {/* `date` is "20 Oct 2026": the month, the day, and the year under them. An interview can be a year off. */}
        <span className="text-[10px] font-medium uppercase">
          {interview.date.split(' ')[1]}
        </span>
        <span className="text-base font-bold leading-none tabular-nums">
          {interview.date.split(' ')[0]}
        </span>
        <span className="text-[10px] font-medium tabular-nums">
          {interview.date.split(' ')[2]}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <LiveDot active />
          <p className="truncate text-sm font-semibold">{interview.name}</p>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {interview.role} · {interview.interviewer}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-sm font-semibold tabular-nums">
          {interview.time}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          <TypeIcon className="size-3" />
          {interview.type}
        </span>
      </div>
    </li>
  );
}

/**
 * Where the interview is held. A link is drawn only from `placeLink`, which
 * the server made with `safeLink` (http or https, no login part): the place
 * as typed is never put in an `href`. Anything else is plain text.
 */
function Where({ interview }: { interview: Interview }) {
  if (interview.placeLink) {
    return (
      <a
        href={interview.placeLink.href}
        target="_blank"
        rel="noopener noreferrer"
        // A long host wraps inside the cell instead of widening the table.
        className={cn('inline-flex min-h-11 min-w-11 items-center rounded-md break-all text-primary underline underline-offset-2', FOCUS)}
      >
        {interview.placeLink.host}
      </a>
    );
  }
  if (interview.place) return <span className="break-words">{interview.place}</span>;
  return <span className="text-muted-foreground">—</span>;
}

export default async function InterviewsScreen() {
  const [{ model }, viewer] = await Promise.all([loadHire('interviews', buildInterviewsModel), getViewer()]);
  // Worked out once for the screen. Each action checks again on the server, so this only decides what is drawn.
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // Scheduled and still ahead. A scheduled interview whose time has passed is in the table below, tagged "Needs an outcome".
  const upcoming = model?.upcoming ?? [];
  // The server's clock, handed to the browser: whether an invitation can still be handed over is told from it, not
  // from the browser's own clock, which may be wrong.
  const serverNow = new Date().toISOString();

  return (
    <ScreenContainer>
      <PageHeader
        title="Interviews"
        subtitle="Your upcoming and recent interviews, Saudara."
        // Only for someone who may edit, and only when the list of applications to pick from was read.
        actions={canEdit && model ? <InterviewHeaderButtons /> : null}
      />

      {/* Where a change is said ("Scheduled …", "Cancelled …"): the sentence stays when a dialog closes. Only for someone who may edit. */}
      {canEdit ? <DeletionNotice className="mb-3" /> : null}
      {/* The screen's one interview dialog, closed until a button or a row's menu opens it. */}
      {canEdit && model ? (
        <InterviewDialogHost
          today={model.today}
          serverNow={serverNow}
         
          picker={{ applications: model.applications, cut: model.applicationsCut }}
        />
      ) : null}

      <BentoGrid>
        {/* KPI row: headline figures only, the tables hold no history to chart */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat label="Scheduled" value={model ? model.scheduled : '—'} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Next 7 days" value={model ? model.next7Days : '—'} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Completed" value={model ? model.completed : '—'} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="No-shows" value={model ? model.noShow : '—'} />
        </BentoCard>

        {/* Upcoming list + week load */}
        <BentoCard
          title="Upcoming interviews"
          // The count is of what the list holds: scheduled and still ahead. Every scheduled one is the figure above.
          subtitle={
            model
              ? model.ahead > upcoming.length
                ? `${model.ahead} upcoming, showing the first ${upcoming.length}`
                : `${model.ahead} upcoming`
              : undefined
          }
          icon={CalendarClock}
          className="col-span-2 md:col-span-8"
        >
          {!model ? LOAD_FAILED : upcoming.length === 0 ? (
            <Muted>No upcoming interviews</Muted>
          ) : (
            <ul className="space-y-2">
              {upcoming.map((interview) => (
                <UpcomingRow key={interview.id} interview={interview} />
              ))}
            </ul>
          )}
        </BentoCard>
        <BentoCard
          title="Next 7 days"
          subtitle="Weekdays only"
          icon={BarChart3}
          className="col-span-2 md:col-span-4"
        >
          {!model ? LOAD_FAILED : model.next7Days === 0 ? (
            <Muted>No interviews in the next 7 days</Muted>
          ) : (
            <BarGroup data={model.weekLoad} series={WEEK_SERIES} height={240} />
          )}
        </BentoCard>

        {/* All interviews table */}
        <BentoCard
          title="All interviews"
          subtitle="Upcoming first"
          icon={CalendarDays}
          flush
          className="col-span-2 md:col-span-12"
        >
          {!model ? LOAD_FAILED : model.rows.length === 0 ? (
            <Muted>No interviews yet</Muted>
          ) : (
          <>
            {/* The table scrolls sideways inside its card; the page does not. */}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Candidate</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead>Interviewer</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Where</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {model.rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <LiveDot active={r.status === 'Scheduled'} />
                          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                            {r.name.charAt(0)}
                          </span>
                          <span className="whitespace-nowrap font-medium">
                            {r.name}
                          </span>
                          {/* In words: colour is never the only signal. */}
                          {tagsFor(r).map((tag) => (
                            <span
                              key={tag}
                              className="whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{r.role}</TableCell>
                      <TableCell className="whitespace-nowrap">{r.date}</TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {timeCell(r)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {r.interviewer}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{r.type}</Badge>
                      </TableCell>
                      <TableCell className="max-w-64 min-w-32 whitespace-normal">
                        <Where interview={r} />
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-xs font-medium',
                            STATUS_STYLES[r.status],
                          )}
                        >
                          {r.status}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {/* The row as plain values. Only for someone who may edit; each action checks again. */}
                        {canEdit ? <InterviewRowMenu row={r} /> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
              <span>
                {model.rows.length === ROWS_SHOWN
                  ? `Showing up to the first ${ROWS_SHOWN}`
                  : `Showing ${model.rows.length} interviews`}
              </span>
              <span className="flex items-center gap-2">
                <CalendarCheck className="size-4" />
                {model.completed} completed
              </span>
            </div>
          </>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
