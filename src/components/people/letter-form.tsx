'use client';

import { Plus } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useId, useRef, useState, useTransition } from 'react';
import {
  issueLetterAction,
  saveLetterAction,
  startLetterFromTemplateAction,
} from '@/app/(app)/people/letter-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { LETTER_BODY_MAX, LETTER_TITLE_MAX, toLetterInput } from '@/lib/people/document-forms';
import {
  DRAFT_KEPT_NOTE,
  type LetterFormValues,
  issueFailureSentence,
  letterFormDefaults,
  letterIssueSentence,
  issueState,
  placeholderSpot,
  startChoice,
} from '@/lib/people/letters-screens';
import { LETTER_TYPE_LABEL } from '@/lib/people/own';
import { LETTER_TYPES, type LetterType } from '@/lib/people/types';

/** The draft being edited. */
export type EditableLetter = {
  id: string;
  employee_id: string;
  employee_name: string;
  letter_type: string;
  title: string;
  body: string;
  ack_requested: boolean;
};

export type LetterEmployeeOption = { id: string; name: string };
export type LetterTemplateOption = { id: string; name: string; type_label: string };

const SELECT_CLASS =
  'h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30';

type Target = { id: string | null; employee_id: string; employee_name: string; values: LetterFormValues };

/** Step 1 of a new letter: the employee, then blank or from a template. */
function StartStep({
  employees,
  templates,
  onClose,
  onBusy,
  onStarted,
}: {
  employees: LetterEmployeeOption[];
  templates: LetterTemplateOption[];
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  onStarted: (target: Target) => void;
}) {
  const id = useId();
  const [employeeId, setEmployeeId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function begin() {
    const choice = startChoice({ employeeId, templateId });
    if (!choice.ok) {
      setError(choice.error);
      return;
    }
    const employee = employees.find((e) => e.id === employeeId);
    if (!employee) {
      setError('Choose an employee.');
      return;
    }
    setError(null);
    if (choice.kind === 'blank') {
      onStarted({ id: null, employee_id: employee.id, employee_name: employee.name, values: letterFormDefaults(null) });
      return;
    }
    onBusy(true);
    start(async () => {
      try {
        const result = await startLetterFromTemplateAction({ employee_id: employee.id, template_id: templateId });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        // The draft now exists, with what the database could fill in; the form then finds what is left in the text.
        onStarted({
          id: result.data.letter.id,
          employee_id: employee.id,
          employee_name: employee.name,
          values: letterFormDefaults(result.data.letter),
        });
      } catch {
        setError(WRITE_FAILED);
      } finally {
        onBusy(false);
      }
    });
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) begin();
      }}
    >
      <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-employee`}>
        Employee
        <select
          id={`${id}-employee`}
          className={SELECT_CLASS}
          disabled={pending}
          value={employeeId}
          onChange={(event) => {
            setError(null);
            setEmployeeId(event.target.value);
          }}
        >
          <option value="">Choose an employee</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-template`}>
        Start from
        <select
          id={`${id}-template`}
          className={SELECT_CLASS}
          disabled={pending}
          value={templateId}
          onChange={(event) => {
            setError(null);
            setTemplateId(event.target.value);
          }}
        >
          <option value="">A blank letter</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.type_label})
            </option>
          ))}
        </select>
      </label>
      {templateId !== '' ? (
        <p className="text-xs text-muted-foreground">
          The draft opens with the employee&apos;s details filled in. Anything that could not be filled is listed so you can
          replace it. The draft is saved as soon as you continue; the template itself is not changed.
        </p>
      ) : null}
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
          {pending ? 'Working…' : 'Continue'}
        </Button>
      </div>
    </form>
  );
}

