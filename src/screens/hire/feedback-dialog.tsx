'use client';

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { getInterviewFeedbackAction, saveInterviewFeedbackAction } from '@/app/(app)/hire/actions';
import {
  COMMENTS_HELP, LOAD_CURRENT_FEEDBACK, LOAD_CURRENT_FEEDBACK_HELP, RATINGS, RATING_HELP, RECOMMENDATION_HELP, charactersLeft, countAnnouncement, countShown,
  countText, currentFeedbackResult, feedbackDialogDescription, feedbackDialogTitle, feedbackDiscardTitle, feedbackFieldId, feedbackFocusIdAfter, feedbackGone,
  feedbackNotice, feedbackProblems, feedbackRefreshAfter, feedbackRefusalWord, feedbackResult, feedbackSubmission, feedbackSubmitLabel,
  firstWrongFeedbackField, isFeedbackDirty, offersFeedbackReload, ratingId, ratingSpoken, recommendationId, startingValues,
  type FeedbackField, type FeedbackFormValues, type FeedbackMode, type FeedbackPart, type FeedbackProblems, type FeedbackSubmission,
} from '@/lib/hire/feedback-dialog-state';
import { NOTHING_CHANGED, canSubmit } from '@/lib/hire/interview-dialog-state';
import { FEEDBACK_LIMITS, FEEDBACK_SAVE_FAILED, RECOMMENDATIONS, RECOMMENDATION_LABEL, type Feedback } from '@/lib/hire/interview-feedback';
import type { InterviewRow } from '@/lib/hire/lists';
import { cn } from '@/lib/utils';
import { FormDialog } from '@/screens/hire/candidate-forms';
import { announceDeletion } from '@/screens/hire/delete-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * The feedback form: one dialog for adding feedback to a completed interview,
 * editing it, and marking a scheduled interview completed with its feedback in
 * one step. It belongs to the row whose menu opened it, and gives focus back
 * to that menu's button.
 *
 * Every decision made here is a function in `feedback-dialog-state.ts`.
 */

// The same sizes and looks as the other hiring forms (see interview-dialog.tsx).
const TARGET = 'min-h-11 min-w-11';
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
const WAITING = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:active:translate-y-0';
const ALERT_CLASS = 'rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive';
const HELP = 'text-xs text-muted-foreground';
const FIELD = 'min-w-0 space-y-1.5';
const RADIO = 'size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
// Each radio with its label is a 44 pixel target. The chosen one is shown by the radio and by the weight of its label, never by colour alone.
const CHOICE = 'flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-sm has-[:focus-visible]:bg-muted';

type Refusal = { text: string; word: string | null };

export type FeedbackFormViewProps = {
  /** The prefix of every id in the form. */
  base: string;
  values: FeedbackFormValues;
  problems: FeedbackProblems;
  /** A refusal from the server: in the alert at the top, which takes focus. */
  refusal: Refusal | null;
  /** An edit was submitted with nothing altered. */
  unchanged: boolean;
  pending: boolean;
  /** What the polite line reads out about the characters left: only when the count first appears and when it reaches 0. */
  announced: string;
  onChange: <K extends FeedbackField>(field: K, value: FeedbackFormValues[K]) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  /** Given once the stored feedback was read after a "changed a moment ago" refusal: loads it into the form. */
  onLoadCurrent?: () => void;
};

/**
 * The form's content, with no state of its own, so each of its states can be
 * drawn and read on its own. Native radios in a fieldset with a legend: arrow
 * keys move within a group, Tab moves between groups, and a screen reader
 * reads each rating as "4 out of 5".
 */
