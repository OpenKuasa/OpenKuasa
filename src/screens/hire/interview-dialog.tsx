'use client';

import { useEffect, useId, useRef, useState, useSyncExternalStore, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  getInterviewForEditAction,
  moveApplicationAction,
  recordPastInterviewAction,
  rescheduleInterviewAction,
  scheduleInterviewAction,
} from '@/app/(app)/hire/actions';
import type { InterviewChange } from '@/lib/hire/capabilities';
import { DELETION_NOTICE_ID } from '@/lib/hire/delete-dialog-state';
import {
  COPY_FAILED, DONE, DOWNLOAD_HELP, LOAD_CURRENT, LOAD_CURRENT_HELP, DOWNLOAD_LABEL, FIND_HELP, ICS_MIME, INTERVIEWER_HELP, MOVED, NOTES_HELP, NOTHING_CHANGED, OUTCOME_HELP,
  canSubmit, copyLabel, dateBounds, dateHelper, dialogDescription, dialogTitle, discardTitle, durationOptions, emptyValues, fieldId,
  fieldOfRefusal, focusIdAfter, interviewProblems, interviewResult, inviteLead, inviteTitle, isDirty, keptChoice,
  moveInput, moveLabel, moveResult, noticeOf, offersMove, onOf, pickerNotes, pickerOptions, placeHelper, placeLabel, refreshAfter, refusalWord,
  calendarOf, clockAt, currentResult, offersReload, rowWithCurrent, stepAfter, submission, submitLabel, timeHelper, valuesFrom,
  type CalendarFile, type FieldPart, type InterviewField, type InterviewFormMode, type InterviewFormValues, type InterviewProblems, type PastOutcome, type Submission,
} from '@/lib/hire/interview-dialog-state';
import { INTERVIEW_KINDS, INTERVIEW_SAVE_FAILED, KIND_WORDS } from '@/lib/hire/interviews';
import type { InterviewRow, PickerApplication } from '@/lib/hire/lists';
import { cn } from '@/lib/utils';
import { SELECT_CLASS } from '@/screens/crm/crm-form';
import { copyText, downloadTextFile } from '@/screens/hire/browser-only';
import { FormDialog } from '@/screens/hire/candidate-forms';
import { announceDeletion } from '@/screens/hire/delete-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * The interview form in its three modes (schedule, change, record a past
 * interview) and the invitation step that follows a schedule or a change.
 *
 * There is ONE dialog a screen: `InterviewDialogHost`, drawn once beside the
 * notice line. A control opens it with `openInterview(...)`. It is not owned
 * by the card, row or button that opened it, because a board card that moves
 * to another column is drawn again as a new component, and a dialog it owned
 * would vanish with the invitation nobody had copied yet.
 *
 * Every decision made here is a function in `interview-dialog-state.ts`.
 */

// The same sizes and looks as the other hiring controls (see candidate-forms.tsx).
const TARGET = 'min-h-11 min-w-11';
const FIELD_HEIGHT = 'h-11';
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
const WAITING = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:active:translate-y-0';
const ALERT_CLASS = 'rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive';
const HELP = 'text-xs text-muted-foreground';
const FIELD = 'min-w-0 space-y-1.5';
const HAPPENED: Record<PastOutcome, string> = { completed: 'Completed', no_show: 'No-show' };
const OUTCOMES: readonly PastOutcome[] = ['completed', 'no_show'];

// ─── the time now ────────────────────────────────────────────────────────────

/**
 * The time now by the server's clock, for a handler to ask. `serverNow` is
 * the instant the server drew the screen with; the browser adds only how long
 * it has had the page (the difference of two of its own readings), so a
 * browser clock that is wrong or in another zone does not make the form
 * refuse a time that is ahead, or let through one that has passed. Without `serverNow` (a
 * caller that has none) the browser's own clock is all there is.
 */
export function useServerClock(serverNow: string | undefined): () => Date {
  const received = useRef<number | null>(null);
  useEffect(() => {
    // Noted when the page (or a fresh copy of it) arrives.
    received.current = Date.now();
  }, [serverNow]);
  return () => (serverNow ? clockAt(serverNow, received.current, Date.now()) : new Date());
}

