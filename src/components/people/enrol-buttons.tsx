'use client';

import { useState, useTransition } from 'react';
import { enrolMeAction, withdrawMeAction } from '@/app/(app)/people/performance-actions';
import { Button } from '@/components/ui/button';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import type { MemberCourseControl } from '@/lib/people/goals-training';

/**
 * A member's one control on a course: Enrol, Withdraw, "You are enrolled" or "Completed" (chosen by the screen with
 * `memberCourseControl`; nothing here decides it). Only the member's own enrolment is ever touched: the actions take
 * no employee. A refusal shows beside the button and goes when the control changes (the screen keys this component
 * on the control). The database re-checks the dates, the active record and the completion.
 */
export function EnrolButtons({ trainingId, control, title }: { trainingId: string; control: MemberCourseControl; title: string }) {
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (control === 'none') return null;
  if (control === 'enrolled') return <span className="text-xs text-muted-foreground">You are enrolled</span>;
  if (control === 'completed') return <span className="text-xs text-muted-foreground">Completed</span>;

  const enrolling = control === 'enrol';
  function press() {
    setError(null);
    start(async () => {
      try {
        const result = enrolling ? await enrolMeAction({ training_id: trainingId }) : await withdrawMeAction({ training_id: trainingId });
        if (!result.ok) setError(result.error);
      } catch {
        setError(WRITE_FAILED);
      }
    });
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2.5 text-xs"
        disabled={busy}
        aria-label={`${enrolling ? 'Enrol in' : 'Withdraw from'} ${title}`}
        onClick={press}
      >
        {busy ? 'Working…' : enrolling ? 'Enrol' : 'Withdraw'}
      </Button>
      {error ? (
        <span role="alert" className="max-w-56 whitespace-normal text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
