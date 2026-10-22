'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  cancelShiftSwapAction,
  decideShiftSwapAction,
  replyShiftSwapAction,
} from '@/app/(app)/people/swap-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CapResult } from '@/lib/people/capabilities';
import { SWAP_REFUSALS } from '@/lib/people/swap-refusals';

const SMALL = 'h-7 px-2.5 text-xs';

/**
 * The controls for one shift swap. `reply`: Accept and Decline (the colleague). `decide`: Approve, and Reject with
 * an optional note (an approver). `cancel` adds Cancel, with a confirmation (either of the two people). Every
 * step is one server action, which the database checks again.
 */
export function SwapButtons({
  id,
  reply = false,
  decide = false,
  cancel = false,
  disabled = false,
}: {
  id: string;
  reply?: boolean;
  decide?: boolean;
  cancel?: boolean;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [rejecting, setRejecting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const off = disabled || busy;

  function run(call: () => Promise<CapResult<unknown>>) {
    setError(null);
    start(async () => {
      let result: CapResult<unknown>;
      try {
        result = await call();
      } catch {
        result = { ok: false, error: 'That change could not be saved. Please try again.' };
      }
      if (result.ok) {
        setRejecting(false);
        setConfirming(false);
        setNote('');
        router.refresh();
        return;
      }
      setError(result.error);
      // Someone else moved it on first: load the page afresh so the stale row and its buttons go.
      if (result.error === SWAP_REFUSALS.SWAP_NOT_PENDING) router.refresh();
    });
  }

  if (!reply && !decide && !cancel) return <span className="text-muted-foreground">—</span>;

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {reply ? (
          <>
            <Button type="button" size="sm" className={SMALL} disabled={off} onClick={() => run(() => replyShiftSwapAction({ id, accept: true }))}>
              Accept
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={SMALL}
              disabled={off}
              onClick={() => run(() => replyShiftSwapAction({ id, accept: false }))}
            >
              Decline
            </Button>
          </>
        ) : null}
        {decide ? (
          <>
            <Button
              type="button"
              size="sm"
              className={SMALL}
              disabled={off}
              onClick={() => run(() => decideShiftSwapAction({ id, approve: true, note: null }))}
            >
              Approve
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={SMALL}
              disabled={off}
              aria-expanded={rejecting}
              onClick={() => {
                setConfirming(false);
                setRejecting((v) => !v);
              }}
            >
              Reject
            </Button>
          </>
        ) : null}
        {cancel ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={SMALL}
            disabled={off}
            aria-expanded={confirming}
            onClick={() => {
              setRejecting(false);
              setConfirming((v) => !v);
            }}
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {rejecting ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            run(() => decideShiftSwapAction({ id, approve: false, note: note.trim() || null }));
          }}
        >
          <Input
            aria-label="Note for the rejection (optional)"
            placeholder="Note (optional)"
            maxLength={500}
            className="h-7 w-56 text-xs"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button type="submit" variant="destructive" size="sm" className={SMALL} disabled={off}>
            Confirm reject
          </Button>
        </form>
      ) : null}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-destructive">Cancel this swap? This cannot be undone.</p>
          <Button type="button" variant="destructive" size="sm" className={SMALL} disabled={off} onClick={() => run(() => cancelShiftSwapAction({ id }))}>
            Confirm
          </Button>
          <Button type="button" variant="ghost" size="sm" className={SMALL} disabled={off} onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="max-w-72 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
