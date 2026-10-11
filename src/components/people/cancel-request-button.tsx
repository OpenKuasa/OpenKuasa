'use client';

import { useState, useTransition } from 'react';
import { cancelLeaveAction, cancelTimeOffAction } from '@/app/(app)/people/leave-actions';
import { Button } from '@/components/ui/button';
import { WRITE_FAILED } from '@/lib/people/capabilities';

/**
 * Cancels one of the signed-in member's own requests, after they confirm. It
 * sends the request id only; the database decides whether this member may
 * cancel it.
 */
export function CancelRequestButton({ kind, id }: { kind: 'leave' | 'time-off'; id: string }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function cancel() {
    setConfirming(false);
    setError(null);
    start(async () => {
      try {
        const result = await (kind === 'leave' ? cancelLeaveAction({ id }) : cancelTimeOffAction({ id }));
        if (!result.ok) setError(result.error);
      } catch {
        setError(WRITE_FAILED);
      }
    });
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      {confirming ? (
        <span className="inline-flex gap-2">
          <Button type="button" variant="destructive" size="sm" onClick={cancel}>
            Confirm
            <span className="sr-only"> cancelling this request</span>
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Keep
            <span className="sr-only"> this request</span>
          </Button>
        </span>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          {pending ? 'Cancelling…' : 'Cancel'}
          <span className="sr-only"> this request</span>
        </Button>
      )}
      {confirming ? (
        <span role="alert" className="max-w-56 whitespace-normal text-xs text-destructive">
          Cancel this request? This cannot be undone.
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="max-w-56 whitespace-normal text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