export function FeedbackFormView({
  base, values, problems, refusal, unchanged, pending, announced, onChange, onSubmit, onCancel, onLoadCurrent,
}: FeedbackFormViewProps) {
  const id = (part: FeedbackPart) => feedbackFieldId(base, part);
  const helpId = (part: FeedbackPart) => `${id(part)}-help`;
  const errorId = (field: FeedbackField) => `${id(field)}-error`;
  /** The ids that describe a group or a field: its error first, then its helper. */
  const describedBy = (field: FeedbackField) => [problems[field] && errorId(field), helpId(field)].filter(Boolean).join(' ');
  const errorOf = (field: FeedbackField) =>
    problems[field] ? (
      <p id={errorId(field)} role="alert" className="text-sm break-words text-destructive">
        {problems[field]}
      </p>
    ) : null;
  const waiting = pending || undefined;
  const left = charactersLeft(values.comments);

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      {/* A refusal from the server: first in the form, and it takes focus. */}
      {refusal ? (
        <p id={id('alert')} role="alert" tabIndex={-1} className={cn(ALERT_CLASS, 'break-words', FOCUS)}>
          {refusal.text}
        </p>
      ) : null}
      {/* Someone else changed the feedback: the stored one was read, and the person chooses whether to load it.
          Nothing is sent again by itself, and what was typed stays until they choose. */}
      {refusal && offersFeedbackReload(refusal.word, onLoadCurrent !== undefined, pending) ? (
        <div className="space-y-1.5">
          <Button type="button" variant="outline" size="sm" className={TARGET} aria-describedby={helpId('reload')} onClick={onLoadCurrent}>
            {LOAD_CURRENT_FEEDBACK}
          </Button>
          <p id={helpId('reload')} className={HELP}>
            {LOAD_CURRENT_FEEDBACK_HELP}
          </p>
        </div>
      ) : null}

      <fieldset className="min-w-0" aria-describedby={describedBy('rating')}>
        <legend className="text-sm font-medium">Rating</legend>
        {/* Five 44 pixel targets on one line: they fit a 375 pixel screen. */}
        <div className="mt-1 flex gap-1">
          {RATINGS.map((rating) => (
            <label key={rating} htmlFor={ratingId(base, rating)} className={cn(CHOICE, values.rating === rating && 'font-semibold')}>
              <input
                id={ratingId(base, rating)}
                type="radio"
                name={`${base}-rating`}
                className={RADIO}
                checked={values.rating === rating}
                // Read as "4 out of 5"; the digit beside it is for the eye.
                aria-label={ratingSpoken(rating)}
                aria-disabled={waiting}
                onChange={() => {
                  if (!pending) onChange('rating', rating);
                }}
              />
              <span aria-hidden="true">{rating}</span>
            </label>
          ))}
        </div>
        <p id={helpId('rating')} className={HELP}>
          {RATING_HELP}
        </p>
        {errorOf('rating')}
      </fieldset>

      <fieldset className="min-w-0" aria-describedby={describedBy('recommendation')}>
        <legend className="text-sm font-medium">Recommendation</legend>
        {/* "Reject" is in the ordinary style: it rejects nothing. The three wrap if they must. */}
        <div className="mt-1 flex flex-wrap gap-1">
          {RECOMMENDATIONS.map((recommendation) => (
            <label
              key={recommendation}
              htmlFor={recommendationId(base, recommendation)}
              className={cn(CHOICE, values.recommendation === recommendation && 'font-semibold')}
            >
              <input
                id={recommendationId(base, recommendation)}
                type="radio"
                name={`${base}-recommendation`}
                className={RADIO}
                checked={values.recommendation === recommendation}
                aria-disabled={waiting}
                onChange={() => {
                  if (!pending) onChange('recommendation', recommendation);
                }}
              />
              {RECOMMENDATION_LABEL[recommendation]}
            </label>
          ))}
        </div>
        <p id={helpId('recommendation')} className={HELP}>
          {RECOMMENDATION_HELP}
        </p>
        {errorOf('recommendation')}
      </fieldset>

      <div className={FIELD}>
        <Label htmlFor={id('comments')}>Comments</Label>
        <Textarea
          id={id('comments')}
          rows={5}
          className="min-h-28 break-words"
          value={values.comments}
          maxLength={FEEDBACK_LIMITS.comments}
          aria-invalid={problems.comments ? true : undefined}
          aria-describedby={describedBy('comments')}
          onChange={(event) => onChange('comments', event.target.value)}
        />
        <p id={helpId('comments')} className={HELP}>
          {COMMENTS_HELP}
        </p>
        {countShown(left) ? (
          <p id={id('count')} className={HELP}>
            {countText(left)}
          </p>
        ) : null}
        {/* Always in the page, and empty but for the two moments the count is read out: not on every keystroke. */}
        <p aria-live="polite" className="sr-only">
          {announced}
        </p>
        {errorOf('comments')}
      </div>

      {/* Nothing was altered: the button explains instead of sending. */}
      {unchanged ? (
        <p id={id('unchanged')} role="alert" className="text-sm text-muted-foreground">
          {NOTHING_CHANGED}
        </p>
      ) : null}

      <div className="flex justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(TARGET, WAITING)}
          aria-disabled={waiting}
          onClick={() => {
            if (!pending) onCancel();
          }}
        >
          Cancel
        </Button>
        {/* Not disabled while it is saved: it keeps focus, says it is waiting, and the submit ignores the press. */}
        <Button
          type="submit"
          size="sm"
          className={cn(TARGET, WAITING)}
          aria-disabled={waiting}
          aria-describedby={unchanged ? id('unchanged') : undefined}
        >
          {feedbackSubmitLabel(pending)}
        </Button>
      </div>
    </form>
  );
}