// ─── what is open ────────────────────────────────────────────────────────────

/**
 * What the dialog was opened for. `focusId` is the DOM id of the control that
 * opened it, where focus goes back to. A change holds the row AS IT WAS when
 * the form opened: its `updatedAt` is sent with the save, so a row a colleague
 * has changed since is refused, not replaced, however often the screen behind
 * the form is fetched again.
 */
export type InterviewRequest =
  | { mode: 'schedule' | 'past'; application: { id: string; name: string; job: string } | null; focusId: string }
  | { mode: 'change'; row: InterviewRow; focusId: string };

let request: InterviewRequest | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const tell = () => {
  for (const listener of listeners) listener();
};

/** Opens the screen's interview dialog. `application: null` opens it with the application picker (the Interviews header). */
export function openInterview(next: InterviewRequest): void {
  request = next;
  tell();
}

function closeInterview(): void {
  request = null;
  tell();
}

// ─── the form, drawn from plain values ───────────────────────────────────────

type Refusal = { text: string; word: string | null };

export type InterviewFormViewProps = {
  /** The prefix of every id in the form. */
  base: string;
  mode: InterviewFormMode;
  /** The application the form is for, when a card, a panel or a row fixed it; null when it is picked here. */
  fixed: { name: string; job: string } | null;
  picker: { applications: PickerApplication[]; cut: boolean };
  query: string;
  values: InterviewFormValues;
  problems: InterviewProblems;
  /** A refusal from the server: at the field it is about, else in the alert at the top. */
  refusal: Refusal | null;
  /** A change form was submitted with nothing altered. */
  unchanged: boolean;
  pending: boolean;
  /** Today in Kuala Lumpur, from the server. */
  today: string;
  /** The length the interview is stored with, so it is offered even when it is not one of the eight. */
  storedDuration: number | null;
  onQuery: (text: string) => void;
  onChange: <K extends InterviewField>(field: K, value: InterviewFormValues[K]) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  /** Given once the interview's current details were read after a "changed a moment ago" refusal: loads them into the form. */
  onLoadCurrent?: () => void;
};

/**
 * The form's content, with no state of its own, so each of its states can be
 * drawn and read on its own. Native date, time and select controls: a phone
 * shows its own pickers, a keyboard can type every part, a screen reader reads
 * each part.
 */
