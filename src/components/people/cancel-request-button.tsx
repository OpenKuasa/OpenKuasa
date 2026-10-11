'use client';

import { useState, useTransition } from 'react';
import { cancelLeaveAction, cancelTimeOffAction } from '@/app/(app)/people/leave-actions';
import { Button } from '@/components/ui/button';
import { WRITE_FAILED } from '@/lib/people/capabilities';

/**
 * Cancels one of the signed-in member's own requests. It sends the request id
 * only; the database decides whether this member may cancel it.
 */
export function CancelRequestButton({ kind, id }: { kind: 'leave' | 'time-off'; id: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function cancel() {
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
      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={cancel}>
        {pending ? 'Cancelling…' : 'Cancel'}
        <span className="sr-only"> this request</span>
      </Button>
      {error ? (
        <span role="alert" className="max-w-56 whitespace-normal text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
