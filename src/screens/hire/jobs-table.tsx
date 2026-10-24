'use client';

import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { AlertDialog, Dialog } from 'radix-ui';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import {
  createJobAction,
  deleteJobAction,
  setJobStatusAction,
  updateJobAction,
} from '@/app/(app)/hire/actions';
import {
  EMPTY_JOB_FORM,
  HAS_APPLICATIONS,
  allowedMoves,
  fieldForServerError,
  formErrors,
  fromJob,
  toInput,
  type JobFormErrors,
  type JobFormValues,
} from '@/lib/hire/job-form';
import type { JobsModel } from '@/lib/hire/lists';
import type { EmploymentType, WorkArrangement } from '@/lib/hire/types';
import { cn } from '@/lib/utils';
import { SELECT_CLASS } from '@/screens/crm/crm-form';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LiveDot } from '@/components/ui/live-dot';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AgentNoteMarker } from '@/components/hire/agent-note-marker';
import type { NoteCounts } from '@/lib/hire/agent/notes';

type Row = JobsModel['rows'][number];
type ActionResult = { ok: boolean; error?: string };
type Field = keyof JobFormValues;
type JobInput = ReturnType<typeof toInput>;

const PILL: Record<Row['status'], string> = {
  Open: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  Paused: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  Closed: 'bg-muted text-muted-foreground',
  Draft: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
};

const ARRANGEMENT_LABEL: Record<WorkArrangement, string> = {
  onsite: 'On-site',
  hybrid: 'Hybrid',
  remote: 'Remote',
};
const TYPE_LABEL: Record<EmploymentType, string> = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  contract: 'Contract',
  internship: 'Internship',
};

const NOT_SENT = 'That change could not be sent. Check your connection and try again.';

/** The fields that can be wrong, in the order they appear in the form. */
const FIELD_ORDER = [
  'title',
  'department',
  'employmentType',
  'headcount',
  'location',
  'workArrangement',
  'description',
  'salaryMin',
  'salaryMax',
  'closesOn',
] as const satisfies readonly Field[];
/** Every form value, for telling whether anything changed. */
const FIELD_KEYS = Object.keys(EMPTY_JOB_FORM) as Field[];

// The dialog look of the app's other CRUD screens (see ad-studio-table.tsx).
const OVERLAY_CLASS = 'fixed inset-0 z-50 bg-black/40';
const CONTENT_CLASS =
  'fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-background p-5 shadow-lg outline-none max-h-[85vh] overflow-y-auto';
const ALERT_CLASS =
  'rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive';
/** 44 pixels of hit area on every button and field. */
const TARGET = 'min-h-11 min-w-11';
const FIELD_HEIGHT = 'h-11';

/** "Hybrid · 2 openings", or just "1 opening". */
function openings(job: Row['job']): string {
  const count = `${job.headcount} ${job.headcount === 1 ? 'opening' : 'openings'}`;
  return job.work_arrangement ? `${ARRANGEMENT_LABEL[job.work_arrangement]} · ${count}` : count;
}

/** Focuses a button on the page, or `fallback` when it is no longer there: a row can go while its dialog is open. */
function focusOr(element: HTMLElement | null, fallback: HTMLElement | null) {
  (element?.isConnected ? element : fallback)?.focus();
}

