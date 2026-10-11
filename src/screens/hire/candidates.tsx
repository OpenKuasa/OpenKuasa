import { Filter, Plus, Search, Star, TrendingUp, Users } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import { AreaTrend, FunnelFlow, type Series, type Slice } from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { Button } from '@/components/ui/button';
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
import { cn } from '@/lib/utils';
import { buildBoardModel, type BoardModel } from '@/lib/hire/lists';
import { ApplicationMenu } from '@/screens/hire/application-actions';
import { FUNNEL_COLOR, LOAD_FAILED, Muted, loadHire } from '@/screens/hire/parts';

type Candidate = BoardModel['stages'][number]['candidates'][number];

const STAGE_DOT: Record<string, string> = {
  applied: 'bg-primary',
  screening: 'bg-amber-500',
  interview: 'bg-slate-500',
  offer: 'bg-blue-500',
  hired: 'bg-emerald-500',
};

const APPLICATIONS_SERIES: Series[] = [
  { key: 'applied', label: 'Applied', color: 'var(--chart-1)' },
  { key: 'shortlisted', label: 'Shortlisted', color: 'var(--chart-2)' },
];

function Stars({ rating }: { rating: number }) {
  return (
    // The rating in words for a screen reader: the stars are not the only signal.
    <div className="flex items-center gap-0.5" role="img" aria-label={`Rated ${rating} out of 5`} title={`Rated ${rating} out of 5`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          className={cn(
            'size-3',
            i < rating
              ? 'fill-amber-400 text-amber-400'
              : 'text-muted-foreground/30',
          )}
        />
      ))}
    </div>
  );
}

/** The id of a board column's heading: where focus goes when a card leaves that column for good. */
const headingId = (stage: string) => `hire-stage-${stage}`;

function CandidateCard({ candidate, canEdit }: { candidate: Candidate; canEdit: boolean }) {
  return (
    <div className="space-y-2 rounded-xl border bg-card p-3 shadow-sm transition-colors hover:border-primary/40">
      {/* Wraps, so the menu's "Moving…" line and any refusal take a line of their own inside the card. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
          {candidate.name.charAt(0)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-tight">
            {candidate.name}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {candidate.role}
          </p>
        </div>
        <LiveDot active={candidate.active} />
        {/* Ids, names and where the application stands: nothing else goes to the browser. */}
        <ApplicationMenu
          application={{
            id: candidate.id, name: candidate.name, job: candidate.role,
            stage: candidate.stage, outcome: candidate.outcome, rating: candidate.rating, rejectReason: candidate.rejectReason,
          }}
          canEdit={canEdit}
          columnHeadingId={headingId(candidate.stage)}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        {candidate.rating === null ? (
          <span className="text-xs text-muted-foreground">Not rated</span>
        ) : (
          <Stars rating={candidate.rating} />
        )}
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          {candidate.source}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Last touch · {candidate.lastTouch}
      </p>
    </div>
  );
}

export default async function CandidatesScreen() {
  const [{ model }, viewer] = await Promise.all([loadHire('candidates', buildBoardModel), getViewer()]);
  // Worked out once for the screen. The actions check again on the server, so this only decides what is drawn.
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  const funnel: Slice[] = (model?.funnel ?? []).map((f) => ({
    key: f.key,
    label: f.label,
    value: f.value,
    color: FUNNEL_COLOR[f.key],
  }));

  return (
    <ScreenContainer>
      <PageHeader
        title="Candidates"
        subtitle="Your hiring pipeline by stage, Saudara."
        actions={
          <>
            <Button variant="outline" size="sm" disabled title="Coming soon">
              Export
            </Button>
            <Button size="sm" disabled title="Coming soon">
              <Plus className="size-4" />
              Add Candidate
            </Button>
          </>
        }
      />

      <BentoGrid className="mb-6">
        {/* KPI row: headline figures only, the tables hold no history to chart */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat label="Active applications" value={model ? model.total : '—'} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="In pipeline" value={model ? model.inPipeline : '—'} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Interviewing" value={model ? model.interviewing : '—'} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Offers" value={model ? model.offers : '—'} />
        </BentoCard>

        {/* Trend + hiring funnel */}
        <BentoCard
          title="Applications over time"
          subtitle="Last 8 weeks"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {!model ? LOAD_FAILED : model.isEmpty ? (
            <Muted>No applications yet</Muted>
          ) : (
            <AreaTrend data={model.trend} series={APPLICATIONS_SERIES} height={240} showLegend />
          )}
        </BentoCard>
        <BentoCard
          title="Hiring funnel"
          subtitle="Applied → Hired"
          icon={Filter}
          className="col-span-2 md:col-span-4"
        >
          {!model ? LOAD_FAILED : model.isEmpty ? (
            <Muted>No applications yet</Muted>
          ) : (
            <FunnelFlow data={funnel} height={240} />
          )}
        </BentoCard>
      </BentoGrid>

      {/* Pipeline board */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <LiveDot active />
        <h2 className="text-sm font-semibold">Pipeline board</h2>
        <span className="text-xs text-muted-foreground">
          5 stages · {model ? model.total : '—'} candidates
        </span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search candidates across all stages…"
            className="pl-9"
            disabled
            title="Coming soon"
          />
        </div>
        <Select defaultValue="all" disabled>
          <SelectTrigger className="w-44" title="Coming soon">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All jobs</SelectItem>
          </SelectContent>
        </Select>
        <Select defaultValue="all-sources" disabled>
          <SelectTrigger className="w-44" title="Coming soon">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all-sources">All sources</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {!model ? (
        LOAD_FAILED
      ) : model.isEmpty ? (
        <Muted>No candidates yet</Muted>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {model.stages.map((stage) => (
            <div
              key={stage.key}
              className="flex w-72 shrink-0 flex-col rounded-xl border bg-muted/40 p-2"
            >
              <div className="mb-2 flex items-center gap-2 px-2 py-1.5">
                <span className={`size-2 rounded-full ${STAGE_DOT[stage.key]}`} />
                {/* Focusable by script only: a rejected or withdrawn card hands focus here as it leaves. */}
                <h3
                  id={headingId(stage.key)}
                  tabIndex={-1}
                  className="rounded-sm text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {stage.name}
                </h3>
                <span className="ml-auto flex items-center gap-1.5 rounded-full bg-background px-2 text-xs text-muted-foreground">
                  <Users className="size-3" />
                  {stage.count}
                </span>
              </div>
              <div className="space-y-2">
                {stage.candidates.length === 0 ? (
                  <Muted>None</Muted>
                ) : (
                  stage.candidates.map((candidate) => (
                    <CandidateCard key={candidate.id} candidate={candidate} canEdit={canEdit} />
                  ))
                )}
              </div>
              {stage.count > stage.candidates.length ? (
                <p className="mt-2 px-2 text-xs text-muted-foreground">
                  Showing the newest {stage.candidates.length} of {stage.count}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </ScreenContainer>
  );
}
