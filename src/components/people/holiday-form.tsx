'use client';

import { Plus } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { deleteHolidayAction, saveHolidayAction } from '@/app/(app)/people/attendance-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toHolidayInput } from '@/lib/people/attendance-forms';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import { RowPrompt, usePromptId } from './request-row';

export type HolidayValue = { id: string; name: string; date: string };

/**
 * "Add holiday" (no `holiday`) or "Edit" (a row's holiday): a small dialog with a name and a date. The dialog
 * closes once the server accepts. A demo visitor sees the trigger disabled.
 */
export function HolidayDialog({ holiday, disabled }: { holiday?: HolidayValue; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [name, setName] = useState(holiday?.name ?? '');
  const [date, setDate] = useState(holiday?.date ?? '');
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  function show(next: boolean) {
    if (next) {
      // Open on what the row holds now.
      setName(holiday?.name ?? '');
      setDate(holiday?.date ?? '');
      setError(null);
      setOpen(true);
    } else if (!pending) {
      setOpen(false);
      setError(null);
    }
  }

  function submit() {
    const converted = toHolidayInput({ id: holiday?.id ?? null, name, holiday_date: date });
    if (!converted.ok) {
      setError(converted.error);
      return;
    }
    setError(null);
    start(async () => {
      let result: CapResult<unknown>;
      try {
        result = await saveHolidayAction(converted.input);
      } catch {
        result = { ok: false, error: WRITE_FAILED };
      }
      if (result.ok) setOpen(false);
      else setError(result.error);
    });
  }

  const editing = Boolean(holiday);
  return (
    <Dialog.Root open={open} onOpenChange={show}>
      <Dialog.Trigger asChild>
        {editing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={disabled}
            aria-label={`Edit ${holiday!.name}`}
          >
            Edit
          </Button>
        ) : (
          <Button type="button" size="sm" disabled={disabled}>
            <Plus aria-hidden />
            Add holiday
          </Button>
        )}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg outline-none">
          <Dialog.Title className="text-base font-semibold">{editing ? 'Edit holiday' : 'Add holiday'}</Dialog.Title>
          <Dialog.Description className="mb-4 text-sm text-muted-foreground">
            A public holiday is not a working day: nobody is marked absent on it.
          </Dialog.Description>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm" htmlFor={`${ids}-name`}>
                Name
                <Input
                  id={`${ids}-name`}
                  required
                  maxLength={120}
                  autoComplete="off"
                  disabled={pending}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm" htmlFor={`${ids}-date`}>
                Date
                <Input
                  id={`${ids}-date`}
                  type="date"
                  required
                  min="2000-01-01"
                  max="2100-12-31"
                  disabled={pending}
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
              </label>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={pending} onClick={() => show(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                Save
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** "Remove" on a holiday row: asks in the row's own prompt area first. A demo visitor sees it disabled. */
export function RemoveHoliday({ id, name, disabled }: { id: string; name: string; disabled: boolean }) {
  const [busy, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const off = disabled || busy;
  const trigger = useRef<HTMLButtonElement>(null);
  const promptId = usePromptId();
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current || busy || asking) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [busy, asking]);

  const close = () => {
    setAsking(false);
    setError(null);
    refocus.current = true;
  };

  function remove() {
    setError(null);
    start(async () => {
      let result: CapResult<unknown>;
      try {
        result = await deleteHolidayAction({ id });
      } catch {
        result = { ok: false, error: WRITE_FAILED };
      }
      if (result.ok) {
        setAsking(false);
        refocus.current = true;
      } else setError(result.error);
    });
  }

  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2.5 text-xs"
        disabled={off}
        aria-expanded={asking}
        aria-controls={promptId}
        aria-label={`Remove ${name}`}
        onClick={() => {
          if (asking) close();
          else {
            setError(null);
            setAsking(true);
          }
        }}
      >
        Remove
      </Button>
      {asking || error ? (
        <RowPrompt focusKey={asking ? 'removing' : ''} onEscape={close}>
          {asking ? (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-xs text-destructive">
                Remove this holiday?
              </p>
              <Button type="button" variant="destructive" size="sm" className="h-7 px-2.5 text-xs" disabled={off} onClick={remove}>
                Confirm
              </Button>
              <Button type="button" variant="ghost" size="sm" data-autofocus className="h-7 px-2.5 text-xs" disabled={off} onClick={close}>
                Keep
              </Button>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </RowPrompt>
      ) : null}
    </>
  );
}
