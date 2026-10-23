'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { BarChart3, Filter, Plus, TrendingUp } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import { AreaTrend, BarGroup, FunnelFlow, Sparkline, type Series } from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { Button } from '@/components/ui/button';
import {
  ALL_OWNERS,
  DEFAULT_DEAL_FILTERS,
  viewShows,
  dealOwners,
  dealsInPipeline,
  filterDeals,
  statusCounts,
  type DealFilters,
} from '@/lib/crm/deal-filters';
import {
  dailyDealReport,
  dealKpis,
  formatRM,
  formatWinRate,
  stageColumns,
  stageCounts,
  weeklyDealTrend,
} from '@/lib/crm/deal-stats';
import type { CrmDeal, CrmDealContactChoice } from '@/lib/crm/deals';
import type { CrmDealActions } from '@/lib/crm/form-state';
import type { CrmPipeline } from '@/lib/crm/pipelines';
import { DealBoard, useDealMoves } from './deal-board';
import type { DealInvoiceChoice } from '@/lib/crm/invoice-links';
import { DealFormCard } from './deal-parts';
import { ManagePipelinesCard } from './deal-pipelines';
import { DailyReportCard } from './deal-report';
import {
  SAMPLE_DEALS,
  SAMPLE_FUNNEL,
  SAMPLE_PIPELINE,
  SAMPLE_PIPELINE_VALUE,
  SAMPLE_TOTAL_DEALS,
  SAMPLE_TREND,
} from './deal-sample';
import { DealsToolbar } from './deal-toolbar';

const TREND_SERIES: Series[] = [
  { key: 'created', label: 'Created', color: 'var(--chart-1)' },
  { key: 'won', label: 'Won', color: 'var(--chart-2)' },
];
const STAGE_SERIES: Series[] = [{ key: 'count', label: 'Deals', color: 'var(--chart-2)' }];

const NO_DEALS: CrmDeal[] = [];
const SAMPLE_PIPELINES = [SAMPLE_PIPELINE];
/** The sample board has always shown its won deals beside the open ones. */
const SAMPLE_FILTERS: DealFilters = { ...DEFAULT_DEAL_FILTERS, status: 'all' };
/** Sample deals carry no dates, so any moment will do for their report. */
const SAMPLE_NOW = '2026-01-01T00:00:00.000Z';

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

type DealsScreenProps = {
  /** Live pipelines. Omitted when no database is configured, which shows the sample. */
  pipelines?: CrmPipeline[];
  /** Live deals, across every pipeline. */
  deals?: CrmDeal[];
  /** How many deals the workspace has, which can be more than were loaded. */
  totalDeals?: number;
  /** The contacts a deal can be for. */
  contacts?: CrmDealContactChoice[];
  /** Bendahara's invoices, to link to a deal on its edit form. */
  invoices?: DealInvoiceChoice[];
  /** Present only when the signed-in person may change deals. */
  actions?: CrmDealActions;
  /** The workspace's rule that a deal marked lost needs a reason (Kasturi > Settings). */
  requireLostReason?: boolean;
  /** `?open=<id>`: the deal whose card opens on load, when it is not among `deals`. */
  openDeal?: CrmDeal | null;
  /** `?open=<id>`, when it is a valid id. */
  openId?: string | null;
  /** When the page was put together, as an ISO string: "today" for the report and the trend. */
  now?: string;
};