export function InterviewFormView({
  base, mode, fixed, picker, query, values, problems, refusal, unchanged, pending, today, storedDuration, onQuery, onChange, onSubmit, onCancel, onLoadCurrent,
}: InterviewFormViewProps) {
  const id = (part: FieldPart) => fieldId(base, part);
  const helpId = (part: FieldPart) => `${id(part)}-help`;
  const errorId = (field: InterviewField) => `${id(field)}-error`;
  const refusedField = refusal ? fieldOfRefusal(refusal.word) : null;
  /** What is wrong with a field: the server's refusal when it is about this field, else the form's own check. */
  const wrong = (field: InterviewField) => (refusal && refusedField === field ? refusal.text : problems[field]);
  /** The ids that describe a control: its error first, then its helper. */
  const describedBy = (field: InterviewField) => [wrong(field) && errorId(field), helpId(field)].filter(Boolean).join(' ');
  /** The error under a field, announced when it appears. */
  const errorOf = (field: InterviewField) =>
    wrong(field) ? (
      <p id={errorId(field)} role="alert" className="text-sm break-words text-destructive">
        {wrong(field)}
      </p>
    ) : null;
  const invalid = (field: InterviewField) => (wrong(field) ? true : undefined);
  const bounds = dateBounds(mode, today);
  const picked = fixed ? null : pickerOptions(picker.applications, query, mode);
  const notes = fixed ? null : pickerNotes(picker.applications, query, mode, picker.cut);
  const pickerSaid = notes ? [notes.none, notes.noMatch, notes.more, notes.cut].filter(Boolean).join(' ') : '';
  const waiting = pending || undefined;

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      {/* A refusal that is about no field: first in the form, and it takes focus. */}
      {refusal && !refusedField ? (
        <p id={id('alert')} role="alert" tabIndex={-1} className={cn(ALERT_CLASS, 'break-words', FOCUS)}>
          {refusal.text}
        </p>
      ) : null}
      {/* Someone else changed the interview: its current details were read, and the person chooses whether to load them.
          Nothing is sent again by itself, and what was typed stays until they choose. */}
      {refusal && offersReload(refusal.word, onLoadCurrent !== undefined, pending) ? (
        <div className="space-y-1.5">
          <Button type="button" variant="outline" size="sm" className={TARGET} aria-describedby={helpId('reload')} onClick={onLoadCurrent}>
            {LOAD_CURRENT}
          </Button>
          <p id={helpId('reload')} className={HELP}>
            {LOAD_CURRENT_HELP}
          </p>
        </div>
      ) : null}

      {fixed ? (
        <dl className="text-sm">
          <dt className="text-xs font-medium text-muted-foreground">Application</dt>
          <dd className="break-words">{`${fixed.name} — ${fixed.job}`}</dd>
        </dl>
      ) : (
        <>
          <div className={FIELD}>
            <Label htmlFor={id('find')}>Find an application</Label>
            <Input
              id={id('find')}
              type="search"
              className={FIELD_HEIGHT}
              value={query}
              autoComplete="off"
              aria-describedby={helpId('find')}
              onChange={(event) => onQuery(event.target.value)}
            />
            <p id={helpId('find')} className={HELP}>
              {FIND_HELP}
            </p>
          </div>
          <div className={FIELD}>
            <Label htmlFor={id('application_id')}>Application</Label>
            <select
              id={id('application_id')}
              className={cn(SELECT_CLASS, FIELD_HEIGHT, 'w-full min-w-0')}
              value={values.application_id}
              aria-required="true"
              aria-invalid={invalid('application_id')}
              aria-describedby={describedBy('application_id')}
              onChange={(event) => onChange('application_id', event.target.value)}
            >
              <option value="">Choose an application</option>
              {picked?.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            {/* Always in the page, so "No active application matches." is read out as the list empties. */}
            <p id={helpId('application_id')} aria-live="polite" className={cn(HELP, !pickerSaid && 'sr-only')}>
              {pickerSaid}
            </p>
            {errorOf('application_id')}
          </div>
        </>
      )}

      {/* Side by side from 400 pixels, stacked below it. */}
      <div className="grid gap-4 min-[400px]:grid-cols-2">
        <div className={FIELD}>
          <Label htmlFor={id('date')}>Date</Label>
          <Input
            id={id('date')}
            type="date"
            className={FIELD_HEIGHT}
            value={values.date}
            min={bounds.min}
            max={bounds.max}
            aria-required="true"
            aria-invalid={invalid('date')}
            aria-describedby={describedBy('date')}
            onChange={(event) => onChange('date', event.target.value)}
          />
          <p id={helpId('date')} className={HELP}>
            {dateHelper(mode)}
          </p>
          {errorOf('date')}
        </div>
        <div className={FIELD}>
          <Label htmlFor={id('time')}>Time</Label>
          <Input
            id={id('time')}
            type="time"
            className={FIELD_HEIGHT}
            value={values.time}
            aria-required="true"
            aria-invalid={invalid('time')}
            aria-describedby={describedBy('time')}
            onChange={(event) => onChange('time', event.target.value)}
          />
          <p id={helpId('time')} className={HELP}>
            {timeHelper(mode)}
          </p>
          {errorOf('time')}
        </div>
      </div>

      <div className="grid gap-4 min-[400px]:grid-cols-2">
        <div className={FIELD}>
          <Label htmlFor={id('duration_minutes')}>Duration</Label>
          <select
            id={id('duration_minutes')}
            className={cn(SELECT_CLASS, FIELD_HEIGHT, 'w-full min-w-0')}
            value={String(values.duration_minutes)}
            aria-invalid={invalid('duration_minutes')}
            aria-describedby={wrong('duration_minutes') ? errorId('duration_minutes') : undefined}
            onChange={(event) => onChange('duration_minutes', Number(event.target.value))}
          >
            {durationOptions(storedDuration).map((option) => (
              <option key={option.value} value={String(option.value)}>
                {option.label}
              </option>
            ))}
          </select>
          {errorOf('duration_minutes')}
        </div>
        <div className={FIELD}>
          <Label htmlFor={id('kind')}>Type</Label>
          <select
            id={id('kind')}
            className={cn(SELECT_CLASS, FIELD_HEIGHT, 'w-full min-w-0')}
            value={values.kind}
            onChange={(event) => {
              const kind = INTERVIEW_KINDS.find((known) => known === event.target.value);
              if (kind) onChange('kind', kind);
            }}
          >
            {INTERVIEW_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_WORDS[kind]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {mode === 'past' ? (
        // Asked only when recording: an interview that already took place is never saved as "scheduled".
        <fieldset className="min-w-0" aria-describedby={describedBy('outcome')}>
          <legend className="text-sm font-medium">What happened</legend>
          <div className="mt-1 flex flex-col">
            {OUTCOMES.map((outcome, index) => (
              <label
                key={outcome}
                htmlFor={index === 0 ? id('outcome') : `${id('outcome')}-${outcome}`}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 text-sm has-[:focus-visible]:bg-muted"
              >
                <input
                  // The first radio carries the field's id: a failed check takes focus to it.
                  id={index === 0 ? id('outcome') : `${id('outcome')}-${outcome}`}
                  type="radio"
                  name={id('outcome')}
                  className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  checked={values.outcome === outcome}
                  aria-disabled={waiting}
                  onChange={() => {
                    if (!pending) onChange('outcome', outcome);
                  }}
                />
                {HAPPENED[outcome]}
              </label>
            ))}
          </div>
          <p id={helpId('outcome')} className={HELP}>
            {OUTCOME_HELP}
          </p>
          {errorOf('outcome')}
        </fieldset>
      ) : null}

      <div className={FIELD}>
        <Label htmlFor={id('place')}>{placeLabel(values.kind)}</Label>
        <Input
          id={id('place')}
          className={FIELD_HEIGHT}
          value={values.place}
          autoComplete="off"
          aria-invalid={invalid('place')}
          aria-describedby={describedBy('place')}
          onChange={(event) => onChange('place', event.target.value)}
        />
        <p id={helpId('place')} className={HELP}>
          {placeHelper(mode)}
        </p>
        {errorOf('place')}
      </div>
      <div className={FIELD}>
        <Label htmlFor={id('interviewer_name')}>Interviewer</Label>
        <Input
          id={id('interviewer_name')}
          className={FIELD_HEIGHT}
          value={values.interviewer_name}
          // Someone else's name: the browser must not offer the recruiter's own.
          autoComplete="off"
          aria-invalid={invalid('interviewer_name')}
          aria-describedby={describedBy('interviewer_name')}
          onChange={(event) => onChange('interviewer_name', event.target.value)}
        />
        <p id={helpId('interviewer_name')} className={HELP}>
          {INTERVIEWER_HELP}
        </p>
        {errorOf('interviewer_name')}
      </div>
      <div className={FIELD}>
        <Label htmlFor={id('notes')}>Notes</Label>
        <Textarea
          id={id('notes')}
          rows={3}
          className="min-h-20"
          value={values.notes}
          aria-invalid={invalid('notes')}
          aria-describedby={describedBy('notes')}
          onChange={(event) => onChange('notes', event.target.value)}
        />
        <p id={helpId('notes')} className={HELP}>
          {NOTES_HELP}
        </p>
        {errorOf('notes')}
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
          {submitLabel(mode, pending)}
        </Button>
      </div>
    </form>
  );
}

// ─── the form, with what is typed ────────────────────────────────────────────

type Send = Exclude<Submission, { kind: 'nothing' }>;

/**
 * The form's state. Mounted afresh each time the dialog opens. It is checked
 * when it is submitted, and from then on as it is corrected, so an error goes
 * as soon as it is put right.
 */
function InterviewForm({
  mode, fixed, stored, picker, today, clock, pending, refusal, onDirtyChange, onClearRefusal, onPick, onCancel, onSend, onLoadCurrent,
}: {
  /** Given once the current details were read after a "changed a moment ago" refusal. */
  onLoadCurrent?: () => void;
  /** The time now, by the server's clock. Only ever called from a handler. */
  clock: () => Date;
  mode: InterviewFormMode;
  /** The application a card or a panel fixed. Null from the header (it is picked) and when changing (the row has it). */
  fixed: { id: string; name: string; job: string } | null;
  /** The row being changed, as it was when the form opened. */
  stored: InterviewRow | null;
  picker: { applications: PickerApplication[]; cut: boolean };
  today: string;
  pending: boolean;
  refusal: Refusal | null;
  onDirtyChange: (dirty: boolean) => void;
  onClearRefusal: () => void;
  /** The application chosen in the picker changed: the dialog's description names its job. */
  onPick: (applicationId: string) => void;
  onCancel: () => void;
  onSend: (plan: Send) => void;
}) {
  const base = useId();
  const picking = fixed === null && stored === null;
  const [initial] = useState<InterviewFormValues>(() => (stored ? valuesFrom(stored) : emptyValues()));
  const [values, setValues] = useState<InterviewFormValues>(initial);
  const [query, setQuery] = useState('');
  const [problems, setProblems] = useState<InterviewProblems>({});
  /** True once a submit was refused by the form's own checks: from then on they run as the form is corrected. */
  const [checked, setChecked] = useState(false);
  const [unchanged, setUnchanged] = useState(false);

  /** Only ever called from a handler: it reads the clock. */
  const check = (next: InterviewFormValues) =>
    interviewProblems(next, clock(), { mode, picking, stored: stored ? initial : undefined });

  // Focus starts in the first field: "Find an application" from the header, "Date" otherwise.
  useEffect(() => {
    const first = focusIdAfter({ after: 'open', picking }, base);
    if (first) document.getElementById(first)?.focus();
  }, [base, picking]);
  // A refusal takes focus: to the field it is about, else to the alert at the top of the form.
  useEffect(() => {
    if (!refusal) return;
    const target = focusIdAfter({ after: 'refusal', word: refusal.word }, base);
    if (target) document.getElementById(target)?.focus();
  }, [refusal, base]);

  function apply(next: InterviewFormValues) {
    setValues(next);
    setUnchanged(false);
    onDirtyChange(isDirty(initial, next));
    if (checked) setProblems(check(next));
    // The refusal was about what was sent; once that changes it no longer applies.
    if (refusal) onClearRefusal();
  }

  const change = <K extends InterviewField>(field: K, value: InterviewFormValues[K]) => {
    apply({ ...values, [field]: value });
    if (field === 'application_id') onPick(String(value));
  };

  function search(text: string) {
    setQuery(text);
    // A chosen application the narrowed list no longer shows is no longer chosen: the select could not show it.
    const kept = keptChoice(pickerOptions(picker.applications, text, mode).options, values.application_id);
    if (kept !== values.application_id) change('application_id', kept);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit(pending)) return;
    const found = check(values);
    setChecked(true);
    setProblems(found);
    const wrong = focusIdAfter({ after: 'check', problems: found }, base);
    if (wrong) {
      document.getElementById(wrong)?.focus();
      return;
    }
    const plan = submission(mode, values, { applicationId: fixed?.id ?? values.application_id, stored });
    if (plan.kind === 'nothing') {
      // Nothing differs from what is stored: nothing is sent, and the form says so.
      setUnchanged(true);
      return;
    }
    onSend(plan);
  }

  return (
    <InterviewFormView
      base={base}
      mode={mode}
      fixed={fixed ?? (stored ? { name: stored.name, job: stored.role } : null)}
      picker={picker}
      query={query}
      values={values}
      problems={problems}
      refusal={refusal}
      unchanged={unchanged}
      pending={pending}
      today={today}
      storedDuration={stored ? stored.durationMinutes : null}
      onQuery={search}
      onChange={change}
      onSubmit={submit}
      onCancel={onCancel}
      onLoadCurrent={onLoadCurrent}
    />
  );
}

