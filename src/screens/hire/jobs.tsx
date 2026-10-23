import { BarChart3, Briefcase, PieChart, Search } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import {
  BarGroup,
  DonutStat,
  type Series,
  type Slice,
} from '@/components/charts';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import { buildJobsModel } from '@/lib/hire/lists';
import { JobsTable } from '@/screens/hire/jobs-table';
import { LOAD_FAILED, Muted, NOT_AVAILABLE, loadHire } from '@/screens/hire/parts';

/* ---- static config ------------------------------------------------ */

const APPLICANTS_SERIES: Series[] = [
  { key: 'applicants', label: 'Applicants', color: 'var(--chart-2)' },
];

const STATUS_COLOR: Record<string, string> = {
  open: 'var(--chart-1)',
  paused: 'var(--chart-3)',
  closed: 'var(--chart-4)',
  draft: 'var(--chart-2)',
};

/* ------------------------------------------------------------------ */

export default async function JobsScreen() {
  const [{ model }, viewer] = await Promise.all([loadHire('jobs', buildJobsModel), getViewer()]);
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The date in Kuala Lumpur, so the form and the server agree on "today".
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
  const statusMix: Slice[] = (model?.statusMix ?? []).map((s) => ({
    ...s,
    color: STATUS_COLOR[s.key],
  }));

  const departments = [...new Set((model?.rows ?? []).map((r) => r.dept))].filter((d) => d !== '—');

  return (
    <ScreenContainer>
      <PageHeader
        title="Jobs"
        subtitle="Your open positions."
      />

      <BentoGrid>
        {/* KPI row */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Open roles"
            value={model ? String(model.openJobs) : '—'}
            onPrimary
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Total applicants"
            value={model ? String(model.totalApplicants) : '—'}
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <p className="text-sm text-muted-foreground">Avg time-to-fill</p>
          {NOT_AVAILABLE}
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <p className="text-sm text-muted-foreground">Filled · YTD</p>
          {NOT_AVAILABLE}
        </BentoCard>

        {/* Applicants by job + status mix */}
        <BentoCard
          title="Applicants by job"
          subtitle="Open roles"
          icon={BarChart3}
          className="col-span-2 md:col-span-8"
        >
          {!model ? LOAD_FAILED : model.byJob.length === 0 ? (
            <Muted>No open jobs yet</Muted>
          ) : (
            <BarGroup
              data={model.byJob}
              series={APPLICANTS_SERIES}
              horizontal
              height={240}
            />
          )}
        </BentoCard>
        <BentoCard
          title="Jobs by status"
          subtitle="All postings"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          {!model ? LOAD_FAILED : model.isEmpty ? (
            <Muted>No jobs yet</Muted>
          ) : (
            <DonutStat
              data={statusMix}
              height={240}
              centerValue={String(model.rows.length)}
              centerLabel="jobs"
            />
          )}
        </BentoCard>

        {/* Jobs table */}
        <BentoCard
          title="All jobs"
          subtitle="Positions & applicants"
          icon={Briefcase}
          flush
          className="col-span-2 md:col-span-12"
        >
          <div className="flex flex-wrap items-center gap-2 px-4">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search jobs…" className="pl-9" disabled title="Coming soon" />
            </div>
            <Select defaultValue="all" disabled>
              <SelectTrigger className="w-44" title="Coming soon">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Departments</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select defaultValue="all" disabled>
              <SelectTrigger className="w-40" title="Coming soon">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="paused">Paused</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {!model ? LOAD_FAILED : (
            <>
              <JobsTable rows={model.rows} canEdit={canEdit} today={today} />
              {!model.isEmpty && (
                <div className="border-t px-4 py-3 text-sm text-muted-foreground">
                  Showing {model.rows.length} jobs · {model.totalApplicants} applicants
                </div>
              )}
            </>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