export default function DealsScreen({
  pipelines,
  deals,
  totalDeals,
  contacts,
  invoices,
  actions,
  requireLostReason = false,
  openDeal = null,
  openId = null,
  now,
}: DealsScreenProps = {}) {
  // With live deals every figure comes from them. The sample screen keeps
  // its sample figures and charts.
  const live = pipelines !== undefined;
  const allPipelines = pipelines ?? SAMPLE_PIPELINES;
  const loadedDeals = live ? (deals ?? NO_DEALS) : SAMPLE_DEALS;
  // A dropped card counts as moved at once, on the board and in the figures.
  const moves = useDealMoves(loadedDeals, actions?.move);
  const allDeals = moves.deals;
  const at = useMemo(() => new Date(now ?? SAMPLE_NOW), [now]);

  // A link such as /crm/deals?open=<id> opens that deal's card. An id that is not a deal of this workspace opens nothing.
  const linkedDeal =
    actions && openId ? (loadedDeals.find((deal) => deal.id === openId) ?? openDeal) : null;

  const [pipelineId, setPipelineId] = useState<string | null>(linkedDeal?.pipelineId ?? null);
  // The one picked, else the default, which is listed first.
  const pipeline = allPipelines.find((p) => p.id === pipelineId) ?? allPipelines[0] ?? null;
  const stages = useMemo(() => pipeline?.stages ?? [], [pipeline]);

  // Search, owner and the status view all work on the deals already loaded.
  const [filters, setFilters] = useState<DealFilters>(live ? DEFAULT_DEAL_FILTERS : SAMPLE_FILTERS);

  // Create deal on a contact's row comes here as ?contact=<id>: the form
  // opens with that contact chosen.
  const pathname = usePathname();
  const contactParam = useSearchParams()?.get('contact') ?? null;
  const [newDealContactId, setNewDealContactId] = useState(actions ? contactParam : null);

  // One thing is open at a time: the form card, or a question on one deal.
  const [adding, setAdding] = useState(newDealContactId !== null);
  const [editing, setEditing] = useState<CrmDeal | null>(linkedDeal);
  const [asking, setAsking] = useState<{ kind: 'delete' | 'lost'; id: string } | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [managing, setManaging] = useState(false);

  const pipelineDeals = useMemo(
    () => dealsInPipeline(allDeals, pipeline?.id ?? null),
    [allDeals, pipeline],
  );
  const shown = useMemo(() => filterDeals(pipelineDeals, filters), [pipelineDeals, filters]);
  const columns = useMemo(() => stageColumns(stages, shown), [stages, shown]);
  const owners = useMemo(() => dealOwners(pipelineDeals), [pipelineDeals]);
  const kpis = useMemo(() => dealKpis(pipelineDeals), [pipelineDeals]);
  const trend = useMemo(() => weeklyDealTrend(pipelineDeals, at), [pipelineDeals, at]);
  const byStage = useMemo(() => stageCounts(stages, pipelineDeals), [stages, pipelineDeals]);
  const report = useMemo(() => dailyDealReport(pipelineDeals, at), [pipelineDeals, at]);

  // What the status view is keeping off the board, so a deal that has just
  // been won or lost is not simply gone.
  const counts = statusCounts(pipelineDeals);
  const hiddenByView = (['open', 'won', 'lost'] as const)
    .filter((status) => !viewShows(filters.status, status) && counts[status] > 0)
    .map((status) => `${counts[status]} ${status}`)
    .join(', ');

  const firstFieldRef = useRef<HTMLElement>(null);
  const askingRef = useRef<HTMLElement>(null);
  const reportCloseRef = useRef<HTMLButtonElement>(null);
  const manageButtonRef = useRef<HTMLButtonElement>(null);
  const manageCloseRef = useRef<HTMLButtonElement>(null);

  const focusForm = () => {
    firstFieldRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    firstFieldRef.current?.focus({ preventScroll: true });
  };

  // A menu holds on to focus until it has closed, so what it opened is
  // focused then. Says whether it moved focus.
  const focusOnMenuClose = useRef<'form' | 'asking' | null>(null);
  const menuClosed = () => {
    const target = focusOnMenuClose.current;
    focusOnMenuClose.current = null;
    if (target === 'form') focusForm();
    else if (target === 'asking') askingRef.current?.focus();
    return target !== null;
  };

  // New Deal and Daily Report are plain buttons: what they open is focused
  // once it is on the page.
  const [formOpened, setFormOpened] = useState(newDealContactId !== null || linkedDeal ? 1 : 0);
  useEffect(() => {
    if (formOpened > 0) focusForm();
  }, [formOpened]);
  // Once read, the contact or deal leaves the address, so a reload does not reopen the form.
  useEffect(() => {
    if (!(contactParam || openId) || !pathname) return;
    const params = new URLSearchParams(window.location.search);
    params.delete('contact');
    params.delete('open');
    const rest = params.toString();
    window.history.replaceState(null, '', rest ? `${pathname}?${rest}` : pathname);
  }, [contactParam, openId, pathname]);
  useEffect(() => {
    if (reportOpen) reportCloseRef.current?.focus();
  }, [reportOpen]);
  useEffect(() => {
    if (managing) manageCloseRef.current?.focus();
  }, [managing]);

  const startAdd = () => {
    setNewDealContactId(null);
    setAdding(true);
    setEditing(null);
    setAsking(null);
    setFormOpened((n) => n + 1);
  };
  const closeForm = () => {
    setNewDealContactId(null);
    setAdding(false);
    setEditing(null);
  };
  const startEdit = (deal: CrmDeal) => {
    setEditing(deal);
    setAdding(false);
    setAsking(null);
    focusOnMenuClose.current = 'form';
  };
  const ask = (kind: 'delete' | 'lost', deal: CrmDeal) => {
    setAsking({ kind, id: deal.id });
    setEditing((e) => (e?.id === deal.id ? null : e));
    focusOnMenuClose.current = 'asking';
  };
  const changePipeline = (id: string) => {
    setPipelineId(id);
    // The other pipeline has its own owners, stages and deals.
    setFilters((f) => ({ ...f, owner: ALL_OWNERS }));
    closeForm();
    setAsking(null);
  };

  const toggleManaging = () => {
    // Making another pipeline the default must not change the board under
    // the person, so the pipeline on show is held from here on.
    if (!managing && pipeline) setPipelineId(pipeline.id);
    // Closing hands focus back to the button that opened the card.
    if (managing) manageButtonRef.current?.focus();
    setManaging(!managing);
  };
  const pipelineDeleted = (id: string) => {
    if (id !== pipeline?.id) return;
    // The board falls back to the default, which has its own owners.
    setPipelineId(null);
    setFilters((f) => ({ ...f, owner: ALL_OWNERS }));
    closeForm();
    setAsking(null);
  };

  const canAdd = Boolean(actions) && stages.length > 0;

  return (
    <ScreenContainer>
      <PageHeader
        title="Deals"
        subtitle="Your sales pipeline — move deals toward close."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              aria-expanded={reportOpen}
              onClick={() => setReportOpen((open) => !open)}
            >
              Daily Report
            </Button>
            {canAdd ? (
              <Button size="sm" onClick={startAdd}>
                <Plus className="size-4" />
                New Deal
              </Button>
            ) : live ? null : (
              // Nothing to add to on the sample view.
              <Button size="sm">
                <Plus className="size-4" />
                New Deal
              </Button>
            )}
          </>
        }
      />

      <BentoGrid className="mb-6">
        {reportOpen ? (
          <DailyReportCard
            report={report}
            pipelineName={pipeline?.name ?? 'No pipeline'}
            showDate={live}
            onClose={() => setReportOpen(false)}
            closeRef={reportCloseRef}
          />
        ) : null}
        {actions && (adding || editing) ? (
          <DealFormCard
            // A fresh form for each deal, and for adding.
            key={editing?.id ?? 'new'}
            action={actions.save}
            editing={editing}
            newDealContactId={newDealContactId}
            stages={stages}
            contacts={contacts ?? []}
            invoices={invoices}
            loadNotes={actions.notes}
            // An edit is finished once saved. After adding, the cleared form
            // stays for the next deal until it is closed.
            onSaved={() => {
              if (editing) closeForm();
            }}
            onClose={closeForm}
            firstFieldRef={firstFieldRef}
          />
        ) : null}

        {/* KPI row */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Pipeline value"
            value={formatRM(live ? kpis.pipelineValue : SAMPLE_PIPELINE_VALUE)}
            delta={live ? undefined : '+9%'}
            onPrimary
            chart={
              live ? undefined : (
                <Sparkline
                  data={[118, 126, 131, 140, 149, 155, 160, 164.5]}
                  color="var(--primary-foreground)"
                  height={36}
                />
              )
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Open deals"
            value={String(live ? kpis.openDeals : SAMPLE_TOTAL_DEALS)}
            delta={live ? undefined : '+2'}
            deltaTone="up"
            chart={
              live ? undefined : (
                <Sparkline data={[5, 6, 6, 7, 7, 8, 8, 8]} color="var(--chart-2)" height={36} />
              )
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Avg deal size"
            value={formatRM(
              live ? kpis.averageDealSize : SAMPLE_PIPELINE_VALUE / SAMPLE_TOTAL_DEALS,
            )}
            delta={live ? undefined : '+6%'}
            deltaTone="up"
            chart={
              live ? undefined : (
                <Sparkline
                  data={[16.2, 17.1, 17.8, 18.5, 19.2, 19.8, 20.1, 20.6]}
                  color="var(--chart-5)"
                  height={36}
                />
              )
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Win rate"
            value={live ? formatWinRate(kpis.winRate) : '38%'}
            delta={live ? undefined : '+3pt'}
            deltaTone="up"
            chart={
              live ? undefined : (
                <Sparkline
                  data={[31, 33, 32, 34, 35, 36, 37, 38]}
                  color="var(--chart-3)"
                  height={36}
                />
              )
            }
          />
        </BentoCard>

        {/* Trend + pipeline by stage */}
        <BentoCard
          title="Deals created vs won"
          subtitle="Last 8 weeks"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          <AreaTrend
            data={live ? trend : SAMPLE_TREND}
            series={TREND_SERIES}
            height={240}
            showLegend
          />
        </BentoCard>
        {live ? (
          // The funnel sizes every bar against the first stage, which misleads
          // when a later stage holds more deals; plain bars do not.
          <BentoCard
            title="Pipeline by stage"
            subtitle="Open and won deals"
            icon={BarChart3}
            className="col-span-2 md:col-span-4"
          >
            <BarGroup data={byStage} series={STAGE_SERIES} horizontal height={240} />
          </BentoCard>
        ) : (
          <BentoCard
            title="Pipeline by stage"
            subtitle="Deals in flight"
            icon={Filter}
            className="col-span-2 md:col-span-4"
          >
            <FunnelFlow data={SAMPLE_FUNNEL} height={240} />
          </BentoCard>
        )}
      </BentoGrid>

      {/* Pipeline board */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <LiveDot active />
        <h2 className="text-sm font-semibold">Pipeline board</h2>
        <span className="text-xs text-muted-foreground">
          {plural(stages.length, 'stage', 'stages')} · {plural(shown.length, 'deal', 'deals')}
        </span>
      </div>

      {pipeline ? (
        <>
          <DealsToolbar
            filters={filters}
            onChange={setFilters}
            pipelines={allPipelines}
            pipelineId={pipeline.id}
            onPipelineChange={changePipeline}
            owners={owners}
            managing={managing}
            onManage={actions ? toggleManaging : undefined}
            manageButtonRef={manageButtonRef}
          />

          {actions && managing ? (
            <div className="mb-4">
              <ManagePipelinesCard
                pipelines={allPipelines}
                deals={allDeals}
                dealsCapped={(totalDeals ?? 0) > allDeals.length}
                actions={actions}
                onCreated={changePipeline}
                onDeleted={pipelineDeleted}
                onClose={toggleManaging}
                closeRef={manageCloseRef}
              />
            </div>
          ) : null}

          {hiddenByView || (live && (totalDeals ?? 0) > allDeals.length) ? (
            <p className="mb-3 text-xs text-muted-foreground">
              {hiddenByView ? `In other views: ${hiddenByView}. ` : ''}
              {live && (totalDeals ?? 0) > allDeals.length
                ? `The board and its figures cover the ${allDeals.length} most recent of ${totalDeals} deals.`
                : ''}
            </p>
          ) : null}

          <DealBoard
            columns={columns}
            stages={stages}
            actions={actions}
            requireLostReason={requireLostReason}
            moves={moves}
            asking={asking}
            onEdit={startEdit}
            onAsk={ask}
            onAskClosed={() => setAsking(null)}
            onMenuClosed={menuClosed}
            askingRef={askingRef}
          />
          {stages.length === 0 ? (
            <p className="rounded-xl border bg-muted/40 p-4 text-sm text-muted-foreground">
              This pipeline has no stages yet, so it cannot hold deals.
            </p>
          ) : null}
        </>
      ) : (
        <p className="rounded-xl border bg-muted/40 p-4 text-sm text-muted-foreground">
          {actions
            ? 'The pipeline for this workspace could not be set up. Reload the page to try again.'
            : 'This workspace has no pipeline yet. It is set up the first time someone who can edit deals opens this page.'}
        </p>
      )}
    </ScreenContainer>
  );
}
