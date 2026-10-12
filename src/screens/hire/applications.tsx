import { BarChart3, CircleDot, Inbox, PieChart } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import { BarGroup, DonutStat, type Series, type Slice } from '@/components/charts';
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import { klDateOf } from '@/lib/hire/interview-time';
import { buildApplicationsModel } from '@/lib/hire/lists';
import { ApplicationRow } from '@/screens/hire/application-details';
import { DeletionNotice } from '@/screens/hire/delete-dialog';
import { InterviewDialogHost } from '@/screens/hire/interview-dialog';
import { LOAD_FAILED, Muted, loadHire } from '@/screens/hire/parts';

/* ---- static config ------------------------------------------------ */

type Status = 'New' | 'In review' | 'Shortlisted' | 'Rejected';

const STATUS_STYLES: Record<Status, string> = {
  New: 'bg-primary/10 text-primary',
  'In review': 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  Shortlisted: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  Rejected: 'bg-muted text-muted-foreground',
};

const STATUS_COLOR: Record<Status, string> = {
  New: 'var(--chart-1)',
  'In review': 'var(--chart-2)',
  Shortlisted: 'var(--chart-3)',
  Rejected: 'var(--chart-4)',
};

const BY_JOB_SERIES: Series[] = [
  { key: 'applications', label: 'Applications', color: 'var(--chart-2)' },
];

/**
 * The server's clock for the interview form: the instant itself (the form's checks tell the time from it) and
 * today in Kuala Lumpur for the date field. The browser's own clock and its "today" can be wrong.
 */
const serverClock = () => {
  const serverNow = new Date().toISOString();
  return { serverNow, today: klDateOf(serverNow) };
};

export default async function ApplicationsScreen() {
  const [{ model }, viewer] = await Promise.all([
    loadHire('applications', (data) => buildApplicationsModel(data)),
    getViewer(),
  ]);
  // Worked out once for the screen. The actions check again on the server, so this only decides what is drawn.
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  const countOf = (key: Status) => model?.statusMix.find((s) => s.key === key)?.value;
  const stat = (key: Status) => {
    const value = countOf(key);
    return model && value !== undefined ? value : '—';
  };
  const statusSlices: Slice[] = (model?.statusMix ?? []).map((s) => ({
    key: s.key,
    label: s.key,
    value: s.value,
    color: STATUS_COLOR[s.key],
  }));

  return (
    <ScreenContainer>
      <PageHeader
        title="Applications"
        subtitle="All incoming applications across your open roles, Saudara."
      />
      {/* The screen's one interview dialog, closed until a panel's button opens it. Only for someone who may edit. */}
      {canEdit ? <InterviewDialogHost {...serverClock()} /> : null}

      <BentoGrid>
        {/* KPI row: headline figures only, the tables hold no history to chart */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Total applications"
            value={model ? model.total : '—'}
            onPrimary
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="New" value={stat('New')} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="In review" value={stat('In review')} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Rejected" value={stat('Rejected')} />
        </BentoCard>

        {/* Status donut + applications by job */}
        <BentoCard
          title="By status"
          subtitle="Current application mix"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          {!model ? LOAD_FAILED : model.isEmpty ? (
            <Muted>No applications yet</Muted>
          ) : (
            <DonutStat
              data={statusSlices}
              height={240}
              centerValue={model.total.toString()}
              centerLabel="applications"
            />
          )}
        </BentoCard>
        <BentoCard
          title="Applications by job"
          subtitle="Top roles"
          icon={BarChart3}
          className="col-span-2 md:col-span-8"
        >
          {!model ? LOAD_FAILED : model.byJob.length === 0 ? (
            <Muted>No applications yet</Muted>
          ) : (
            <BarGroup
              data={model.byJob}
              series={BY_JOB_SERIES}
              horizontal
              height={240}
            />
          )}
        </BentoCard>

        {/* Applications table */}
        <BentoCard
          title="Recent applications"
          subtitle="Most recent first"
          icon={Inbox}
          flush
          className="col-span-2 md:col-span-12"
        >
          {/* Where "Deleted …" is said: the row it was said about has gone. Only for someone who may edit. */}
          {canEdit ? <DeletionNotice className="px-4 pt-3" /> : null}
          {!model ? LOAD_FAILED : model.rows.length === 0 ? (
            <Muted>No applications yet</Muted>
          ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Candidate</TableHead>
                    <TableHead>Job</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Applied</TableHead>
                    <TableHead>
                      <span className="sr-only">Details</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {model.rows.map((r) => (
                    <ApplicationRow
                      key={r.id}
                      row={{ ...r, statusClass: STATUS_STYLES[r.status], live: r.status !== 'Rejected' }}
                      canEdit={canEdit}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
              <span className="text-xs text-muted-foreground">
                {model.total > model.rows.length
                  ? `Showing the newest ${model.rows.length} of ${model.total}`
                  : `Showing ${model.rows.length} applications`}
              </span>
              <span className="flex items-center gap-2">
                <CircleDot className="size-4" />
                {countOf('New') ?? 0} new
              </span>
            </div>
          </>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