// ─── the invitation step ─────────────────────────────────────────────────────

type MoveState = { state: 'idle' } | { state: 'moving' } | { state: 'moved' } | { state: 'refused'; error: string };

/**
 * What the recruiter takes away after scheduling or changing an interview, or
 * from a row's "Invitation and calendar file": the invitation to copy, the
 * calendar file to download, and (after a schedule or a change, when the
 * application is at Applied or Screening) "Move to Interview". Nothing here
 * sends anything to the candidate.
 *
 * The text area is read-only and selectable: when the browser refuses the
 * clipboard, the text can still be selected and copied by hand.
 */
export function InvitationStep({
  text, file, moveFor, onDone, onBusy,
}: {
  /** The invitation, as the server wrote it. Null: there is none, and nothing is drawn in its place. */
  text: string | null;
  /**
   * The calendar file, as the server made it from the stored interview: its name and its content. It is saved as it
   * is; nothing here builds a file. Null: no file is offered, and nothing is drawn in its place.
   */
  file: CalendarFile | null;
  /** The application to move to Interview, or null when the move is not offered. */
  moveFor: string | null;
  onDone: () => void;
  /** Told true while the move is being saved, so the dialog lets Escape and a click outside do nothing meanwhile. */
  onBusy?: (busy: boolean) => void;
}) {
  const base = useId();
  const router = useRouter();
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const [move, setMove] = useState<MoveState>({ state: 'idle' });
  const [, start] = useTransition();
  /** True from the press until the answer. */
  const inFlight = useRef(false);
  const doneButton = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);
  const moving = move.state === 'moving';

  // Focus goes to "Copy invitation": the step replaced the form, or opened on its own.
  useEffect(() => {
    const first = focusIdAfter({ after: 'saved' }, base);
    if (first) document.getElementById(first)?.focus();
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [base]);
  // The move button has gone (moved, or refused): focus must not be left on nothing.
  useEffect(() => {
    if (move.state !== 'moved' && move.state !== 'refused') return;
    const active = document.activeElement;
    if (!active || active === document.body) doneButton.current?.focus();
  }, [move.state]);

  function onCopy() {
    if (!text) return;
    // Called straight from the press: some browsers allow the clipboard only then.
    void copyText(text).then((ok) => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      setCopied(ok ? 'yes' : 'failed');
      // "Copied" goes back to "Copy invitation" after a few seconds. The failure stays: it tells them what to do.
      if (ok) timer.current = window.setTimeout(() => setCopied('no'), 4000);
    });
  }


  function onDownload() {
    // The content the server made, saved as it is.
    if (file) downloadTextFile(file.name, ICS_MIME, file.content);
  }

  function onMove() {
    if (!moveFor || inFlight.current || move.state !== 'idle') return;
    inFlight.current = true;
    setMove({ state: 'moving' });
    onBusy?.(true);
    start(async () => {
      try {
        const result = moveResult(await moveApplicationAction(moveInput(moveFor)));
        if (result.ok) {
          setMove({ state: 'moved' });
        } else {
          // Shown in the button's place. Someone else moved or closed the application: fetch the screen again.
          setMove({ state: 'refused', error: result.error });
          router.refresh();
        }
      } catch {
        setMove({ state: 'refused', error: INTERVIEW_SAVE_FAILED });
        router.refresh();
      } finally {
        inFlight.current = false;
        onBusy?.(false);
      }
    });
  }

  return (
    <div className="space-y-4">
      {text ? (
        <div className={FIELD}>
          <Label htmlFor={`${base}-text`}>Invitation</Label>
          <Textarea
            id={`${base}-text`}
            readOnly
            rows={12}
            value={text}
            // A long link wraps inside the box instead of widening the dialog.
            className="min-h-48 whitespace-pre-wrap break-words text-sm"
          />
        </div>
      ) : null}

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {text ? (
            <Button id={fieldId(base, 'copy')} type="button" size="sm" className={TARGET} onClick={onCopy}>
              {copyLabel(copied === 'yes')}
            </Button>
          ) : null}
          {file ? (
            <Button type="button" variant="outline" size="sm" className={TARGET} onClick={onDownload}>
              {DOWNLOAD_LABEL}
            </Button>
          ) : null}
        </div>
        {/* Always in the page, so "Copied" and the failure are read out. It takes a line only for the failure: the button itself shows "Copied". */}
        <p aria-live="polite" className={cn('text-sm break-words text-muted-foreground', copied !== 'failed' && 'sr-only')}>
          {copied === 'yes' ? copyLabel(true) : copied === 'failed' ? COPY_FAILED : ''}
        </p>
        {file ? <p className={HELP}>{DOWNLOAD_HELP}</p> : null}
      </div>

      {moveFor ? (
        <div className="space-y-1.5 border-t pt-3">
          {move.state === 'idle' || move.state === 'moving' ? (
            <Button type="button" variant="outline" size="sm" className={cn(TARGET, WAITING)} aria-disabled={moving || undefined} onClick={onMove}>
              {moveLabel(moving)}
            </Button>
          ) : null}
          {move.state === 'refused' ? (
            <p role="alert" className={cn(ALERT_CLASS, 'break-words')}>
              {move.error}
            </p>
          ) : null}
          {/* Always in the page, so "Moved to Interview." is read out when it replaces the button. */}
          <p aria-live="polite" className={cn('text-sm text-muted-foreground', move.state !== 'moved' && 'sr-only')}>
            {move.state === 'moved' ? MOVED : ''}
          </p>
        </div>
      ) : null}

      <div className="flex justify-end pt-1">
        <Button
          ref={doneButton}
          type="button"
          variant="outline"
          size="sm"
          className={cn(TARGET, WAITING)}
          aria-disabled={moving || undefined}
          onClick={() => {
            if (!moving) onDone();
          }}
        >
          {DONE}
        </Button>
      </div>
    </div>
  );
}

