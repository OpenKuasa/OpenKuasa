import { ArrowLeftRight, Hourglass, ListChecks } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { SwapButtons } from '@/components/people/swap-buttons';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { todayInMalaysia } from '@/lib/people/dates';
import { buildSwapApprovals, listSwaps, type SwapApprovals } from '@/lib/people/swaps';
import { teamScreenView } from '@/lib/people/tier';
import { HrOnlyScreen, LOAD_FAILED, Muted, loadPeople } from './parts';
import { SwapTable } from './swap-table';

const EMPTY: SwapApprovals = { waiting: [], with_colleague: [], recent: [] };

/**
 * Shift swaps waiting for a decision: every swap for an owner or admin, and for a manager those between two of
 * their reports. Approving exchanges the two shifts; the database refuses it if the roster moved since the swap
 * was asked for. Never in the demo (there are none there; the screen says so).
 */
export default async function ApproveShiftSwapsScreen() {
  const { model, viewer } = await loadPeople('approve-shift-swaps', async (data, now, ctx) => {
    if (!ctx.orgId || ctx.viewer.isDemo || teamScreenView(ctx.viewer) === 'none') return EMPTY;
    const [swaps, employees, types] = await Promise.all([
      listSwaps({ client: ctx.client, orgId: ctx.orgId }),
      data.listEmployees(),
      data.listShiftTypes(),
    ]);
    return buildSwapApprovals({
      swaps,
      viewer: ctx.viewer,
      employees,
      types: Object.fromEntries(types.map((t) => [t.id, t])),
      today: todayInMalaysia(now),
    });
  });
  const view = teamScreenView(viewer);
  if (view === 'none') return <HrOnlyScreen title="Shift Swaps" />;
  const dash = '—';

  return (
    <ScreenContainer>
      <PageHeader
        title="Shift Swaps"
        subtitle={view === 'manager' ? 'Swaps between people who report to you' : 'Swaps staff have agreed between themselves'}
      />
      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-6">
          <BentoStat label="Waiting for a decision" value={model ? model.waiting.length : dash} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-6">
          <BentoStat label="Waiting for the colleague" value={model ? model.with_colleague.length : dash} />
        </BentoCard>

        <BentoCard title="Waiting for a decision" subtitle="Both people have agreed" icon={ArrowLeftRight} flush className="col-span-2 md:col-span-12">
          {!model ? (
            LOAD_FAILED
          ) : view === 'demo' ? (
            <Muted>Shift swaps are not part of the sample company</Muted>
          ) : model.waiting.length === 0 ? (
            <Muted>No swaps are waiting for a decision</Muted>
          ) : (
            <SwapTable
              rows={model.waiting}
              action={(row) =>
                row.decidable ? (
                  <SwapButtons id={row.id} decide />
                ) : (
                  <span className="text-xs text-muted-foreground">You are in this swap: someone else decides it</span>
                )
              }
            />
          )}
        </BentoCard>

        {model && model.with_colleague.length > 0 ? (
          <BentoCard title="Waiting for the colleague" subtitle="Not yet agreed: nothing to decide" icon={Hourglass} flush className="col-span-2 md:col-span-12">
            <SwapTable rows={model.with_colleague} />
          </BentoCard>
        ) : null}

        {model && model.recent.length > 0 ? (
          <BentoCard title="Recent" subtitle="Decided, declined, cancelled or expired" icon={ListChecks} flush className="col-span-2 md:col-span-12">
            <SwapTable rows={model.recent} />
          </BentoCard>
        ) : null}
      </BentoGrid>
    </ScreenContainer>
  );
}
