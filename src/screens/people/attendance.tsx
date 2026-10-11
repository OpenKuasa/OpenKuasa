import { ChevronLeft, ChevronRight, ClipboardList } from 'lucide-react';
import Link from 'next/link';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { CorrectAttendance } from '@/components/people/correct-attendance';
import { RequestRow } from '@/components/people/request-row';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { todayInMalaysia } from '@/lib/people/dates';
import { loadTeamAttendance } from '@/lib/people/team-attendance';
import { EmployeeCell, HrOnlyScreen, LOAD_FAILED, Muted, StatusPill, loadPeople } from './parts';

const COLUMNS = 7;
const dash = '—';

/** Team Attendance: one day, a row per active employee, and a "Correct" action. Owners and admins only. */
export default async function TeamAttendanceScreen({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = ((await searchParams) ?? {}).date;
  const { model, viewer } = await loadPeople('attendance', (data, now, ctx) =>
    loadTeamAttendance(data, ctx.viewer, raw, todayInMalaysia(now)),
  );

  if (model?.hr_only) return <HrOnlyScreen title="Team Attendance" />;
  const day = model && !model.hr_only ? model : null;
  const demo = viewer.isDemo;

  return (
    <ScreenContainer>
      <PageHeader
        title="Team Attendance"
        subtitle={day ? `${day.heading}${day.isToday ? ' (today)' : ''}` : 'Who was in, day by day.'}
        actions={
          day ? (
            <nav aria-label="Choose the day" className="flex flex-wrap items-center gap-2">
              <Link
                href={`/people/attendance?date=${day.previous}`}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
                aria-label="Previous day"
              >
                <ChevronLeft aria-hidden />
              </Link>
              <form method="get" action="/people/attendance" className="flex items-center gap-2">
                <Input
                  type="date"
                  name="date"
                  aria-label="Day"
                  required
                  min="2000-01-01"
                  max={day.today}
                  defaultValue={day.date}
                  className="h-8 w-40"
                />
                <Button type="submit" variant="outline" size="sm">
                  Show
                </Button>
              </form>
              {day.next ? (
                <Link
                  href={`/people/attendance?date=${day.next}`}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  aria-label="Next day"
                >
                  <ChevronRight aria-hidden />
                </Link>
              ) : (
                <span className={buttonVariants({ variant: 'outline', size: 'sm' }) + ' pointer-events-none opacity-50'} aria-hidden>
                  <ChevronRight aria-hidden />
                </span>
              )}
              {!day.isToday ? (
                <Link href="/people/attendance" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                  Today
                </Link>
              ) : null}
            </nav>
          ) : null
        }
      />

      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat label="Present" value={day ? day.tiles.present : dash} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-2">
          <BentoStat label="Late" value={day ? day.tiles.late : dash} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-2">
          <BentoStat label="Absent" value={day ? day.tiles.absent : dash} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-2">
          <BentoStat label="On leave" value={day ? day.tiles.onLeave : dash} />
        </BentoCard>
        <BentoCard className="col-span-2 md:col-span-3">
          <BentoStat label="No clock-out" value={day ? day.tiles.noClockOut : dash} />
        </BentoCard>

        <BentoCard
          title="Attendance"
          subtitle={day?.nonWorkingReason ?? (day ? 'A working day' : undefined)}
          icon={ClipboardList}
          flush
          className="col-span-2 md:col-span-12"
        >
          {!day ? (
            LOAD_FAILED
          ) : day.rows.length === 0 ? (
            <Muted>No active employees</Muted>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Employee</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Clock-in</TableHead>
                    <TableHead>Clock-out</TableHead>
                    <TableHead>Hours</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead>
                      <span className="sr-only">Action</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {day.rows.map((row) => (
                    <RequestRow key={row.employeeId} columns={COLUMNS}>
                      <TableCell>
                        <EmployeeCell name={row.name} sub={row.department} />
                        {row.inactive ? <span className="mt-0.5 block text-xs text-muted-foreground">Inactive</span> : null}
                      </TableCell>
                      <TableCell>
                        {row.label ? <StatusPill tone={row.tone}>{row.label}</StatusPill> : <span className="text-muted-foreground">{dash}</span>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">{row.clockIn ?? dash}</TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">{row.clockOut ?? dash}</TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">{row.hours ?? dash}</TableCell>
                      <TableCell className="space-x-1.5">
                        {row.noClockOut ? <StatusPill tone="bad">No clock-out</StatusPill> : null}
                        {row.stillIn ? <StatusPill tone="neutral">Still in</StatusPill> : null}
                        {row.corrected ? <StatusPill tone="neutral">Corrected</StatusPill> : null}
                        {row.corrected && row.note ? <span className="text-xs text-muted-foreground">{row.note}</span> : null}
                      </TableCell>
                      <TableCell>
                        <CorrectAttendance
                          employeeId={row.employeeId}
                          name={row.name}
                          workDate={day.date}
                          prefill={row.prefill}
                          disabled={demo}
                        />
                      </TableCell>
                    </RequestRow>
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
