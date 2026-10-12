'use client';

import { useState, useTransition } from 'react';
import { acknowledgeLetterAction } from '@/app/(app)/people/letter-actions';
import { Button } from '@/components/ui/button';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { ACK_LINE } from '@/lib/people/letters-screens';

/**
 * "I have read this" on an issued letter addressed to the viewer. A member's control: the employee is the logged-in
 * viewer's own record (the action takes no employee id), and the line under it says what it records.
 */
export function AcknowledgeLetterButton({ letterId }: { letterId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Shown at once; the refresh that follows confirms it, and a refusal puts the button back.
  const [done, setDone] = useState(false);

  function acknowledge() {
    setError(null);
    setDone(true);
    start(async () => {
      try {
        const result = await acknowledgeLetterAction({ letter_id: letterId });
        if (!result.ok) {
          setDone(false);
          setError(result.error);
        }
      } catch {
        setDone(false);
        setError(WRITE_FAILED);
      }
    });
  }

  return (
    <div className="space-y-1">
      {done ? (
        <p role="status" className="text-sm font-medium">
          Acknowledged
        </p>
      ) : (
        <>
          <Button type="button" size="sm" disabled={pending} onClick={acknowledge}>
            I have read this
          </Button>
          <p className="text-xs text-muted-foreground">{ACK_LINE}</p>
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