type Send = Extract<FeedbackSubmission, { kind: 'save' }>;

/** The form with what is typed. A new one is made (by `key`) when the current feedback is loaded: it starts at it, as a form opened afresh does. */
function FeedbackForm({
  mode, row, stored, pending, refusal, onDirtyChange, onClearRefusal, onCancel, onSend, onLoadCurrent,
}: {
  mode: FeedbackMode;
  row: InterviewRow;
  /** The feedback an edit starts from: its saved time goes with the save, so a later change by someone else is refused, not replaced. */
  stored: Feedback | null;
  pending: boolean;
  refusal: Refusal | null;
  onDirtyChange: (dirty: boolean) => void;
  onClearRefusal: () => void;
  onCancel: () => void;
  onSend: (plan: Send) => void;
  onLoadCurrent?: () => void;
}) {
  const base = useId();
  const [initial] = useState(() => startingValues(mode, stored));
  const [values, setValues] = useState(initial);
  const [problems, setProblems] = useState<FeedbackProblems>({});
  const [unchanged, setUnchanged] = useState(false);
  const [announced, setAnnounced] = useState('');

  // On opening: the Rating group, on the stored rating when editing.
  useEffect(() => {
    const first = feedbackFocusIdAfter({ after: 'open', values: initial }, base);
    if (first) document.getElementById(first)?.focus();
  }, [base, initial]);
  // A refusal from the server takes focus.
  useEffect(() => {
    if (!refusal) return;
    const target = feedbackFocusIdAfter({ after: 'refusal' }, base);
    if (target) document.getElementById(target)?.focus();
  }, [refusal, base]);

  function change<K extends FeedbackField>(field: K, value: FeedbackFormValues[K]) {
    if (pending) return;
    const next = { ...values, [field]: value };
    if (field === 'comments') setAnnounced(countAnnouncement(charactersLeft(values.comments), charactersLeft(next.comments)));
    setValues(next);
    setUnchanged(false);
    if (problems[field]) setProblems((found) => ({ ...found, [field]: undefined }));
    onClearRefusal();
    onDirtyChange(isFeedbackDirty(initial, next));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit(pending)) return;
    const found = feedbackProblems(values);
    setProblems(found);
    if (firstWrongFeedbackField(found)) {
      const wrong = feedbackFocusIdAfter({ after: 'check', problems: found, values }, base);
      if (wrong) document.getElementById(wrong)?.focus();
      return;
    }
    const plan = feedbackSubmission(mode, values, { id: row.id, stored });
    if (plan.kind === 'nothing') {
      setUnchanged(true);
      return;
    }
    onSend(plan);
  }

  return (
    <FeedbackFormView
      base={base}
      values={values}
      problems={problems}
      refusal={refusal}
      unchanged={unchanged}
      pending={pending}
      announced={announced}
      onChange={change}
      onSubmit={submit}
      onCancel={onCancel}
      onLoadCurrent={onLoadCurrent}
    />
  );
}

