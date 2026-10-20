'use client';

import {
  useCallback,
  useOptimistic,
  useState,
  useTransition,
  type DragEvent,
  type RefObject,
} from 'react';
import { applyDealMove, canDropDeal } from '@/lib/crm/deal-board';
import { formatRM, type DealStageColumn } from '@/lib/crm/deal-stats';
import type { CrmDeal } from '@/lib/crm/deals';
import type { CrmDealActions, CrmFormAction, CrmFormState } from '@/lib/crm/form-state';
import type { CrmPipelineStage } from '@/lib/crm/pipelines';
import { cn } from '@/lib/utils';
import {
  DealCard,
  DeleteDealConfirm,
  EditableDealCard,
  LostDealConfirm,
} from './deal-parts';

const NO_IDS: string[] = [];
const MOVE_FAILED = 'Could not move the deal. Please try again.';

export type DealMoves = {
  /** The deals with every drop still on its way already applied. */
  deals: CrmDeal[];
  /** The deals whose drop the server has not answered yet. */
  movingIds: string[];
  /** Why a deal's last drop did not go through, by deal id. */
  errors: Record<string, string>;
  move: (deal: CrmDeal, stage: CrmPipelineStage) => void;
  clearError: (dealId: string) => void;
};

/**
 * Moves dropped cards. The card shows in its new stage at once and the
 * server's answer settles it: the page's fresh deals take over when the move
 * went through, and the card goes back with a message when it did not.
 */
export function useDealMoves(deals: CrmDeal[], moveAction?: CrmFormAction): DealMoves {
  const [shown, showMoved] = useOptimistic(deals, applyDealMove);
  const [movingIds, showMoving] = useOptimistic(NO_IDS, (ids: string[], id: string) => [
    ...ids,
    id,
  ]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [, startTransition] = useTransition();

  const clearError = useCallback((dealId: string) => {
    setErrors((current) => {
      if (!(dealId in current)) return current;
      const rest = { ...current };
      delete rest[dealId];
      return rest;
    });
  }, []);

  const move = (deal: CrmDeal, stage: CrmPipelineStage) => {
    if (!moveAction || movingIds.includes(deal.id) || !canDropDeal(deal, stage.id)) return;
    clearError(deal.id);

    startTransition(async () => {
      showMoved({ dealId: deal.id, stage, at: new Date().toISOString() });
      showMoving(deal.id);

      const formData = new FormData();
      formData.set('dealId', deal.id);
      formData.set('stageId', stage.id);

      let result: CrmFormState;
      try {
        result = await moveAction(undefined, formData);
      } catch {
        // The request itself failed, such as with no connection.
        result = { ok: false, error: MOVE_FAILED, values: {} };
      }
      if (result && !result.ok) {
        const { error } = result;
        // Shown as the card goes back to where it was.
        startTransition(() => setErrors((current) => ({ ...current, [deal.id]: error })));
      }
    });
  };

  return { deals: shown, movingIds, errors, move, clearError };
}

/** The columns of the board, one per stage, with the cards in each. */
export function DealBoard({
  columns,
  stages,
  actions,
  requireLostReason = false,
  moves,
  asking,
  onEdit,
  onAsk,
  onAskClosed,
  onMenuClosed,
  askingRef,
}: {
  columns: DealStageColumn[];
  /** Every stage of the pipeline on the board. */
  stages: CrmPipelineStage[];
  /** Present only when the signed-in person may change deals. */
  actions?: CrmDealActions;
  /** The workspace's rule that a deal marked lost needs a reason (Kasturi > Settings). */
  requireLostReason?: boolean;
  moves: DealMoves;
  /** The deal a question is being asked about, in place of its card. */
  asking: { kind: 'delete' | 'lost'; id: string } | null;
  onEdit: (deal: CrmDeal) => void;
  onAsk: (kind: 'delete' | 'lost', deal: CrmDeal) => void;
  onAskClosed: () => void;
  onMenuClosed: () => boolean;
  askingRef: RefObject<HTMLElement | null>;
}) {
  // The card being dragged, and the stage it is over. A drag event only says
  // what it carries once dropped, so the card is remembered here.
  const [dragging, setDragging] = useState<CrmDeal | null>(null);
  const [overStageId, setOverStageId] = useState<string | null>(null);

  const endDrag = () => {
    setDragging(null);
    setOverStageId(null);
  };

  const dropHandlers = (stage: CrmPipelineStage) => ({
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      // Its own column, or something dragged in from elsewhere, is not a drop.
      if (!canDropDeal(dragging, stage.id)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (overStageId !== stage.id) setOverStageId(stage.id);
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      // Passing over a card inside the column is not leaving it.
      const to = event.relatedTarget;
      if (to instanceof Node && event.currentTarget.contains(to)) return;
      setOverStageId((current) => (current === stage.id ? null : current));
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      if (!dragging || !canDropDeal(dragging, stage.id)) return;
      event.preventDefault();
      const deal = dragging;
      // The card leaves its column now, so it may never hear the drag end.
      endDrag();
      moves.move(deal, stage);
    },
  });

  return (
    <>
      {actions && stages.length > 1 ? (
        <p className="mb-3 text-xs text-muted-foreground">
          Drag a card to another stage, or use Move to in its menu.
        </p>
      ) : null}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {columns.map(({ stage, deals: inStage, total }) => (
          <div
            key={stage.id}
            {...(actions ? dropHandlers(stage) : {})}
            className={cn(
              'flex w-72 shrink-0 flex-col rounded-xl border bg-muted/40 p-2 transition-colors',
              overStageId === stage.id && 'border-primary bg-primary/10 ring-2 ring-primary/30',
            )}
          >
            <div className="mb-2 px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className={`size-2 rounded-full ${stage.dot}`} />
                <h3 className="text-sm font-semibold">{stage.name}</h3>
                <span className="ml-auto rounded-full bg-background px-2 text-xs text-muted-foreground">
                  {inStage.length}
                </span>
              </div>
              <p className="mt-1 text-xs tabular-nums text-muted-foreground">{formatRM(total)}</p>
            </div>
            <div className="space-y-2">
              {inStage.map((deal) =>
                actions && asking?.id === deal.id ? (
                  asking.kind === 'delete' ? (
                    <DeleteDealConfirm
                      key={deal.id}
                      deal={deal}
                      action={actions.remove}
                      onClose={onAskClosed}
                      focusRef={askingRef}
                    />
                  ) : (
                    <LostDealConfirm
                      key={deal.id}
                      deal={deal}
                      action={actions.markLost}
                      onClose={onAskClosed}
                      focusRef={askingRef}
                      requireReason={requireLostReason}
                    />
                  )
                ) : actions ? (
                  <EditableDealCard
                    key={deal.id}
                    deal={deal}
                    stages={stages}
                    actions={actions}
                    onEdit={() => onEdit(deal)}
                    onMarkLost={() => onAsk('lost', deal)}
                    onDelete={() => onAsk('delete', deal)}
                    onMenuClosed={onMenuClosed}
                    drag={{
                      moving: moves.movingIds.includes(deal.id),
                      error: moves.errors[deal.id],
                      active: dragging?.id === deal.id,
                      onStart: () => setDragging(deal),
                      onEnd: endDrag,
                      onOtherChange: () => moves.clearError(deal.id),
                    }}
                  />
                ) : (
                  <DealCard key={deal.id} deal={deal} />
                ),
              )}
              {inStage.length === 0 ? (
                <p className="px-2 pb-2 text-xs text-muted-foreground">No deals here.</p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
