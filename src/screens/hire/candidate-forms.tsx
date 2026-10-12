'use client';

import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from 'react';
import { AlertDialog, Dialog } from 'radix-ui';
import { Plus } from 'lucide-react';
import {
  addCandidateAction,
  getCandidateAction,
  updateCandidateAction,
  type CandidateForEdit,
} from '@/app/(app)/hire/actions';
import {
  APPLY_MESSAGES,
  CV_FILE_FIELD,
  chosenFile,
  cvFileProblem,
  fileSizeLabel,
  type CvFileInfo,
} from '@/lib/hire/application-fields';
import {
  CANDIDATE_LIMITS,
  CV_UPLOADS_REFUSED,
  EMPTY_CANDIDATE_FORM,
  candidateMessage,
  candidateProblems,
  parseSkills,
  type CandidateFormValues,
} from '@/lib/hire/candidate-fields';
import { cn } from '@/lib/utils';
import { SELECT_CLASS } from '@/screens/crm/crm-form';
import { claimResult, useNewest } from '@/screens/hire/delete-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * The two forms for a candidate entered by hand: Add Candidate (on the board's
 * header) and Edit candidate (from a board card's menu and the Applications
 * details panel). Both follow the job form in jobs-table.tsx.
 *
 * Contact details: the Add form holds only what is typed into it. The Edit form
 * is given an id and a name; the email and the phone are fetched by
 * `getCandidateAction` when the form opens, kept in this component's state, and
 * gone when it closes. Nothing on the server puts them in a list's props.
 */

type Field = keyof CandidateFormValues;
/** Everything that can be wrong: one of the fields, or the chosen file. */
type ProblemKey = Field | typeof CV_FILE_FIELD;
type Problems = Partial<Record<ProblemKey, string>>;
/** The fields that changed, as `updateCandidateAction` takes them. */
export type CandidateChanges = { id: string } & Partial<{
  name: string; email: string; phone: string; headline: string; location: string; skills: string[]; source: string;
}>;

const NOT_SENT = 'That change could not be sent. Check your connection and try again.';
const NOT_LOADED = "This candidate's details could not be loaded. Check your connection and try again.";
const NOTHING_CHANGED = 'Nothing was changed.';
const NO_EMAIL = "Without an email, this person can't be matched if they apply online later.";
/**
 * Under the job select while no job is picked. Someone added without a job has no application, so they are not on
 * the board: they go into the talent pool as Available, and the hint says so.
 */
const NO_JOB_HINT =
  'This person will go to the talent pool as Available. They will not appear on the board until they are added to a job. '
  + 'A CV can be added once the candidate is put forward for a job.';

/** The seven details of the person, in the order both forms show them. */
const PERSON_FIELDS = ['name', 'email', 'phone', 'headline', 'location', 'skills', 'source'] as const satisfies readonly Field[];
/** Everything the Add form can show as wrong, in the order it shows it. */
const ADD_ORDER: readonly ProblemKey[] = [...PERSON_FIELDS, 'job_id', 'cover_letter', 'cv_url', CV_FILE_FIELD];
const FIELD_KEYS = Object.keys(EMPTY_CANDIDATE_FORM) as Field[];

/** The field each of the server's refusals is about. Any other refusal is about none and goes in the alert box. */
const SERVER_ERROR_FIELD: Record<string, ProblemKey> = {
  [candidateMessage('invalid_name')]: 'name',
  [candidateMessage('invalid_email')]: 'email',
  [candidateMessage('email_taken')]: 'email',
  [candidateMessage('job_not_found')]: 'job_id',
  [candidateMessage('job_not_open')]: 'job_id',
  [candidateMessage('invalid_url')]: 'cv_url',
  [APPLY_MESSAGES.cvFileType]: CV_FILE_FIELD,
  // Said at the file, where it can be removed and the form sent again.
  [CV_UPLOADS_REFUSED]: CV_FILE_FIELD,
};
/** "This file is 7.2 MB. Choose one under 5 MB.": the size is the server's to say. */
const TOO_BIG = /^This file is .+\. Choose one under 5 MB\.$/;