/**
 * The feedback dialog of one row: closed while `target` is null. It holds
 * while a save is under way: Escape, Cancel and a click outside do nothing.
 * After a save it closes and the sentence goes to the screen's notice line. A
 * refusal stays in the form; one that means the row is out of date also
 * fetches the screen again.
 */
export function FeedbackDialog({
  target, onClose, returnFocus,
}: {
  target: { mode: FeedbackMode; row: InterviewRow } | null;
  onClose: () => void;
  returnFocus: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  /** True from the press until the answer: `pending` only turns true on the next render. */
  const inFlight = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  /** The stored feedback, read after a save was refused because someone else had changed it; not yet in the form. */
  const [fresh, setFresh] = useState<Feedback | null>(null);
  /** The stored feedback the person chose to load: what the form now starts from, and whose saved time the next save carries. */
  const [loaded, setLoaded] = useState<Feedback | null>(null);
  const [formKey, setFormKey] = useState(0);

  function close() {
    setDirty(false);
    setRefusal(null);
    setFresh(null);
    setLoaded(null);
    onClose();
  }

  /** "Load the current feedback": the form is drawn again from the feedback as it is now. What was typed is discarded, by choice. */
  function loadCurrent() {
    if (!fresh || pending || inFlight.current) return;
    setLoaded(fresh);
    setFresh(null);
    setRefusal(null);
    setDirty(false);
    setFormKey((key) => key + 1);
  }

  function save(plan: Send) {
    if (!target || pending || inFlight.current) return;
    inFlight.current = true;
    const id = target.row.id;
    // Cleared first, so the same refusal twice in a row is announced twice.
    setRefusal(null);
    setFresh(null);
    start(async () => {
      try {
        const result = feedbackResult(await saveInterviewFeedbackAction(plan.input, plan.seen));
        if (result.ok) {
          // The screen's notice line: read out now, and still there when the dialog has closed.
          announceDeletion(feedbackNotice(result.change));
          close();
          return;
        }
        const word = feedbackRefusalWord(result.error);
        if (feedbackGone(word)) {
          // The interview has gone, and its row goes with the refresh: the notice line outlives both.
          announceDeletion(result.error);
          close();
          router.refresh();
          return;
        }
        setRefusal({ text: result.error, word });
        // Out of date, or not known to have failed: the fresh row shows what is true.
        if (feedbackRefreshAfter(word)) router.refresh();
        if (word === 'changed') {
          // Someone else changed it. The stored feedback is read, so the person can choose to load it: nothing is sent
          // again by itself, and what they typed stays in the form until they choose.
          try {
            const current = currentFeedbackResult(await getInterviewFeedbackAction({ id }), id);
            if (current.ok) setFresh(current.current);
            // Cleared, or gone: that is what is true now, and there is nothing to load.
            else setRefusal({ text: current.error, word: null });
          } catch {
            // The refusal stands as it was said; closing and opening the form again still works.
          }
        }
      } catch {
        // The answer was lost. The feedback may have been saved: say so and fetch the screen again.
        setRefusal({ text: FEEDBACK_SAVE_FAILED, word: null });
        router.refresh();
      } finally {
        inFlight.current = false;
      }
    });
  }

  return (
    <FormDialog
      open={target !== null}
      title={target ? feedbackDialogTitle(target.mode, target.row.name) : ''}
      description={target ? feedbackDialogDescription(target.mode, target.row) : ''}
      discardTitle={target ? feedbackDiscardTitle(target.mode) : ''}
      dirty={dirty}
      pending={pending}
      onClose={close}
      returnFocus={returnFocus}
    >
      {(requestClose) =>
        target ? (
          <FeedbackForm
            key={formKey}
            mode={target.mode}
            row={target.row}
            stored={loaded ?? target.row.feedback ?? null}
            pending={pending}
            refusal={refusal}
            onDirtyChange={setDirty}
            onClearRefusal={() => setRefusal(null)}
            onCancel={requestClose}
            onSend={save}
            onLoadCurrent={fresh ? loadCurrent : undefined}
          />
        ) : null
      }
    </FormDialog>
  );
}
