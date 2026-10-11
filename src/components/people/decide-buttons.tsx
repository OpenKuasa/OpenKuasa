'use client';

import { useState, useTransition } from 'react';
import {
  cancelClaimAction,
  cancelOvertimeAction,
  decideClaimAction,
  decideOvertimeAction,
} from '@/app/(app)/people/pay-actions';
import {
  cancelLeaveAction,
  cancelTimeOffAction,
  decideLeaveAction,
  decideTimeOffAction,
} from '@/app/(app)/people/leave-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CapResult } from '@/lib/people/capabilities';
import { RowPrompt } from './request-row';

export type DecideKind = 'leave' | 'time_off' | 'claim' | 'overtime';

type Decide = (input: { id: string; approve: boolean; note: string | null }) => Promise<CapResult<unknown>>;
type Cancel = (input: { id: string }) => Promise<CapResult<unknown>>;

const DECIDE: Record<DecideKind, Decide> = {
  leave: decideLeaveAction,
  time_off: decideTimeOffAction,
  claim: decideClaimAction,
  overtime: decideOvertimeAction,
};
const CANCEL: Record<DecideKind, Cancel> = {
  leave: cancelLeaveAction,
  time_off: cancelTimeOffAction,
  claim: cancelClaimAction,
  overtime: cancelOvertimeAction,
};

/**
 * Approve, Reject (with an optional note) and Cancel for one leave, time-off,
 * claim or overtime request. Every change is one call to the server action, which the database
 * checks again. A demo visitor sees the buttons disabled.
 */
export function DecideButtons({
  kind,
  id,
  pending,
  cancellable,
  disabled,
}: {
  kind: DecideKind;
  id: string;
  /** Still awaiting a decision: Approve and Reject show. */
  pending: boolean;
  /** Cancel shows. */
  cancellable: boolean;
  /** A demo visitor: every control is there but off. */
  disabled: boolean;
}) {
  const [busy, start] = useTransition();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const off = disabled || busy;

  function run(call: () => Promise<CapResult<unknown>>, done?: () => void) {
    setError(null);
    start(async () => {
      let result: CapResult<unknown>;
      try {
        result = await call();
      } catch {
        result = { ok: false, error: 'That change could not be saved. Please try again.' };
      }
      if (result.ok) done?.();
      else setError(result.error);
    });
  }

  const decide = (approve: boolean) => {
    const trimmed = note.trim();
    const input = { id, approve, note: approve || trimmed === '' ? null : trimmed };
    run(
      () => DECIDE[kind](input),
      () => {
        setRejecting(false);
        setNote('');
      },
    );
  };
  const cancel = () => {
    setConfirmingCancel(false);
    run(() => CANCEL[kind]({ id }));
  };
  const closeNote = () => {
    setRejecting(false);
    setNote('');
    setError(null);
  };

  if (!pending && !cancellable) return <span className="text-muted-foreground">—</span>;

  // The buttons stay in the Action column; every question and form they open goes to the row's prompt area
  // (`RowPrompt`), which is as wide as the table.
  return (
    <>
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        {pending ? (
          <>
            <Button type="button" size="sm" className="h-7 px-2.5 text-xs" disabled={off}
              onClick={() => {
                setConfirmingCancel(false);
                decide(true);
              }}
            >
              Approve
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              disabled={off}
              onClick={() => {
                setError(null);
                setConfirmingCancel(false);
                if (rejecting) closeNote();
                else setRejecting(true);
              }}
            >
              Reject
            </Button>
          </>
        ) : null}
        {cancellable && !confirmingCancel ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={off}
            onClick={() => {
              setError(null);
              setConfirmingCancel(true);
            }}
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {(cancellable && confirmingCancel) || rejecting || error ? (
        <RowPrompt>
          {cancellable && confirmingCancel ? (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-xs text-destructive">
                Cancel this request?{kind === 'leave' && !pending ? ' The days go back to the person\'s balance.' : ''} This cannot be undone.
              </p>
              <Button type="button" variant="destructive" size="sm" className="h-7 px-2.5 text-xs" disabled={off} onClick={cancel}>
                Confirm
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2.5 text-xs"
                disabled={off}
                onClick={() => setConfirmingCancel(false)}
              >
                Keep
              </Button>
            </div>
          ) : null}
          {rejecting ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                decide(false);
              }}
            >
              <Input
                aria-label="Note for the rejection (optional)"
                placeholder="Note (optional)"
                maxLength={500}
                className="h-7 w-64 text-xs"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <Button type="submit" variant="destructive" size="sm" className="h-7 px-2.5 text-xs" disabled={off}>
                Confirm reject
              </Button>
            </form>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </RowPrompt>
      ) : null}
    </>
  );
}
