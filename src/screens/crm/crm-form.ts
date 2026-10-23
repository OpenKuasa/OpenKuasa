'use client';

import { startTransition, useActionState, type FormEvent } from 'react';
import type { CrmFormAction, CrmFormState } from '@/lib/crm/form-state';

/**
 * Runs a form action and calls `onDone` once it has succeeded, so the caller
 * can close whatever the form was shown in. `onDone` is given the id of what
 * the action made, when it hands one back.
 *
 * Pass `formAction` to `<form action>` for a form of plain fields. A form whose
 * checkboxes or selects are held in state uses `onSubmit` instead: after
 * `<form action>` finishes, React resets the form, which puts each such checkbox
 * back to its value when the page loaded and each select to its first option,
 * while the state, and so what was saved, says otherwise.
 */
export function useCrmForm(action: CrmFormAction, onDone?: (id?: string) => void) {
  const [state, formAction, pending] = useActionState<CrmFormState, FormData>(
    async (prev, formData) => {
      const next = await action(prev, formData);
      if (next?.ok) onDone?.(next.id);
      return next;
    },
    undefined,
  );
  // An old message is not shown while the next attempt is still running.
  const error = state && !state.ok && !pending ? state.error : null;
  const values = state && !state.ok ? state.values : null;
  // Sends the same form data, including the pressed button, without the reset.
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const formData = new FormData(event.currentTarget, submitter);
    startTransition(() => formAction(formData));
  };
  return { formAction, onSubmit, pending, error, values };
}

/** A native select styled like the inputs it sits beside in a form. */
export const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 dark:disabled:bg-input/80';
