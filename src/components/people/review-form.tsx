'use client';

import { Plus } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useEffect, useId, useState, useTransition } from 'react';
import { saveReviewAction } from '@/app/(app)/people/performance-actions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { toReviewInput } from '@/lib/people/performance-forms';
import {
  RATING_OPTIONS,
  type ReviewFormValues,
  type ReviewedPeriod,
  SCORE_OPTIONS,
  firstFreePeriod,
  periodTaken,
  reviewFormDefaults,
  scoreCell,
} from '@/lib/people/reviews-announcements';
import { COMPETENCIES } from '@/lib/people/types';

/** The review being edited: a draft's own fields. */
export type EditableReview = {
  id: string;
  employee_id: string;
  employee: string;
  period: string;
  rating: 'exceeds' | 'meets' | 'below';
  comment: string | null;
  competencies: Record<string, number>;
};

const SELECT_CLASS =
  'h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30';

type Saved = { score: number; employee: string; period: string };

function ReviewFormBody({
  employees,
  periods,
  reviewed,
  review,
  onClose,
  onBusy,
}: {
  employees: { id: string; name: string }[];
  periods: string[];
  /** Every review that exists for the employees this form can be about: id, employee and period. */
  reviewed: ReviewedPeriod[];
  review: EditableReview | null;
  onClose: () => void;
  /** Tells the dialog a save is in flight, so it stays open until the answer is shown. */
  onBusy: (busy: boolean) => void;
}) {
  const id = useId();
  // A new review starts with no employee, so no period is chosen until one is.
  const [values, setValues] = useState<ReviewFormValues>(() => reviewFormDefaults(review, ''));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    onBusy(pending);
  }, [pending, onBusy]);

  const edit = (next: Partial<ReviewFormValues>) => {
    setError(null);
    setValues((current) => ({ ...current, ...next }));
  };

  function chooseEmployee(employeeId: string) {
    // The period moves off one the new person already has, so a taken period is never left chosen.
    const stillFree = values.period !== '' && !periodTaken(reviewed, employeeId, values.period);
    edit({ employee_id: employeeId, period: stillFree ? values.period : firstFreePeriod(periods, reviewed, employeeId) });
  }

  function submit() {
    if (!values.employee_id) {
      setError('Choose who the review is for.');
      return;
    }
    const converted = toReviewInput({
      period: values.period,
      competencies: values.competencies,
      rating: values.rating,
      comment: values.comment,
    });
    if (!converted.ok) {
      setError(converted.error);
      return;
    }
    setError(null);
    start(async () => {
      try {
        const result = await saveReviewAction({
          employee_id: values.employee_id,
          ...(review ? { review_id: review.id } : {}),
          ...converted.input,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        // The score shown is the saved row's own, as the database worked it out.
        const row = result.data;
        setSaved({
          score: row.score,
          employee: employees.find((e) => e.id === values.employee_id)?.name ?? review?.employee ?? '',
          period: row.period,
        });
      } catch {
        setError(WRITE_FAILED);
      }
    });
  }

  if (saved) {
    return (
      <div className="space-y-4">
        <p role="status" className="text-sm">
          Saved as a draft{saved.employee ? ` for ${saved.employee}` : ''}, {saved.period}. Score {scoreCell(saved.score)}.
          {' '}It is not visible to them until you release it.
        </p>
        <div className="flex justify-end">
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-employee`}>
          Employee
          {review ? (
            <span className="flex h-8 items-center font-medium">{review.employee}</span>
          ) : (
            <select
              id={`${id}-employee`}
              className={SELECT_CLASS}
              disabled={pending}
              value={values.employee_id}
              onChange={(event) => chooseEmployee(event.target.value)}
            >
              <option value="">Choose…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          )}
        </label>
        <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-period`}>
          Period
          <select
            id={`${id}-period`}
            className={SELECT_CLASS}
            disabled={pending}
            value={values.period}
            onChange={(event) => edit({ period: event.target.value })}
          >
            <option value="">Choose…</option>
            {periods.map((p) => {
              const taken = values.employee_id !== '' && periodTaken(reviewed, values.employee_id, p, review?.id);
              return (
                <option key={p} value={p} disabled={taken}>
                  {taken ? `${p} (already reviewed)` : p}
                </option>
              );
            })}
          </select>
        </label>
      </div>

      <fieldset className="space-y-2" disabled={pending}>
        <legend className="text-sm font-medium">Scores out of 5</legend>
        <div className="grid grid-cols-2 gap-3">
          {COMPETENCIES.map((name) => (
            <label key={name} className="flex flex-col gap-1 text-sm" htmlFor={`${id}-${name}`}>
              {name}
              <select
                id={`${id}-${name}`}
                className={SELECT_CLASS}
                value={values.competencies[name]}
                onChange={(event) => edit({ competencies: { ...values.competencies, [name]: event.target.value } })}
              >
                <option value="">Score…</option>
                {SCORE_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">The overall score is worked out when you save.</p>
      </fieldset>

      <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-rating`}>
        Rating
        <select
          id={`${id}-rating`}
          className={SELECT_CLASS}
          disabled={pending}
          value={values.rating}
          onChange={(event) => edit({ rating: event.target.value as ReviewFormValues['rating'] })}
        >
          <option value="">Choose…</option>
          {RATING_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-comment`}>
        Comment (optional)
        <Textarea
          id={`${id}-comment`}
          disabled={pending}
          maxLength={2000}
          rows={4}
          value={values.comment}
          onChange={(event) => edit({ comment: event.target.value })}
        />
      </label>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? 'Working…' : review ? 'Save changes' : 'Save as draft'}
        </Button>
      </div>
    </form>
  );
}

/**
 * "New review" (no `review`) or "Edit" on a draft: a dialog around the review form. A review is always saved as a
 * draft; once saved the dialog shows the score the database worked out and says the employee cannot see it yet.
 * The page draws this for owners and admins outside the demo only.
 */
export function ReviewDialog({
  employees,
  periods,
  reviewed,
  review = null,
}: {
  employees: { id: string; name: string }[];
  periods: string[];
  reviewed: ReviewedPeriod[];
  review?: EditableReview | null;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    // While a save is in flight the dialog cannot be dismissed, so its answer (the saved score, or a refusal) is seen.
    <Dialog.Root open={open} onOpenChange={(next) => (next || !busy) && setOpen(next)}>
      <Dialog.Trigger asChild>
        {review ? (
          <Button type="button" variant="outline" size="sm" aria-label={`Edit ${review.employee}'s ${review.period} review`}>
            Edit
          </Button>
        ) : (
          <Button type="button" size="sm">
            <Plus aria-hidden />
            New review
          </Button>
        )}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg outline-none">
          <Dialog.Title className="text-base font-semibold">{review ? 'Edit review' : 'New review'}</Dialog.Title>
          <Dialog.Description className="mb-4 text-sm text-muted-foreground">
            {review
              ? 'Only a draft can be changed. Pull a released review back to a draft first.'
              : 'It is saved as a draft. The employee sees it only after you release it.'}
          </Dialog.Description>
          <ReviewFormBody
            employees={employees}
            periods={periods}
            reviewed={reviewed}
            review={review}
            onClose={() => setOpen(false)}
            onBusy={setBusy}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
