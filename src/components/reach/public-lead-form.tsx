'use client';

import { useActionState, useEffect, useId, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  HONEYPOT_FIELD,
  SUBMISSION_EMAIL_MAX,
  SUBMISSION_FIELDS,
  SUBMISSION_MESSAGES,
  SUBMISSION_MESSAGE_MAX,
  SUBMISSION_NAME_MAX,
  SUBMISSION_PHONE_MAX,
} from '@/lib/reach/form-submissions';
import type { PublicFormState } from '@/app/f/[formId]/actions';

/** The message shown in place of the fields, for both end states. */
function Outcome({ title, children }: { title: string; children: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // The fields are gone, so the message takes focus and is read out.
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div ref={ref} tabIndex={-1} role="status" className="space-y-2 outline-none">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * The four fields every lead form asks for. Works as a plain form post without
 * JavaScript; with it, the page is not reloaded. Problems are reported by the
 * server, beside the field they are about.
 */
export function PublicLeadForm({
  action,
  submitLabel = 'Send',
}: {
  /** The submit action, already tied to this form. */
  action: (prev: PublicFormState, formData: FormData) => Promise<PublicFormState>;
  /** What the button says. A landing page can give its own. */
  submitLabel?: string;
}) {
  const id = useId();
  const [state, formAction, pending] = useActionState<PublicFormState, FormData>(action, undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const errors = state?.errors;
  const values = state?.values;

  // After a rejected attempt, go to the first field that needs changing.
  useEffect(() => {
    if (!errors) return;
    const first = SUBMISSION_FIELDS.find((field) => errors[field]);
    if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
  }, [errors]);

  if (state?.done) {
    return <Outcome title="Thank you">Your response has been sent.</Outcome>;
  }
  if (state?.closed) {
    return <Outcome title="Form closed">{SUBMISSION_MESSAGES.closed}</Outcome>;
  }

  const describe = (field: 'name' | 'email' | 'phone' | 'message') =>
    errors?.[field] ? `${id}-${field}-error` : undefined;
  const problem = (field: 'name' | 'email' | 'phone' | 'message') =>
    errors?.[field] ? (
      <p id={`${id}-${field}-error`} className="text-sm text-destructive">
        {errors[field]}
      </p>
    ) : null;

  return (
    // The server checks every field and words every message, so the browser's
    // own checks are switched off rather than shown in a second voice.
    <form ref={formRef} action={formAction} noValidate className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          name="name"
          autoComplete="name"
          maxLength={SUBMISSION_NAME_MAX}
          required
          defaultValue={values?.name}
          aria-invalid={errors?.name ? true : undefined}
          aria-describedby={describe('name')}
          className="h-10"
        />
        {problem('name')}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${id}-email`}>Email</Label>
        <Input
          id={`${id}-email`}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={SUBMISSION_EMAIL_MAX}
          required
          defaultValue={values?.email}
          aria-invalid={errors?.email ? true : undefined}
          aria-describedby={describe('email')}
          className="h-10"
        />
        {problem('email')}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${id}-phone`}>
          Phone <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id={`${id}-phone`}
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          maxLength={SUBMISSION_PHONE_MAX}
          defaultValue={values?.phone}
          aria-invalid={errors?.phone ? true : undefined}
          aria-describedby={describe('phone')}
          className="h-10"
        />
        {problem('phone')}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${id}-message`}>
          Message <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id={`${id}-message`}
          name="message"
          rows={4}
          maxLength={SUBMISSION_MESSAGE_MAX}
          defaultValue={values?.message}
          aria-invalid={errors?.message ? true : undefined}
          aria-describedby={describe('message')}
          className="min-h-24"
        />
        {problem('message')}
      </div>

      {/*
        Not for people: off screen, out of the tab order and hidden from screen
        readers. A script that fills in every field gives itself away here.
      */}
      <div aria-hidden className="absolute -left-[9999px] top-auto size-px overflow-hidden">
        <label htmlFor={`${id}-extra`}>Leave this field empty</label>
        <input
          id={`${id}-extra`}
          name={HONEYPOT_FIELD}
          type="text"
          tabIndex={-1}
          autoComplete="off"
          defaultValue=""
        />
      </div>

      {state?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {errors ? (
        <p role="alert" className="sr-only">
          {SUBMISSION_FIELDS.map((field) => errors[field])
            .filter(Boolean)
            .join(' ')}
        </p>
      ) : null}

      <Button type="submit" size="lg" className="h-10 w-full" disabled={pending}>
        {pending ? 'Sending…' : submitLabel}
      </Button>
    </form>
  );
}