export function JobsTable({
  rows,
  canEdit,
  today,
  agentNotes,
}: {
  rows: Row[];
  canEdit: boolean;
  today: string;
  /** The agent's notes, by job id, for the row marker. Left out: no marker. */
  agentNotes?: NoteCounts;
}) {
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<Row | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Whether the open form differs from what it started with. */
  const [dirty, setDirty] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  /** Counts refused clicks on a blocked Delete, so the same reason is announced again each time. */
  const [blockedClicks, setBlockedClicks] = useState(0);
  const reasonId = useId();
  const postButton = useRef<HTMLButtonElement>(null);
  /** The button that opened the job form or the delete confirm: focus goes back to it when that closes. */
  const opener = useRef<HTMLElement | null>(null);
  /**
   * What to focus once the running action has ended. Every button that starts an action is disabled
   * while it runs, so none of them can take focus before then.
   */
  const focusWhenIdle = useRef<HTMLElement | null>(null);
  const formContent = useRef<HTMLDivElement>(null);
  /** The form field that last had focus, for coming back from "Discard your changes?". */
  const lastField = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (pending || !focusWhenIdle.current) return;
    const element = focusWhenIdle.current;
    focusWhenIdle.current = null;
    focusOr(element, postButton.current);
  }, [pending]);

  function act(promise: Promise<ActionResult>, onOk: () => void) {
    // Cleared first, so the same message twice in a row is announced twice.
    setNotice(null);
    setError(null);
    start(async () => {
      try {
        const result = await promise;
        if (result.ok) {
          setError(null);
          onOk();
        } else {
          setError(result.error ?? 'Something went wrong.');
        }
      } catch {
        setError(NOT_SENT);
      }
    });
  }

  const formOpen = canEdit && (creating || editing !== null);

  function openForm(row: Row | null, from: HTMLElement) {
    opener.current = from;
    lastField.current = null;
    setError(null);
    setDirty(false);
    setEditing(row);
    setCreating(row === null);
  }

  function closeForm() {
    setCreating(false);
    setEditing(null);
    setDirty(false);
    setConfirmingDiscard(false);
    setError(null);
  }

  function closeDelete() {
    setDeleting(null);
    setError(null);
  }

  /** Cancel, Escape and a click outside all come here. */
  function requestClose() {
    if (pending) return;
    if (dirty) setConfirmingDiscard(true);
    else closeForm();
  }

  return (
    <div className="mt-3">
      {/* The live region is always in the page, so a change to its text is announced. */}
      <div className={cn('flex items-center gap-3 px-4', canEdit && 'min-h-11 pb-3')}>
        <p aria-live="polite" className="min-w-0 flex-1 text-sm text-muted-foreground">
          {notice}
        </p>
        {canEdit && (
          <Button
            ref={postButton}
            type="button"
            size="sm"
            className={cn(TARGET, 'ml-auto')}
            onClick={(event) => openForm(null, event.currentTarget)}
            disabled={pending}
          >
            <Plus className="size-4" />
            Post a Job
          </Button>
        )}
      </div>
      {error && !formOpen && !deleting && (
        // Keyed, so a second click on a blocked Delete puts a new alert in the page and it is announced again.
        <p key={blockedClicks} role="alert" className={cn(ALERT_CLASS, 'mx-4 mb-3')}>
          {error}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
          No jobs yet
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead>Role</TableHead>
                <TableHead>Department</TableHead>
                <TableHead className="text-right">Applicants</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Posted</TableHead>
                {canEdit && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const blocked = row.applicants > 0;
                const blockedId = `${reasonId}-${row.id}`;
                return (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap">
                      <span className="flex items-center gap-2.5 font-medium">
                        <LiveDot active={row.status === 'Open'} />
                        {row.title}
                        <AgentNoteMarker note={agentNotes?.[row.id]} />
                      </span>
                      <span className="mt-0.5 block pl-[18px] text-xs text-muted-foreground">
                        {openings(row.job)}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{row.dept}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.applicants}</TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          'inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                          PILL[row.status],
                        )}
                      >
                        {row.status}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{row.posted}</TableCell>
                    {canEdit && (
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className={TARGET}
                            aria-label={`Edit ${row.title}`}
                            disabled={pending}
                            onClick={(event) => openForm(row, event.currentTarget)}
                          >
                            <Pencil className="size-4" />
                            Edit
                          </Button>
                          {allowedMoves(row.job.status).map((move) => (
                            <Button
                              key={move.to}
                              type="button"
                              variant="ghost"
                              size="sm"
                              className={TARGET}
                              aria-label={`${move.label} ${row.title}`}
                              disabled={pending}
                              onClick={(event) => {
                                // A refused move comes back to this button, so the keyboard position is kept.
                                focusWhenIdle.current = event.currentTarget;
                                act(setJobStatusAction({ id: row.id, status: move.to }), () => {
                                  // This button may be gone once the status has changed.
                                  focusWhenIdle.current = postButton.current;
                                  setNotice(`${row.title} is now ${move.to}.`);
                                });
                              }}
                            >
                              {move.label}
                            </Button>
                          ))}
                          {/* A job with applications keeps a focusable Delete that says why it will not act. */}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className={cn(
                              TARGET,
                              'text-destructive hover:text-destructive',
                              'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent',
                            )}
                            aria-label={`Delete ${row.title}`}
                            aria-disabled={blocked || undefined}
                            aria-describedby={blocked ? blockedId : undefined}
                            disabled={pending}
                            onClick={(event) => {
                              setNotice(null);
                              setError(blocked ? HAS_APPLICATIONS : null);
                              if (blocked) {
                                setBlockedClicks((count) => count + 1);
                              } else {
                                opener.current = event.currentTarget;
                                setDeleting(row);
                              }
                            }}
                          >
                            <Trash2 className="size-4" />
                            Delete
                          </Button>
                          {blocked && (
                            <span id={blockedId} className="sr-only">
                              {HAS_APPLICATIONS}
                            </span>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Delete confirm */}
      <AlertDialog.Root
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !pending) closeDelete();
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={OVERLAY_CLASS} />
          <AlertDialog.Content
            className={cn(CONTENT_CLASS, 'max-w-sm')}
            // There is no Radix trigger, so Radix has nothing to give focus back to: this does it.
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              focusOr(opener.current, postButton.current);
            }}
          >
            <AlertDialog.Title className="text-base font-semibold break-words">
              Delete “{deleting?.title}”?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm text-muted-foreground">
              This can&apos;t be undone.
            </AlertDialog.Description>
            {error && (
              <p role="alert" className={cn(ALERT_CLASS, 'mt-3')}>
                {error}
              </p>
            )}
            <div className="mt-5 flex items-center justify-between gap-6">
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={TARGET}
                  disabled={pending}
                  autoFocus
                >
                  Cancel
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className={TARGET}
                  disabled={pending}
                  onClick={(event) => {
                    // Stay open while the delete runs: a refusal is shown here, and only success closes it.
                    event.preventDefault();
                    if (!deleting) return;
                    const { id, title } = deleting;
                    // A refusal leaves this dialog open: focus comes back to this button, not to the page behind.
                    focusWhenIdle.current = event.currentTarget;
                    act(deleteJobAction({ id }), () => {
                      // The row is gone, and with it the Delete button that opened this.
                      opener.current = postButton.current;
                      focusWhenIdle.current = postButton.current;
                      setDeleting(null);
                      setNotice(`${title} was deleted.`);
                    });
                  }}
                >
                  <Trash2 className="size-4" />
                  {pending ? 'Deleting…' : 'Delete job'}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      {/* Job form */}
      <Dialog.Root
        open={formOpen}
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={OVERLAY_CLASS} />
          <Dialog.Content
            ref={formContent}
            className={cn(CONTENT_CLASS, 'max-w-lg')}
            onFocus={(event) => {
              // Every field sits in a fieldset; Cancel, Save and the discard confirm do not.
              if (event.target.closest('fieldset')) lastField.current = event.target;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              focusOr(opener.current, postButton.current);
            }}
          >
            <Dialog.Title className="text-base font-semibold">
              {editing ? 'Edit job' : 'Post a job'}
            </Dialog.Title>
            <Dialog.Description className="mb-4 text-sm text-muted-foreground">
              {editing
                ? 'Update this job’s details.'
                : 'A new job is saved as a draft. Open it when you are ready for applications.'}
            </Dialog.Description>
            {formOpen && (
              <JobForm
                key={editing?.id ?? 'new'}
                row={editing}
                today={today}
                pending={pending}
                error={error}
                onDirtyChange={setDirty}
                onClearError={() => setError(null)}
                onCancel={requestClose}
                onSubmit={(input) =>
                  act(
                    editing ? updateJobAction({ id: editing.id, ...input }) : createJobAction(input),
                    () => {
                      // The opener may still be disabled when the form closes after a save.
                      focusWhenIdle.current = opener.current;
                      closeForm();
                      setNotice(editing ? 'Changes saved.' : 'Job saved as a draft.');
                    },
                  )
                }
              />
            )}

            {/* Unsaved changes */}
            <AlertDialog.Root open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
              <AlertDialog.Portal>
                <AlertDialog.Overlay className={OVERLAY_CLASS} />
                <AlertDialog.Content
                  className={cn(CONTENT_CLASS, 'max-w-sm')}
                  onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    // "Keep editing" goes back into the form. After Discard the form has gone too, so
                    // nothing here is still in the page, and the form's own close returns focus to its opener.
                    const field = lastField.current?.isConnected
                      ? lastField.current
                      : formContent.current?.querySelector<HTMLElement>('input');
                    field?.focus();
                  }}
                >
                  <AlertDialog.Title className="text-base font-semibold">
                    Discard your changes?
                  </AlertDialog.Title>
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
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className={TARGET}
                        onClick={closeForm}
                      >
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
    </div>
  );
}