/**
 * The field a refused save takes focus to: the first wrong one in the order the form shows its
 * fields, whatever order the checks found them in. Null when nothing the form shows is wrong.
 */
export function firstWrongField(mode: 'add' | 'edit', problems: Problems): ProblemKey | null {
  const order: readonly ProblemKey[] = mode === 'add' ? ADD_ORDER : PERSON_FIELDS;
  return order.find((key) => problems[key]) ?? null;
}

/**
 * The CV file in a form's own post, as the form is about to send it: what the file says of itself,
 * or null when there is none. The post is the truth about the file, and it is sent as it stands, so
 * the file travels in it. An untouched file input stands in a form as an empty, nameless file, and
 * with no job there is no application to hold one: both are no file, and are taken out of the post.
 */
export function postedCv(post: FormData, hasJob: boolean): CvFileInfo | null {
  const file = hasJob ? chosenFile(post.get(CV_FILE_FIELD)) : null;
  if (!file) post.delete(CV_FILE_FIELD);
  return file;
}

function fieldForServerError(message: string, shown: readonly ProblemKey[]): ProblemKey | null {
  const field = Object.hasOwn(SERVER_ERROR_FIELD, message) ? SERVER_ERROR_FIELD[message] : TOO_BIG.test(message) ? CV_FILE_FIELD : null;
  return field && shown.includes(field) ? field : null;
}

// The dialog look of the app's other forms (see jobs-table.tsx).
const OVERLAY_CLASS = 'fixed inset-0 z-50 bg-black/40';
const CONTENT_CLASS =
  'fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-background p-5 shadow-lg outline-none max-h-[85vh] overflow-y-auto';
const ALERT_CLASS = 'rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive';
/** 44 pixels of hit area on every button and field. */
const TARGET = 'min-h-11 min-w-11';
const FIELD_HEIGHT = 'h-11';
/** A control that is waiting stays focusable and says so; its presses are ignored in the handlers. */
const WAITING = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:active:translate-y-0';
const HELP = 'text-xs text-muted-foreground';

/**
 * The dialog both forms sit in: a title, the form, and "discard?" before a
 * form with something typed is closed. There is no Radix trigger, so focus is
 * given back by `returnFocus` when it closes.
 */
function FormDialog({
  open,
  title,
  description,
  discardTitle,
  dirty,
  pending,
  onClose,
  returnFocus,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  discardTitle: string;
  /** Whether closing would lose something typed. */
  dirty: boolean;
  pending: boolean;
  onClose: () => void;
  returnFocus: () => void;
  /** Given the function Cancel calls: the same as Escape and a click outside. */
  children: (requestClose: () => void) => ReactNode;
}) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  /** The form field that last had focus, for coming back from the discard question. */
  const lastField = useRef<HTMLElement | null>(null);

  function close() {
    setConfirmingDiscard(false);
    onClose();
  }

  /** Cancel, Escape and a click outside all come here. Ignored while the form is being saved. */
  function requestClose() {
    if (pending) return;
    if (dirty) setConfirmingDiscard(true);
    else close();
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY_CLASS} />
        <Dialog.Content
          ref={content}
          className={cn(CONTENT_CLASS, 'max-w-lg')}
          onFocus={(event) => {
            if (event.target.matches('input, select, textarea')) lastField.current = event.target;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus();
          }}
        >
          <Dialog.Title className="text-base font-semibold break-words">{title}</Dialog.Title>
          <Dialog.Description className="mb-4 text-sm text-muted-foreground">{description}</Dialog.Description>
          {open ? children(requestClose) : null}

          <AlertDialog.Root open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
            <AlertDialog.Portal>
              <AlertDialog.Overlay className={OVERLAY_CLASS} />
              <AlertDialog.Content
                className={cn(CONTENT_CLASS, 'max-w-sm')}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  // "Keep editing" goes back into the form. After Discard the form has gone too, and the
                  // form's own close returns focus to what opened it.
                  const field = lastField.current?.isConnected
                    ? lastField.current
                    : content.current?.querySelector<HTMLElement>('input');
                  field?.focus();
                }}
              >
                <AlertDialog.Title className="text-base font-semibold">{discardTitle}</AlertDialog.Title>
                <AlertDialog.Description className="mt-1 text-sm text-muted-foreground">
                  What you typed has not been saved.
                </AlertDialog.Description>
                <div className="mt-5 flex items-center justify-between gap-6">
                  <AlertDialog.Cancel asChild>
                    <Button type="button" variant="outline" size="sm" className={TARGET} autoFocus>
                      Keep editing
                    </Button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild>
                    <Button type="button" variant="destructive" size="sm" className={TARGET} onClick={close}>
                      Discard
                    </Button>
                  </AlertDialog.Action>
                </div>
              </AlertDialog.Content>
            </AlertDialog.Portal>
          </AlertDialog.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type FormShell = {
  pending: boolean;
  /** A refusal from the server: shown under the field it is about, or in the box above the buttons when it is about none. */
  error: string | null;
  onDirtyChange: (dirty: boolean) => void;
  onClearError: () => void;
  onCancel: () => void;
};

