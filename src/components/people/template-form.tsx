'use client';

import { Plus } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { saveLetterTemplateAction } from '@/app/(app)/people/letter-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { LETTER_BODY_MAX, LETTER_TITLE_MAX, TEMPLATE_NAME_MAX, toTemplateInput } from '@/lib/people/document-forms';
import { PLACEHOLDERS } from '@/lib/people/letter-placeholders';
import { insertPlaceholder, insertRefusal } from '@/lib/people/letters-screens';
import { LETTER_TYPE_LABEL } from '@/lib/people/own';
import { LETTER_TYPES, type LetterType } from '@/lib/people/types';

/** The template being edited. */
export type EditableTemplate = { id: string; name: string; letter_type: string; title: string; body: string };

const SELECT_CLASS =
  'h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30';

type Field = 'title' | 'body';

function TemplateFormBody({
  template,
  onClose,
  onBusy,
}: {
  template: EditableTemplate | null;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const id = useId();
  const [name, setName] = useState(template?.name ?? '');
  const [letterType, setLetterType] = useState(template?.letter_type ?? 'offer');
  const [title, setTitle] = useState(template?.title ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // Whichever of title and body had the cursor last; the body until the title is touched.
  const lastField = useRef<Field>('body');
  const caret = useRef<{ field: Field; at: number } | null>(null);

  // After an insert, put the cursor just behind the placeholder (the state change has to land first).
  useEffect(() => {
    const wanted = caret.current;
    if (!wanted) return;
    caret.current = null;
    const element = wanted.field === 'title' ? titleRef.current : bodyRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(wanted.at, wanted.at);
  }, [title, body]);

  function insert(placeholder: string) {
    const field = lastField.current;
    const element = field === 'title' ? titleRef.current : bodyRef.current;
    const text = field === 'title' ? title : body;
    const start = element?.selectionStart ?? text.length;
    const end = element?.selectionEnd ?? text.length;
    const max = field === 'title' ? LETTER_TITLE_MAX : LETTER_BODY_MAX;
    const refusal = insertRefusal(text, start, end, placeholder, max, field === 'title' ? 'title' : 'letter text');
    if (refusal) {
      setError(refusal);
      return;
    }
    const result = insertPlaceholder(text, start, end, placeholder, max);
    if (result.text === text) return;
    setError(null);
    caret.current = { field, at: result.caret };
    if (field === 'title') setTitle(result.text);
    else setBody(result.text);
  }

  function save() {
    const converted = toTemplateInput({ name, letter_type: letterType, title, body });
    if (!converted.ok) {
      setError(converted.error);
      return;
    }
    setError(null);
    onBusy(true);
    start(async () => {
      try {
        const result = await saveLetterTemplateAction({ ...(template ? { template_id: template.id } : {}), ...converted.input });
        if (result.ok) onClose();
        else setError(result.error);
      } catch {
        setError(WRITE_FAILED);
      } finally {
        onBusy(false);
      }
    });
  }

  const clear = <T,>(set: (value: T) => void) => (value: T) => {
    setError(null);
    set(value);
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) save();
      }}
    >
      <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-name`}>
        Template name
        <Input
          id={`${id}-name`}
          required
          maxLength={TEMPLATE_NAME_MAX}
          disabled={pending}
          value={name}
          onChange={(event) => clear(setName)(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-type`}>
        Type
        <select
          id={`${id}-type`}
          className={SELECT_CLASS}
          disabled={pending}
          value={letterType}
          onChange={(event) => clear(setLetterType)(event.target.value)}
        >
          {LETTER_TYPES.map((t: LetterType) => (
            <option key={t} value={t}>
              {LETTER_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-title`}>
        Letter title
        <Input
          id={`${id}-title`}
          ref={titleRef}
          required
          maxLength={LETTER_TITLE_MAX}
          disabled={pending}
          value={title}
          onFocus={() => {
            lastField.current = 'title';
          }}
          onChange={(event) => clear(setTitle)(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-body`}>
        Letter text
        <Textarea
          id={`${id}-body`}
          ref={bodyRef}
          rows={12}
          maxLength={LETTER_BODY_MAX}
          disabled={pending}
          value={body}
          onFocus={() => {
            lastField.current = 'body';
          }}
          onChange={(event) => clear(setBody)(event.target.value)}
        />
      </label>
      <div className="space-y-1.5">
        <p className="text-sm font-medium">Placeholders</p>
        <div className="flex flex-wrap gap-1.5">
          {PLACEHOLDERS.map((p) => (
            <Button
              key={p}
              type="button"
              variant="outline"
              size="xs"
              disabled={pending}
              // Keep the cursor where it was in the text field instead of moving focus to the button.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insert(p)}
            >
              {`{${p}}`}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Pressing one puts it where the cursor is, in the title or the letter text, whichever you last clicked in. When a
          letter is started from this template each is filled with that employee&apos;s details; any that cannot be
          filled are left for you to replace.
        </p>
      </div>
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
          {pending ? 'Working…' : 'Save template'}
        </Button>
      </div>
    </form>
  );
}

/** "Add template" (no `template`) or "Edit": a dialog around the form. Owners and admins outside the demo only. */
export function TemplateDialog({ template = null }: { template?: EditableTemplate | null }) {
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
        {template ? (
          <Button type="button" variant="outline" size="sm" aria-label={`Edit template ${template.name}`}>
            Edit
          </Button>
        ) : (
          <Button type="button" size="sm">
            <Plus aria-hidden />
            Add template
          </Button>
        )}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg outline-none">
          <Dialog.Title className="text-base font-semibold">{template ? 'Edit template' : 'Add template'}</Dialog.Title>
          <Dialog.Description className="mb-4 text-sm text-muted-foreground">
            A template is a starting point. Changing it does not change letters already started from it.
          </Dialog.Description>
          <TemplateFormBody template={template} onClose={() => setOpen(false)} onBusy={setBusy} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