// ─── the screen's one dialog ─────────────────────────────────────────────────

const NO_PICKER: { applications: PickerApplication[]; cut: boolean } = { applications: [], cut: false };

/**
 * The interview dialog of a screen: closed until `openInterview` is called.
 * Drawn once a screen, only for someone who may edit; every action checks
 * again. `today` is today in Kuala Lumpur, from the server; `picker` is given on the Interviews screen only.
 *
 * It holds while a change is being saved: Escape, Cancel and a click outside
 * do nothing. After a schedule or a change it does not close: it becomes the
 * invitation step. After a past interview is recorded it closes. The success
 * sentence goes to the screen's notice line either way.
 */
export function InterviewDialogHost({
  today, picker = NO_PICKER, serverNow,
}: {
  /** The instant the server drew the screen with: the form's checks tell the time from it. */
  serverNow?: string;
  today: string;
  picker?: { applications: PickerApplication[]; cut: boolean };
}) {
  const req = useSyncExternalStore(subscribe, () => request, () => null);
  const router = useRouter();
  const clock = useServerClock(serverNow);
  const [pending, start] = useTransition();
  /** True from the press until the answer: `pending` only turns true on the next render. */
  const inFlight = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  /** The saved change whose invitation is showing, or null while the form is. */
  const [saved, setSaved] = useState<InterviewChange | null>(null);
  const [moving, setMoving] = useState(false);
  const [pickedId, setPickedId] = useState('');
  /** The interview as it is stored now, read after a save was refused because someone else had changed it. */
  const [fresh, setFresh] = useState<InterviewRow | null>(null);
  const [formKey, setFormKey] = useState(0);
  /** The opener's id, kept for the moment after the request is cleared, when focus is given back. */
  const opener = useRef<string | null>(null);

  useEffect(() => {
    if (req) opener.current = req.focusId;
  }, [req]);
  // The dialog belongs to the screen it was opened on: leaving the screen closes it.
  useEffect(() => () => {
    request = null;
  }, []);

  const mode: InterviewFormMode = req?.mode ?? 'schedule';
  const row = req?.mode === 'change' ? req.row : null;
  const application = req && req.mode !== 'change' ? req.application : null;
  const picked = !row && !application ? picker.applications.find((a) => a.id === pickedId) ?? null : null;
  const name = row?.name ?? application?.name ?? null;
  const job = row?.role ?? application?.job ?? picked?.job ?? null;

  function close() {
    setDirty(false);
    setRefusal(null);
    setFresh(null);
    setSaved(null);
    setMoving(false);
    setPickedId('');
    closeInterview();
  }

  /** "Load the current details": the form is drawn again from the interview as it is now. What was typed is discarded, by choice. */
  function loadCurrent() {
    if (!fresh || !req || req.mode !== 'change' || pending || inFlight.current) return;
    setRefusal(null);
    setDirty(false);
    setFresh(null);
    setFormKey((key) => key + 1);
    // The request now holds the current row: its `updatedAt` is the next save's `seen`.
    openInterview({ mode: 'change', row: fresh, focusId: req.focusId });
  }

  function save(plan: Send) {
    if (pending || inFlight.current) return;
    inFlight.current = true;
    // Cleared first, so the same refusal twice in a row is announced twice.
    setRefusal(null);
    setFresh(null);
    start(async () => {
      try {
        const answer = plan.kind === 'schedule'
          ? await scheduleInterviewAction(plan.input)
          : plan.kind === 'past'
            ? await recordPastInterviewAction(plan.input)
            : await rescheduleInterviewAction(plan.input, plan.seen);
        const result = interviewResult(answer);
        if (!result.ok) {
          const word = refusalWord(result.error, onOf(mode));
          setRefusal({ text: result.error, word });
          // Out of date, or not known to have failed: the fresh screen shows what is true.
          if (refreshAfter(word)) router.refresh();
          if (word === 'changed' && plan.kind === 'change' && row) {
            // Someone else changed it. Its current details are read, so the person can choose to load them: nothing is
            // sent again by itself, and what they typed stays in the form until they choose.
            try {
              const current = currentResult(await getInterviewForEditAction({ id: row.id }), row.id);
              if (current.ok) setFresh(rowWithCurrent(row, current.current));
              // Gone, or no longer scheduled: that is what is true now, and there is nothing to load.
              else setRefusal({ text: current.error, word: refusalWord(current.error, 'interview') });
            } catch {
              // The refusal stands as it was said; closing and opening the form again still works.
            }
          }
          return;
        }
        // The screen's notice line: read out now, and still there when the dialog has closed.
        announceDeletion(noticeOf(result.change));
        setDirty(false);
        // The server decides whether there is an invitation, by its own clock: none for a start that had already
        // passed when it was saved (a new interview may start up to five minutes ago). Then the interview is saved, the
        // notice says so, and the dialog closes with no invitation step and no error.
        if (stepAfter(mode, result.change) === 'invitation') setSaved(result.change);
        else close();
      } catch {
        // The answer was lost. The change may have been saved: say so and fetch the screen again.
        setRefusal({ text: INTERVIEW_SAVE_FAILED, word: null });
        router.refresh();
      } finally {
        inFlight.current = false;
      }
    });
  }

  return (
    <FormDialog
      open={req !== null}
      title={saved ? inviteTitle(mode === 'change' ? 'change' : 'schedule') : dialogTitle(mode, name)}
      description={saved ? inviteLead(saved.candidate) : dialogDescription(mode, job)}
      discardTitle={discardTitle(mode)}
      dirty={dirty && saved === null}
      pending={pending || moving}
      onClose={close}
      returnFocus={() => {
        // By id: a board card that moved columns is a new element with the same id. Gone altogether: the notice line.
        const target = (opener.current ? document.getElementById(opener.current) : null) ?? document.getElementById(DELETION_NOTICE_ID);
        target?.focus();
      }}
    >
      {(requestClose) =>
        saved ? (
          <InvitationStep
            text={saved.invitation || null}
            file={calendarOf(saved)}
            moveFor={offersMove(saved) ? saved.application_id : null}
            onDone={requestClose}
            onBusy={setMoving}
          />
        ) : req ? (
          <InterviewForm
            // A new form when the current details are loaded: it starts at them, as a form opened afresh does.
            key={formKey}
            mode={mode}
            fixed={application}
            stored={row}
            picker={picker}
            today={today}
            clock={clock}
            pending={pending}
            refusal={refusal}
            onDirtyChange={setDirty}
            onClearRefusal={() => setRefusal(null)}
            onPick={setPickedId}
            onCancel={requestClose}
            onSend={save}
            onLoadCurrent={fresh ? loadCurrent : undefined}
          />
        ) : null
      }
    </FormDialog>
  );
}
