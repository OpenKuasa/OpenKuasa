import { CalendarDays, PieChart, Sparkles } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { DonutStat, type Slice } from '@/components/charts';
import { HolidayDialog, RemoveHoliday } from '@/components/people/holiday-form';
import { RequestRow } from '@/components/people/request-row';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { Badge } from '@/components/ui/badge';
import { LiveDot } from '@/components/ui/live-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { buildHolidaysModel } from '@/lib/people/company';
import { formatDate, formatDay, todayInMalaysia } from '@/lib/people/dates';
import { isTeamView } from '@/lib/people/own';
import { LOAD_FAILED, Muted, loadPeople } from './parts';

/** The workspace's holiday calendar. Every member reads the same rows; owners and admins also keep it. */
export default async function PublicHolidaysScreen() {
  const { model, viewer } = await loadPeople('public-holidays', async (data, now) =>
    buildHolidaysModel(await data.listPublicHolidays(), todayInMalaysia(now)),
  );
  const dash = '—';
  // Owners and admins (and a demo visitor, who sees the controls disabled) get the editing controls.
  const canEdit = isTeamView(viewer);
  const demo = viewer.isDemo;
  const typeMix: Slice[] = model
    ? [
        { key: 'national', label: 'National', value: model.national, color: 'var(--chart-1)' },
        { key: 'state', label: 'State', value: model.state, color: 'var(--chart-3)' },
      ].filter((s) => s.value > 0)
    : [];

  return (
    <ScreenContainer>
      <PageHeader
        className="mb-3"
        title="Public Holidays"
        subtitle={model ? `Your workspace's holiday calendar for ${model.year}.` : 'Your workspace’s holiday calendar.'}
        actions={canEdit ? <HolidayDialog disabled={demo || !model} /> : undefined}
      />

      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-4">
          <BentoStat
            label={model ? `Holidays in ${model.year}` : 'Holidays this year'}
            value={model ? model.total : dash}
            onPrimary
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-4">
          <BentoStat
            label="Next holiday"
            value={model ? (model.next ? model.next.name : 'None ahead') : dash}
          />
          {model?.next ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {formatDate(model.next.date)} · {model.next.in}
            </p>
          ) : null}
        </BentoCard>
        <BentoCard className="col-span-2 md:col-span-4">
          <BentoStat label="This month" value={model ? model.thisMonth : dash} />
        </BentoCard>

        <BentoCard title="By type" subtitle="National vs state" icon={PieChart} className="col-span-2 md:col-span-4">
          {!model ? (
            LOAD_FAILED
          ) : typeMix.length === 0 ? (
            <Muted>No holidays this year</Muted>
          ) : (
            <DonutStat data={typeMix} height={220} centerValue={String(model.total)} centerLabel="holidays" />
          )}
        </BentoCard>
        <BentoCard
          title="Coming up"
          subtitle="Holidays still ahead this year"
          icon={Sparkles}
          className="col-span-2 md:col-span-8"
        >
          {!model ? (
            LOAD_FAILED
          ) : model.upcoming.length === 0 ? (
            <Muted>No holidays left this year</Muted>
          ) : (
            <ul className="divide-y">
              {model.upcoming.map((h) => (
                <li key={h.id} className="flex items-center gap-3 py-2.5">
                  <LiveDot active />
                  <span className="w-16 shrink-0 text-sm font-semibold tabular-nums">{formatDay(h.date)}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{h.name}</span>
                  <Badge variant="secondary" className="shrink-0">
                    {h.scope}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </BentoCard>

        <BentoCard
          title={model ? `${model.year} holiday calendar` : 'Holiday calendar'}
          subtitle="Past holidays are dimmed"
          icon={CalendarDays}
          flush
          className="col-span-2 md:col-span-12"
        >
          {!model ? (
            LOAD_FAILED
          ) : model.rows.length === 0 ? (
            <Muted>No public holidays are recorded for this year</Muted>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Holiday</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Day</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>State</TableHead>
                    {canEdit ? (
                      <TableHead>
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {model.rows.map((h) => {
                    const cells = (
                      <>
                        <TableCell className="whitespace-nowrap font-medium">{h.name}</TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">{formatDate(h.date)}</TableCell>
                        <TableCell className="whitespace-nowrap">{h.weekday}</TableCell>
                        <TableCell>
                          <Badge variant="secondary">{h.scope}</Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm">{h.state}</TableCell>
                      </>
                    );
                    if (!canEdit) {
                      return (
                        <TableRow key={h.id} className={h.past ? 'text-muted-foreground' : undefined}>
                          {cells}
                        </TableRow>
                      );
                    }
                    return (
                      <RequestRow key={h.id} columns={6}>
                        {cells}
                        <TableCell className="whitespace-nowrap">
                          <span className="flex items-center gap-1.5">
                            <HolidayDialog holiday={{ id: h.id, name: h.name, date: h.date }} disabled={demo} />
                            <RemoveHoliday id={h.id} name={h.name} disabled={demo} />
                          </span>
                        </TableCell>
                      </RequestRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