function JobForm({
  row,
  today,
  pending,
  error,
  onDirtyChange,
  onClearError,
  onCancel,
  onSubmit,
}: {
  /** The job being edited, or null for a new one. */
  row: Row | null;
  today: string;
  pending: boolean;
  /** A refusal from the server: shown under the field it is about, or at the top when it is about none. */
  error: string | null;
  onDirtyChange: (dirty: boolean) => void;
  onClearError: () => void;
  onCancel: () => void;
  onSubmit: (input: JobInput) => void;
}) {
  const stored = row?.job;
  const [initial] = useState<JobFormValues>(() => (stored ? fromJob(stored) : EMPTY_JOB_FORM));
  const [values, setValues] = useState<JobFormValues>(initial);
  const [errors, setErrors] = useState<JobFormErrors>({});
  const [touched, setTouched] = useState<ReadonlySet<Field>>(() => new Set());
  // The inputs by field name, so a failed save can focus the first one that is wrong.
  const inputs = useRef<Partial<Record<Field, HTMLElement | null>>>({});
  const serverError = useRef<HTMLParagraphElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  /** Set when a press starts on Cancel: some browsers do not focus a clicked button, so the blur names no target. */
  const cancelling = useRef(false);
  const base = useId();
  /** The field the server's refusal is about, if it is about one. */
  const serverField = error ? fieldForServerError(error) : null;

  // A refusal about a field takes focus to that field. Any other one sits at the
  // top of a form that scrolls inside the dialog, so it is brought into view.
  useEffect(() => {
    if (!error) return;
    const field = fieldForServerError(error);
    if (field) inputs.current[field]?.focus();
    else serverError.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  // Save is disabled while the action runs, which drops focus out of the dialog. A refusal
  // that is about no field puts it back on Save once the action has ended.
  useEffect(() => {
    if (pending || !error || fieldForServerError(error)) return;
    if (!form.current?.contains(document.activeElement)) saveButton.current?.focus();
  }, [pending, error]);

  function set<K extends Field>(field: K, value: JobFormValues[K]) {
    const next = { ...values, [field]: value };
    setValues(next);
    onDirtyChange(FIELD_KEYS.some((key) => next[key] !== initial[key]));
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
    const found = formErrors(values, today, stored);
    setErrors(found);
    setTouched((prev) => {
      const next = new Set(prev).add(field);
      // "Maximum can't be lower than the minimum" sits under the maximum, whichever of the two was edited.
      if (field === 'salaryMin' && values.salaryMax.trim() !== '') next.add('salaryMax');
      return next;
    });
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const found = formErrors(values, today, stored);
    setErrors(found);
    const firstWrong = FIELD_ORDER.find((field) => found[field]);
    if (firstWrong) {
      setTouched(new Set(FIELD_ORDER));
      inputs.current[firstWrong]?.focus();
      return;
    }
    onSubmit(toInput(values));
  }

  const id = (field: Field) => `${base}-${field}`;
  const errorId = (field: Field) => `${base}-${field}-error`;
  /** What is wrong with a field: the server's refusal if it is about this field, else the form's own check once the field was left. */
  const shown = (field: Field) =>
    serverField === field && error ? error : touched.has(field) ? errors[field] : undefined;
  const salaryHelpId = `${base}-salary-help`;

  /** The error under a field, announced when it appears. */
  const errorOf = (field: Field) =>
    shown(field) ? (
      <p id={errorId(field)} role="alert" className="text-sm text-destructive">
        {shown(field)}
      </p>
    ) : null;

  return (
    <form ref={form} className="space-y-5" onSubmit={submit} noValidate>
      {error && !serverField && (
        <p ref={serverError} role="alert" className={ALERT_CLASS}>
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">* Required</p>

      <fieldset className="min-w-0 space-y-3">
        <legend className="mb-2 text-sm font-semibold">Role</legend>
        <div className="space-y-1.5">
          <Label htmlFor={id('title')}>
            <span>
              Job title <span aria-hidden="true">*</span>
            </span>
          </Label>
          <Input
            id={id('title')}
            ref={(element) => {
              inputs.current.title = element;
            }}
            className={FIELD_HEIGHT}
            value={values.title}
            onChange={(e) => set('title', e.target.value)}
            onBlur={(event) => blur('title', event)}
            maxLength={120}
            placeholder="For example, Sales Executive"
            aria-required="true"
            aria-invalid={shown('title') ? true : undefined}
            aria-describedby={shown('title') ? errorId('title') : undefined}
          />
          {errorOf('title')}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={id('department')}>Department</Label>
            <Input
              id={id('department')}
              ref={(element) => {
                inputs.current.department = element;
              }}
              className={FIELD_HEIGHT}
              value={values.department}
              onChange={(e) => set('department', e.target.value)}
              onBlur={(event) => blur('department', event)}
              placeholder="For example, Sales"
              maxLength={80}
              aria-invalid={shown('department') ? true : undefined}
              aria-describedby={shown('department') ? errorId('department') : undefined}
            />
            {errorOf('department')}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id('employmentType')}>Employment type</Label>
            <select
              id={id('employmentType')}
              ref={(element) => {
                inputs.current.employmentType = element;
              }}
              className={cn(SELECT_CLASS, FIELD_HEIGHT)}
              value={values.employmentType}
              onChange={(e) => set('employmentType', e.target.value as EmploymentType)}
              onBlur={(event) => blur('employmentType', event)}
            >
              {(Object.keys(TYPE_LABEL) as EmploymentType[]).map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABEL[type]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={id('headcount')}>Headcount</Label>
          <Input
            id={id('headcount')}
            ref={(element) => {
              inputs.current.headcount = element;
            }}
            className={cn(FIELD_HEIGHT, 'w-28')}
            inputMode="numeric"
            value={values.headcount}
            onChange={(e) => set('headcount', e.target.value)}
            onBlur={(event) => blur('headcount', event)}
            aria-invalid={shown('headcount') ? true : undefined}
            aria-describedby={shown('headcount') ? errorId('headcount') : undefined}
          />
          {errorOf('headcount')}
        </div>
      </fieldset>

      <fieldset className="min-w-0 space-y-3">
        <legend className="mb-2 text-sm font-semibold">Where</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={id('location')}>Location</Label>
            <Input
              id={id('location')}
              ref={(element) => {
                inputs.current.location = element;
              }}
              className={FIELD_HEIGHT}
              value={values.location}
              onChange={(e) => set('location', e.target.value)}
              onBlur={(event) => blur('location', event)}
              placeholder="For example, Shah Alam"
              maxLength={120}
              aria-invalid={shown('location') ? true : undefined}
              aria-describedby={shown('location') ? errorId('location') : undefined}
            />
            {errorOf('location')}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id('workArrangement')}>Work arrangement</Label>
            <select
              id={id('workArrangement')}
              ref={(element) => {
                inputs.current.workArrangement = element;
              }}
              className={cn(SELECT_CLASS, FIELD_HEIGHT)}
              value={values.workArrangement}
              onChange={(e) => set('workArrangement', e.target.value as WorkArrangement | '')}
              onBlur={(event) => blur('workArrangement', event)}
            >
              <option value="">Not set</option>
              {(Object.keys(ARRANGEMENT_LABEL) as WorkArrangement[]).map((arrangement) => (
                <option key={arrangement} value={arrangement}>
                  {ARRANGEMENT_LABEL[arrangement]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>

      <fieldset className="min-w-0 space-y-3">
        <legend className="mb-2 text-sm font-semibold">Details</legend>
        <div className="space-y-1.5">
          <Label htmlFor={id('description')}>Description</Label>
          <Textarea
            id={id('description')}
            ref={(element) => {
              inputs.current.description = element;
            }}
            rows={6}
            className="min-h-36"
            value={values.description}
            onChange={(e) => set('description', e.target.value)}
            onBlur={(event) => blur('description', event)}
            aria-invalid={shown('description') ? true : undefined}
            aria-describedby={shown('description') ? errorId('description') : undefined}
          />
          {errorOf('description')}
        </div>
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                ['salaryMin', 'Minimum salary'],
                ['salaryMax', 'Maximum salary'],
              ] as const
            ).map(([field, label]) => (
              <div key={field} className="min-w-0 space-y-1.5">
                <Label htmlFor={id(field)}>{label}</Label>
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <span>RM</span>
                  <Input
                    id={id(field)}
                    ref={(element) => {
                      inputs.current[field] = element;
                    }}
                    className={cn(FIELD_HEIGHT, 'flex-1 px-2 text-foreground')}
                    inputMode="decimal"
                    value={values[field]}
                    onChange={(e) => set(field, e.target.value)}
                    onBlur={(event) => blur(field, event)}
                    aria-invalid={shown(field) ? true : undefined}
                    aria-describedby={shown(field) ? `${errorId(field)} ${salaryHelpId}` : salaryHelpId}
                  />
                  <span className="shrink-0 text-xs whitespace-nowrap">a month</span>
                </div>
                {errorOf(field)}
              </div>
            ))}
          </div>
          <p id={salaryHelpId} className="text-xs text-muted-foreground">
            Leave blank if you&apos;d rather not say.
          </p>
        </div>
        <div className="flex min-h-11 items-center gap-2">
          <Checkbox
            id={id('showSalary')}
            checked={values.showSalary}
            onCheckedChange={(checked) => set('showSalary', checked === true)}
          />
          <Label htmlFor={id('showSalary')} className="min-h-11">
            Show salary publicly
          </Label>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={id('closesOn')}>Closing date</Label>
          <Input
            id={id('closesOn')}
            ref={(element) => {
              inputs.current.closesOn = element;
            }}
            className={cn(FIELD_HEIGHT, 'w-44')}
            type="date"
            min={today}
            value={values.closesOn}
            onChange={(e) => set('closesOn', e.target.value)}
            onBlur={(event) => blur('closesOn', event)}
            aria-invalid={shown('closesOn') ? true : undefined}
            aria-describedby={shown('closesOn') ? errorId('closesOn') : undefined}
          />
          {errorOf('closesOn')}
        </div>
      </fieldset>

      <div className="flex justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          ref={cancelButton}
          className={TARGET}
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
            onCancel();
          }}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" ref={saveButton} className={TARGET} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
