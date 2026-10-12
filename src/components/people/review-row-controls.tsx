'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import {
  deleteReviewAction,
  releaseReviewAction,
  unreleaseReviewAction,
} from '@/app/(app)/people/performance-actions';
import { Button } from '@/components/ui/button';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import {
  type ReviewedPeriod,
  deleteReviewSentence,
  pullBackSentence,
  releaseSentence,
} from '@/lib/people/reviews-announcements';
import { RowPrompt } from './request-row';
import { type EditableReview, ReviewDialog } from './review-form';

type Step = 'idle' | 'releasing' | 'pulling' | 'deleting';

async function settle<T>(call: () => Promise<CapResult<T>>): Promise<CapResult<T>> {
  try {
    return await call();
  } catch {
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * What an owner or admin can do with one review row. A draft: Edit, Release and Delete. A released review: Pull back
 * to draft. Release, Pull back and Delete each take a second step that says what will happen; nothing is sent until
 * Confirm. Every button is disabled while a call is in flight and only the one pressed says "Working…". A refusal
 * shows under the question and clears when the question changes or the row changes state. Pressing the button of a
 * question that is already open leaves it open. The page draws this for owners and admins outside the demo only.
 */
export function ReviewRowControls({
  review,
  draft,
  employees,
  periods,
  reviewed,
}: {
  review: EditableReview;
  draft: boolean;
  employees: { id: string; name: string }[];
  periods: string[];
  /** The periods this employee already has a review for. */
  reviewed: ReviewedPeriod[];
}) {
  const [pending, start] = useTransition();
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  // Which question's Confirm was pressed, so only that button says it is working.
  const [working, setWorking] = useState<Step | null>(null);
  const refocus = useRef<HTMLButtonElement | null>(null);
  const triggers = useRef<Partial<Record<Step, HTMLButtonElement | null>>>({});

  // The row changed state (released, pulled back) or another row took this place: a stale question and refusal go.
  const key = `${review.id}:${draft}`;
  const [shownFor, setShownFor] = useState(key);
  if (shownFor !== key) {
    setShownFor(key);
    setStep('idle');
    setError(null);
    setWorking(null);
  }
  useEffect(() => {
    if (step !== 'idle' || pending || !refocus.current) return;
    refocus.current.focus();
    refocus.current = null;
  }, [step, pending]);

  const close = () => {
    refocus.current = step === 'idle' ? null : (triggers.current[step] ?? null);
    setStep('idle');
    setError(null);
  };
  const open = (next: Exclude<Step, 'idle'>) => {
    if (step === next) return;
    setError(null);
    setStep(next);
  };

  const sentence =
    step === 'releasing'
      ? releaseSentence(review.employee)
      : step === 'pulling'
        ? pullBackSentence(review.employee)
        : step === 'deleting'
          ? deleteReviewSentence(review.employee, review.period)
          : '';

  function confirm() {
    const call =
      step === 'releasing'
        ? () => releaseReviewAction({ review_id: review.id })
        : step === 'pulling'
          ? () => unreleaseReviewAction({ review_id: review.id })
          : step === 'deleting'
            ? () => deleteReviewAction({ review_id: review.id })
            : null;
    if (!call) return;
    setError(null);
    setWorking(step);
    start(async () => {
      const result = await settle(call);
      setWorking(null);
      if (result.ok) {
        refocus.current = null;
        setStep('idle');
      } else setError(result.error);
    });
  }

  const trigger = (which: Exclude<Step, 'idle'>, label: string, name: string) => (
    <Button
      key={which}
      ref={(node) => {
        triggers.current[which] = node;
      }}
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      aria-expanded={step === which}
      aria-label={name}
      onClick={() => open(which)}
    >
      {label}
    </Button>
  );

  const who = `${review.employee}'s ${review.period} review`;
  const confirmLabel = step === 'releasing' ? 'Release' : step === 'pulling' ? 'Pull back' : 'Delete';

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {draft ? (
          <>
            <ReviewDialog employees={employees} periods={periods} reviewed={reviewed} review={review} />
            {trigger('releasing', 'Release', `Release ${who}`)}
            {trigger('deleting', 'Delete', `Delete ${who}`)}
          </>
        ) : (
          trigger('pulling', 'Pull back to draft', `Pull ${who} back to draft`)
        )}
      </div>
      {step !== 'idle' ? (
        <RowPrompt focusKey={step} onEscape={close}>
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm">
              {sentence}
            </p>
            <Button
              type="button"
              size="sm"
              variant={step === 'deleting' ? 'destructive' : 'default'}
              disabled={pending}
              onClick={confirm}
            >
              {pending && working === step ? 'Working…' : confirmLabel}
            </Button>
            <Button type="button" variant="ghost" size="sm" data-autofocus disabled={pending} onClick={close}>
              Keep
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </RowPrompt>
      ) : null}
    </div>
  );
}