/** Step 2: the letter itself. Saving makes or changes a draft; issuing saves first, then takes a second step. */
function WriteStep({
  target,
  onClose,
  onBusy,
}: {
  target: Target;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const id = useId();
  const [values, setValues] = useState<LetterFormValues>(target.values);
  // Set by the first save, so a second press changes the same draft instead of making another.
  const [letterId, setLetterId] = useState<string | null>(target.id);
  const [error, setError] = useState<string | null>(null);
  const [confirmingIssue, setConfirmingIssue] = useState(false);
  const [pending, start] = useTransition();
  const [pressed, setPressed] = useState<'save' | 'issue' | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Found in the text as it is now, not from the list the database reported: a known placeholder typed or left
  // anywhere in the title or body stops the issue.
  const state = issueState(values.title, values.body);

  const edit = (patch: Partial<LetterFormValues>) => {
    setError(null);
    setConfirmingIssue(false);
    setValues((v) => ({ ...v, ...patch }));
  };

  function select(name: string) {
    const spot = placeholderSpot(values.title, values.body, name);
    if (!spot) return;
    const element = spot.field === 'title' ? titleRef.current : bodyRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(spot.start, spot.end);
  }

  function run(issue: boolean) {
    const converted = toLetterInput(values);
    if (!converted.ok) {
      setError(converted.error);
      return;
    }
    setError(null);
    setPressed(issue ? 'issue' : 'save');
    onBusy(true);
    start(async () => {
      // Set once this press has saved the draft, so a later failure can say so.
      let saved = false;
      try {
        const result = await saveLetterAction({
          employee_id: target.employee_id,
          ...(letterId ? { letter_id: letterId } : {}),
          ...converted.input,
        });
        if (!result.ok) {
          setError(issueFailureSentence(false, result.error));
          return;
        }
        saved = true;
        setLetterId(result.data.id);
        if (!issue) {
          onClose();
          return;
        }
        const issued = await issueLetterAction({ letter_id: result.data.id });
        if (issued.ok) onClose();
        else setError(issueFailureSentence(true, issued.error));
      } catch {
        setError(issueFailureSentence(saved && issue, null));
      } finally {
        setPressed(null);
        onBusy(false);
      }
    });
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) run(false);
      }}
    >
      <p className="text-sm text-muted-foreground">
        To <span className="font-medium text-foreground">{target.employee_name}</span>
      </p>
      <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-type`}>
        Type
        <select
          id={`${id}-type`}
          className={SELECT_CLASS}
          disabled={pending}
          value={values.letter_type}
          onChange={(event) => edit({ letter_type: event.target.value })}
        >
          {LETTER_TYPES.map((t: LetterType) => (
            <option key={t} value={t}>
              {LETTER_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-title`}>
        Title
        <Input
          id={`${id}-title`}
          ref={titleRef}
          required
          maxLength={LETTER_TITLE_MAX}
          disabled={pending}
          value={values.title}
          onChange={(event) => edit({ title: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-body`}>
        Letter
        <Textarea
          id={`${id}-body`}
          ref={bodyRef}
          rows={12}
          maxLength={LETTER_BODY_MAX}
          disabled={pending}
          value={values.body}
          onChange={(event) => edit({ body: event.target.value })}
        />
      </label>
      {state.names.length > 0 ? (
        <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium">Still to replace in this letter</p>
          <div className="flex flex-wrap gap-1.5">
            {state.names.map((name) => (
              <Button key={name} type="button" variant="outline" size="xs" onClick={() => select(name)}>
                {`{${name}}`}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Pressing one selects its first place in the text. Replace or remove each before issuing.
          </p>
        </div>
      ) : null}
      <label className="flex items-center gap-2 text-sm" htmlFor={`${id}-ack`}>
        <input
          id={`${id}-ack`}
          type="checkbox"
          disabled={pending}
          checked={values.ack_requested}
          onChange={(event) => edit({ ack_requested: event.target.checked })}
        />
        Ask {target.employee_name} to confirm they have read it
      </label>
      {confirmingIssue ? (
        <div className="space-y-2 rounded-md border p-3">
          <p role="alert" className="text-sm">
            {letterIssueSentence(target.employee_name)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={pending || !state.allowed} onClick={() => run(true)}>
              {pending && pressed === 'issue' ? 'Working…' : 'Save and issue'}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setConfirmingIssue(false)}>
              Keep as draft
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {letterId ? <p className="text-xs text-muted-foreground">{DRAFT_KEPT_NOTE}</p> : null}
      {!state.allowed ? <p className="text-xs text-muted-foreground">Issue is unavailable. {state.reason}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
          {letterId ? 'Close' : 'Cancel'}
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => run(false)}>
          {pending && pressed === 'save' ? 'Working…' : 'Save as draft'}
        </Button>
        <Button
          type="button"
          disabled={pending || !state.allowed}
          title={state.reason ?? undefined}
          aria-expanded={confirmingIssue}
          onClick={() => setConfirmingIssue(true)}
        >
          Issue…
        </Button>
      </div>
    </form>
  );
}

function LetterFormBody({
  employees,
  templates,
  letter,
  onClose,
  onBusy,
}: {
  employees: LetterEmployeeOption[];
  templates: LetterTemplateOption[];
  letter: EditableLetter | null;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const [target, setTarget] = useState<Target | null>(
    letter
      ? { id: letter.id, employee_id: letter.employee_id, employee_name: letter.employee_name, values: letterFormDefaults(letter) }
      : null,
  );
  if (!target) {
    return <StartStep employees={employees} templates={templates} onClose={onClose} onBusy={onBusy} onStarted={setTarget} />;
  }
  return <WriteStep target={target} onClose={onClose} onBusy={onBusy} />;
}

/**
 * "New letter" (no `letter`) or "Edit" on a draft: a dialog around the two steps. Owners and admins outside the demo
 * only. It stays open while a call is in flight so the answer is shown.
 */
export function LetterDialog({
  employees = [],
  templates = [],
  letter = null,
}: {
  employees?: LetterEmployeeOption[];
  templates?: LetterTemplateOption[];
  letter?: EditableLetter | null;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        setOpen(next);
      }}
    >
      <Dialog.Trigger asChild>
        {letter ? (
          <Button type="button" variant="outline" size="sm" aria-label={`Edit ${letter.title}`}>
            Edit
          </Button>
        ) : (
          <Button type="button" size="sm">
            <Plus aria-hidden />
            New letter
          </Button>
        )}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg outline-none">
          <Dialog.Title className="text-base font-semibold">{letter ? 'Edit draft letter' : 'New letter'}</Dialog.Title>
          <Dialog.Description className="mb-4 text-sm text-muted-foreground">
            {letter
              ? 'Only a draft can be changed. The employee cannot see it until you issue it.'
              : 'Choose who it is for, then write it or start from a template. It stays a draft until you issue it.'}
          </Dialog.Description>
          <LetterFormBody
            employees={employees}
            templates={templates}
            letter={letter}
            onClose={() => setOpen(false)}
            onBusy={setBusy}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