/**
 * The fields of both forms. `mode` decides what is asked: the Add form has the
 * job and, once one is picked, what goes with the application; the Edit form
 * has the person's seven details only.
 */
function CandidateForm({
  mode,
  jobs,
  initial,
  pending,
  error,
  onDirtyChange,
  onClearError,
  onCancel,
  onSend,
}: FormShell & {
  mode: 'add' | 'edit';
  jobs: { id: string; title: string }[];
  initial: CandidateFormValues;
  /** The form passed its own checks: the values, the form's own post (file included) and the chosen file. */
  onSend: (values: CandidateFormValues, post: FormData) => void;
}) {
  const adding = mode === 'add';
  const order: readonly ProblemKey[] = adding ? ADD_ORDER : PERSON_FIELDS;
  const [values, setValues] = useState<CandidateFormValues>(initial);
  const [errors, setErrors] = useState<Problems>({});
  const [touched, setTouched] = useState<ReadonlySet<ProblemKey>>(() => new Set());
  /** The file in the CV input, as far as the script has seen: its name and size are shown from here. */
  const [picked, setPicked] = useState<CvFileInfo | null>(null);
  const serverError = useRef<HTMLParagraphElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  /** Set when a press starts on Cancel: some browsers do not focus a clicked button, so the blur names no target. */
  const cancelling = useRef(false);
  const base = useId();
  const id = (field: ProblemKey) => `${base}-${field}`;
  /** The control of a field, found by its id: a failed save focuses the first one that is wrong. */
  const controlOf = (field: ProblemKey) => document.getElementById(id(field));
  const hasJob = adding && values.job_id !== '';
  /** The field the server's refusal is about, if it is about one this form shows. */
  const shownKeys = hasJob ? order : order.filter((key) => key !== 'cover_letter' && key !== 'cv_url' && key !== CV_FILE_FIELD);
  const serverField = error ? fieldForServerError(error, shownKeys) : null;

  // A refusal about a field takes focus to that field. Any other one is shown just above the buttons.
  useEffect(() => {
    if (!error) return;
    if (serverField) document.getElementById(`${base}-${serverField}`)?.focus();
    else serverError.current?.scrollIntoView({ block: 'nearest' });
  }, [error, serverField, base]);

  /** What is wrong, by field. What goes with an application is only checked while a job is picked. */
  function problemsOf(next: CandidateFormValues, file: CvFileInfo | null): Problems {
    const withJob = adding && next.job_id !== '';
    const found: Problems = candidateProblems(withJob ? next : { ...next, cover_letter: '', cv_url: '' }, !adding);
    const fileProblem = withJob ? cvFileProblem(file) : null;
    if (fileProblem) found[CV_FILE_FIELD] = fileProblem;
    return found;
  }

  const isDirty = (next: CandidateFormValues, file: CvFileInfo | null) =>
    file !== null || FIELD_KEYS.some((key) => next[key] !== initial[key]);

  function set(field: Field, value: string) {
    const next = { ...values, [field]: value };
    // With no job the application's fields leave the form, and a chosen file goes with its input.
    const file = adding && next.job_id === '' ? null : picked;
    setValues(next);
    if (file !== picked) {
      setPicked(file);
      setErrors((prev) => {
        const rest = { ...prev };
        delete rest[CV_FILE_FIELD];
        return rest;
      });
    }
    onDirtyChange(isDirty(next, file));
    // The refusal was about what was sent; once that changes it no longer applies.
    if (serverField) onClearError();
  }

  /** A field is checked when the user leaves it, not on every keystroke. */
  function blur(field: Field, event: React.FocusEvent<HTMLElement>) {
    // Not when focus is leaving for Cancel or out of the form: the form is closing, and an error
    // appearing under the field would flash and move Cancel from under the pointer.
    const to = event.relatedTarget;
    const leaving =
      cancelling.current || to === cancelButton.current || (to !== null && !form.current?.contains(to));
    cancelling.current = false;
    if (leaving) return;
    setErrors(problemsOf(values, picked));
    setTouched((prev) => new Set(prev).add(field));
  }

  /** Choosing a file checks it at once, by what it says of itself: there is nothing to leave a file input for. */
  function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = chosenFile(input.files?.[0]);
    setPicked(file);
    setErrors(problemsOf(values, file));
    setTouched((prev) => new Set(prev).add(CV_FILE_FIELD));
    onDirtyChange(isDirty(values, file));
    if (serverField) onClearError();
    // Where the browser's file picker leaves focus differs from one browser to the next.
    input.focus();
  }

  /** Empties the file input, which a person cannot do in every browser, and goes back to it. */
  function onRemoveFile() {
    const input = controlOf(CV_FILE_FIELD);
    if (input instanceof HTMLInputElement) input.value = '';
    setPicked(null);
    setErrors(problemsOf(values, null));
    onDirtyChange(isDirty(values, null));
    if (serverField) onClearError();
    // The button is gone with the file: focus must not be left on nothing.
    input?.focus();
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    // The form's own post, so the file travels. The input is the truth about the file.
    const post = new FormData(event.currentTarget);
    const file = postedCv(post, hasJob);
    if (file?.name !== picked?.name || file?.size !== picked?.size) setPicked(file);
    const found = problemsOf(values, file);
    setErrors(found);
    const firstWrong = firstWrongField(mode, found);
    if (firstWrong) {
      setTouched(new Set(order));
      controlOf(firstWrong)?.focus();
      return;
    }
    onSend(values, post);
  }

  const errorId =(field: ProblemKey) => `${base}-${field}-error`;
  const helpId = (field: ProblemKey) => `${base}-${field}-help`;
  /** What is wrong with a field: the server's refusal if it is about this field, else the form's own check once the field was left. */
  const shown = (field: ProblemKey) =>
    serverField === field && error ? error : touched.has(field) ? errors[field] : undefined;
  /** The ids that describe a control: its error first, then whatever help it has. */
  const describedBy = (field: ProblemKey, ...more: (string | false | undefined)[]) =>
    [shown(field) && errorId(field), ...more].filter(Boolean).join(' ') || undefined;
  /** The error under a field, announced when it appears. */
  const errorOf = (field: ProblemKey) =>
    shown(field) ? (
      <p id={errorId(field)} role="alert" className="text-sm break-words text-destructive">
        {shown(field)}
      </p>
    ) : null;
  /** A one-line text field: its label, the input, its help and its error. */
  const textField = (
    field: (typeof PERSON_FIELDS)[number] | 'cv_url',
    label: ReactNode,
    extra: React.ComponentProps<typeof Input> = {},
    help?: string,
    after?: ReactNode,
  ) => (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id(field)}>{label}</Label>
      <Input
        id={id(field)}
        name={field}
        className={FIELD_HEIGHT}
        value={values[field]}
        onChange={(event) => set(field, event.target.value)}
        onBlur={(event) => blur(field, event)}
        // These are someone else's details: the browser must not offer the recruiter's own.
        autoComplete="off"
        aria-invalid={shown(field) ? true : undefined}
        {...extra}
        aria-describedby={describedBy(field, help && helpId(field), extra['aria-describedby'])}
      />
      {help ? (
        <p id={helpId(field)} className={HELP}>
          {help}
        </p>
      ) : null}
      {errorOf(field)}
      {after}
    </div>
  );

  /** Said once the email field has been left empty. Advice, not an error: the form can still be saved. */
  const noEmail = touched.has('email') && values.email.trim() === '' && !shown('email');
  const noteLength = values.cover_letter.trim().length;

  return (
    <form ref={form} className="space-y-4" onSubmit={submit} noValidate>
      <p className={HELP}>* Required</p>

      {textField(
        'name',
        <span>
          Full name <span aria-hidden="true">*</span>
        </span>,
        { 'aria-required': 'true' },
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {textField(
          'email',
          'Email',
          { type: 'email', inputMode: 'email', 'aria-describedby': `${base}-no-email` },
          undefined,
          // Always in the page, so its text is announced when it appears. It takes a line only while there is something to say.
          <p id={`${base}-no-email`} aria-live="polite" className={cn(HELP, !noEmail && 'sr-only')}>
            {noEmail ? NO_EMAIL : null}
          </p>,
        )}
        {textField('phone', 'Phone', { type: 'tel', inputMode: 'tel' })}
      </div>
      {textField('headline', 'Headline', {}, 'For example, Senior Sales Executive at Bintang Packaging')}
      {textField('location', 'Location')}
      {textField('skills', 'Skills', {}, 'Separate with commas')}
      {textField('source', 'Source', { placeholder: 'Added by hand' })}

      {adding ? (
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={id('job_id')}>Job</Label>
          <select
            id={id('job_id')}
            name="job_id"
            className={cn(SELECT_CLASS, FIELD_HEIGHT, 'w-full min-w-0')}
            value={values.job_id}
            onChange={(event) => set('job_id', event.target.value)}
            onBlur={(event) => blur('job_id', event)}
            aria-invalid={shown('job_id') ? true : undefined}
            aria-describedby={describedBy('job_id', !hasJob && helpId('job_id'))}
          >
            <option value="">No job yet</option>
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.title}
              </option>
            ))}
          </select>
          {errorOf('job_id')}
          {hasJob ? null : (
            <p id={helpId('job_id')} className={HELP}>
              {NO_JOB_HINT}
            </p>
          )}
        </div>
      ) : null}

      {hasJob ? (
        // A fieldset is by default as wide as its widest word; a long file name must wrap, not widen the dialog.
        <fieldset className="min-w-0 space-y-4">
          <legend className="mb-2 text-sm font-semibold">For this application</legend>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={id('cover_letter')}>Cover note</Label>
            <Textarea
              id={id('cover_letter')}
              name="cover_letter"
              rows={4}
              className="min-h-28"
              value={values.cover_letter}
              onChange={(event) => set('cover_letter', event.target.value)}
              onBlur={(event) => blur('cover_letter', event)}
              aria-invalid={shown('cover_letter') ? true : undefined}
              aria-describedby={describedBy('cover_letter', helpId('cover_letter'))}
            />
            <p
              id={helpId('cover_letter')}
              className={cn(HELP, 'tabular-nums', noteLength > CANDIDATE_LIMITS.coverLetter && 'font-medium text-destructive')}
            >
              {noteLength.toLocaleString('en-US')} / {CANDIDATE_LIMITS.coverLetter.toLocaleString('en-US')}
              <span className="sr-only"> characters</span>
            </p>
            {errorOf('cover_letter')}
          </div>
          {textField('cv_url', 'CV link', { type: 'url', inputMode: 'url', placeholder: 'https://' })}
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={id(CV_FILE_FIELD)}>CV file</Label>
            <Input
              // The browser's own file input, in plain sight: it takes focus and shows it. Never remounted, so a
              // refused or unsent save keeps the chosen file.
              id={id(CV_FILE_FIELD)}
              name={CV_FILE_FIELD}
              type="file"
              accept="application/pdf,.pdf"
              aria-invalid={shown(CV_FILE_FIELD) ? true : undefined}
              aria-describedby={describedBy(CV_FILE_FIELD, helpId(CV_FILE_FIELD))}
              onChange={onFileChange}
              className={cn(
                FIELD_HEIGHT,
                'cursor-pointer py-1 file:mr-3 file:h-8 file:cursor-pointer file:rounded-md file:border file:border-solid file:border-input file:bg-muted file:px-3',
              )}
            />
            <p id={helpId(CV_FILE_FIELD)} className={HELP}>
              PDF, up to 5 MB
            </p>
            {errorOf(CV_FILE_FIELD)}
            {picked ? (
              <div className="flex items-center gap-3">
                {/* A file name can be one long word: it breaks anywhere rather than push the dialog sideways. */}
                <p className="min-w-0 flex-1 text-sm break-all">
                  {picked.name} <span className="whitespace-nowrap text-muted-foreground">({fileSizeLabel(picked.size)})</span>
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Remove ${picked.name}`}
                  aria-disabled={pending || undefined}
                  onClick={() => {
                    if (!pending) onRemoveFile();
                  }}
                  className={cn(TARGET, WAITING, 'shrink-0')}
                >
                  Remove
                </Button>
              </div>
            ) : null}
          </div>
        </fieldset>
      ) : null}

      {error && !serverField ? (
        <p ref={serverError} role="alert" className={ALERT_CLASS}>
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          ref={cancelButton}
          className={cn(TARGET, WAITING)}
          aria-disabled={pending || undefined}
          onPointerDown={() => {
            cancelling.current = true;
          }}
          // A press that ends, or is dragged off, without a click must not skip the next field check.
          // Mouse only: on touch these fire before the field's blur, which clears the flag itself.
          onPointerUp={(event) => {
            if (event.pointerType === 'mouse') cancelling.current = false;
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse') cancelling.current = false;
          }}
          onPointerCancel={() => {
            cancelling.current = false;
          }}
          onClick={() => {
            cancelling.current = false;
            if (!pending) onCancel();
          }}
        >
          Cancel
        </Button>
        {/* Not disabled while it is saved: it keeps focus, says it is waiting, and `submit` ignores the press. */}
        <Button type="submit" size="sm" className={cn(TARGET, WAITING)} aria-disabled={pending || undefined}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

/** The Add form on its own: what the dialog holds. `onSubmit` is given the form's post, the chosen file included. */
export function AddCandidateForm({
  jobs,
  initialJobId = '',
  onSubmit,
  ...shell
}: FormShell & {
  /** Open and paused jobs, by title. */
  jobs: { id: string; title: string }[];
  initialJobId?: string;
  onSubmit: (post: FormData) => void;
}) {
  const [initial] = useState<CandidateFormValues>(() => ({ ...EMPTY_CANDIDATE_FORM, job_id: initialJobId }));
  return <CandidateForm mode="add" jobs={jobs} initial={initial} onSend={(_values, post) => onSubmit(post)} {...shell} />;
}

const NO_JOBS: { id: string; title: string }[] = [];

/**
 * What an edit sends: the candidate's id and only the fields that differ from what the form opened with.
 *
 * Skills are compared as lists, so a line that reads the same is not a change and no skills are sent.
 * A skill saved with a comma inside it (possible before a skill was refused one) is therefore left
 * whole by an edit of anything else. Once the line itself is changed it is sent as it reads, every
 * comma separating, as the field's help says: "Sales, B2B" becomes two skills. The form shows it as
 * two already, and cannot tell which comma was once part of a skill.
 */
export function candidateChanges(id: string, initial: CandidateFormValues, values: CandidateFormValues): CandidateChanges {
  const changes: CandidateChanges = { id };
  for (const field of ['name', 'email', 'phone', 'headline', 'location', 'source'] as const) {
    // A blank value clears the field (the name cannot be blank: the form's own check stops that).
    if (values[field].trim() !== initial[field].trim()) changes[field] = values[field].trim();
  }
  const skills = parseSkills(values.skills);
  if (JSON.stringify(skills) !== JSON.stringify(parseSkills(initial.skills))) changes.skills = skills;
  return changes;
}

/** Whether an edit has nothing to send: the id is all there is. The dialog then sends nothing and says so. */
export const nothingChanged = (changes: CandidateChanges) => Object.keys(changes).length === 1;

/** The Edit form on its own. `onSubmit` is given the candidate's id and only the fields that changed. */
export function EditCandidateForm({
  initial: stored,
  onSubmit,
  ...shell
}: FormShell & {
  initial: CandidateForEdit;
  onSubmit: (changes: CandidateChanges) => void;
}) {
  const [initial] = useState<CandidateFormValues>(() => ({
    ...EMPTY_CANDIDATE_FORM,
    name: stored.name, email: stored.email, phone: stored.phone, headline: stored.headline,
    location: stored.location, skills: stored.skills, source: stored.source,
  }));

  return (
    <CandidateForm
      mode="edit"
      jobs={NO_JOBS}
      initial={initial}
      onSend={(values) => onSubmit(candidateChanges(stored.id, initial, values))}
      {...shell}
    />
  );
}

/**
 * The board's Add Candidate button, its dialog, and the line that says what
 * the add did. Drawn by the server only for someone who may edit; the action
 * checks again.
 */
export function AddCandidate({ jobs }: { jobs: { id: string; title: string }[] }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The sentence's number among the results said on this screen: it is shown only while it is the newest of them. */
  const [noticeSeq, setNoticeSeq] = useState<number | null>(null);
  const shown = useNewest(noticeSeq) ? notice : null;
  const button = useRef<HTMLButtonElement>(null);
  /** True from the press until the answer: `pending` only turns true on the next render. */
  const inFlight = useRef(false);

  function close() {
    setOpen(false);
    setDirty(false);
    setError(null);
  }

  function save(post: FormData) {
    if (pending || inFlight.current) return;
    inFlight.current = true;
    // Cleared first, so the same message twice in a row is announced twice.
    setNotice(null);
    setError(null);
    start(async () => {
      try {
        const result = await addCandidateAction(post);
        if (result.ok) {
          close();
          setNotice(result.data.message);
          // The newest result on the screen: an older sentence on the notice line or a card empties, and this one
          // empties when a later change is said elsewhere.
          setNoticeSeq(claimResult());
        } else {
          setError(result.error);
        }
      } catch {
        // Nothing is cleared: what was typed, and the chosen file, are still in the form to send again.
        setError(NOT_SENT);
      } finally {
        inFlight.current = false;
      }
    });
  }

  return (
    <>
      <Button
        ref={button}
        type="button"
        size="sm"
        className={TARGET}
        onClick={() => {
          setNotice(null);
          setError(null);
          setDirty(false);
          setOpen(true);
        }}
      >
        <Plus className="size-4" aria-hidden />
        Add Candidate
      </Button>
      {/* Always in the page, so its text is announced when it changes. It takes a line of the header only while there is something to say. */}
      <p
        aria-live="polite"
        className={cn('order-last max-w-sm basis-full text-sm break-words text-muted-foreground', !shown && 'sr-only')}
      >
        {shown}
      </p>
      <FormDialog
        open={open}
        title="Add a candidate"
        description="Add someone by hand, with or without a job to put them forward for."
        discardTitle="Discard this candidate?"
        dirty={dirty}
        pending={pending}
        onClose={close}
        returnFocus={() => button.current?.focus()}
      >
        {(requestClose) => (
          <AddCandidateForm
            jobs={jobs}
            pending={pending}
            error={error}
            onDirtyChange={setDirty}
            onClearError={() => setError(null)}
            onCancel={requestClose}
            onSubmit={save}
          />
        )}
      </FormDialog>
    </>
  );
}

type Loaded = { status: 'loading' } | { status: 'failed'; error: string } | { status: 'ready'; candidate: CandidateForEdit };

/**
 * What the Edit dialog holds. Mounted when the dialog opens and gone when it
 * closes, so every opening asks the server for the details afresh and nothing
 * is kept once it is shut.
 */
function EditCandidateBody({
  id,
  onClose,
  onSubmit,
  ...shell
}: FormShell & {
  id: string;
  /** Close without asking: there is nothing typed while loading or after a failure. */
  onClose: () => void;
  onSubmit: (changes: CandidateChanges) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    getCandidateAction(id).then(
      (result) => {
        if (current) setLoaded(result.ok ? { status: 'ready', candidate: result.data } : { status: 'failed', error: result.error });
      },
      () => {
        if (current) setLoaded({ status: 'failed', error: NOT_LOADED });
      },
    );
    return () => {
      current = false;
    };
  }, [id]);

  // While loading there was nothing in the dialog to focus, so it took focus itself. Once the form is
  // there, focus goes to its first field, unless the person has already put it somewhere.
  useEffect(() => {
    if (loaded.status !== 'ready') return;
    const active = document.activeElement;
    if (!active || active === document.body || active.getAttribute('role') === 'dialog') {
      holder.current?.querySelector<HTMLElement>('input')?.focus();
    }
  }, [loaded.status]);

  if (loaded.status === 'ready') {
    return (
      <div ref={holder}>
        <EditCandidateForm initial={loaded.candidate} onSubmit={onSubmit} {...shell} />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {loaded.status === 'loading' ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading…
        </p>
      ) : (
        <p role="alert" className={ALERT_CLASS}>
          {loaded.error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" className={TARGET} onClick={onClose} autoFocus={loaded.status === 'failed'}>
          Close
        </Button>
      </div>
    </div>
  );
}

/**
 * The Edit candidate dialog. The caller owns the button or menu item that opens
 * it, says where focus goes back to, and announces `onSaved`'s sentence. It is
 * given the candidate's id and name only: the rest is fetched when it opens.
 */
export function EditCandidateDialog({
  candidate,
  open,
  onClose,
  onSaved,
  returnFocus,
}: {
  candidate: { id: string; name: string };
  open: boolean;
  onClose: () => void;
  /** The form was saved and has closed: the sentence to announce. */
  onSaved: (notice: string) => void;
  returnFocus: () => void;
}) {
  const [pending, start] = useTransition();
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  function close() {
    setDirty(false);
    setError(null);
    onClose();
  }

  function save(changes: CandidateChanges) {
    if (pending || inFlight.current) return;
    // Nothing differs from what is stored: nothing is sent, and nothing is said to have been saved.
    if (nothingChanged(changes)) {
      close();
      onSaved(NOTHING_CHANGED);
      return;
    }
    inFlight.current = true;
    setError(null);
    start(async () => {
      try {
        const result = await updateCandidateAction(changes);
        if (result.ok) {
          close();
          onSaved('Changes saved.');
        } else {
          setError(result.error);
        }
      } catch {
        setError(NOT_SENT);
      } finally {
        inFlight.current = false;
      }
    });
  }

  return (
    <FormDialog
      open={open}
      title={`Edit ${candidate.name}`}
      description="Update this person’s details."
      discardTitle="Discard your changes?"
      dirty={dirty}
      pending={pending}
      onClose={close}
      returnFocus={returnFocus}
    >
      {(requestClose) => (
        <EditCandidateBody
          id={candidate.id}
          pending={pending}
          error={error}
          onDirtyChange={setDirty}
          onClearError={() => setError(null)}
          onCancel={requestClose}
          onClose={close}
          onSubmit={save}
        />
      )}
    </FormDialog>
  );
}
