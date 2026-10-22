'use client';

import { type FormEvent, useActionState, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  CONSENT_FIELD,
  HONEYPOT_FIELD,
  SUBMISSION_EMAIL_MAX,
  SUBMISSION_MESSAGES,
  SUBMISSION_MESSAGE_MAX,
  SUBMISSION_NAME_MAX,
  SUBMISSION_PHONE_MAX,
  SUBMISSION_PROBLEM_ORDER,
  type SubmissionErrors,
  shownSubmissionErrors,
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
 * The four fields every lead form asks for, and the box the visitor ticks to
 * agree to the form's consent sentence. Works as a plain form post without
 * JavaScript; with it, the page is not reloaded and an unticked box is caught
 * before anything is sent. Problems are reported beside the field they are about.
 */
export function PublicLeadForm({
  action,
  consentText,
  submitLabel = 'Send',
}: {
  /** The submit action, already tied to this form. */
  action: (prev: PublicFormState, formData: FormData) => Promise<PublicFormState>;
  /** The sentence beside the box, the workspace's name already filled in. */
  consentText: string;
  /** What the button says. A landing page can give its own. */
  submitLabel?: string;
}) {
  const id = useId();
  const [state, formAction, pending] = useActionState<PublicFormState, FormData>(action, undefined);
  const formRef = useRef<HTMLFormElement>(null);
  // Set in the browser when the box was left unticked; nothing was sent then.
  const [unticked, setUnticked] = useState<{ attempt: number } | null>(null);
  // The server answer the box has been ticked after, if any: that answer's
  // complaint about the box no longer applies. A new answer starts afresh.
  const [tickedAfter, setTickedAfter] = useState<PublicFormState | null>(null);
  const values = state?.values;
  const errors = shownSubmissionErrors(state?.errors, {
    blocked: unticked != null,
    tickedSince: tickedAfter === state,
  });

  // After a rejected attempt, go to the first field that needs changing: once
  // per server answer, and once per send the browser stopped. Ticking the box
  // changes neither, so it never moves focus.
  const focused = useRef<{ state: PublicFormState; attempt: number | null }>({ state: undefined, attempt: null });
  useEffect(() => {
    const attempt = unticked?.attempt ?? null;
    const last = focused.current;
    focused.current = { state, attempt };
    const newAnswer = state !== last.state;
    const newBlock = attempt != null && attempt !== last.attempt;
    if (!newAnswer && !newBlock) return;
    const current = shownSubmissionErrors(state?.errors, { blocked: newBlock, tickedSince: false });
    if (!current) return;
    const first = SUBMISSION_PROBLEM_ORDER.find((field) => current[field]);
    if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
  }, [state, unticked]);

  const checkConsent = (event: FormEvent<HTMLFormElement>) => {
    const box = event.currentTarget.elements.namedItem(CONSENT_FIELD);
    if (box instanceof HTMLInputElement && !box.checked) {
      // Not sent: the server would refuse it too, and the visitor would wait for nothing.
      event.preventDefault();
      setUnticked((current) => ({ attempt: (current?.attempt ?? 0) + 1 }));
      return;
    }
    setUnticked(null);
  };

  if (state?.done) {
    return <Outcome title="Thank you">Your response has been sent.</Outcome>;
  }
  if (state?.closed) {
    return <Outcome title="Form closed">{SUBMISSION_MESSAGES.closed}</Outcome>;
  }

  const describe = (field: keyof SubmissionErrors) =>
    errors?.[field] ? `${id}-${field}-error` : undefined;
  const problem = (field: keyof SubmissionErrors) =>
    errors?.[field] ? (
      <p id={`${id}-${field}-error`} className="text-sm text-destructive">
        {errors[field]}
      </p>
    ) : null;

  return (
    // The server checks every field and words every message, so the browser's
    // own checks are switched off rather than shown in a second voice.
    <form ref={formRef} action={formAction} onSubmit={checkConsent} noValidate className="space-y-4">
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

      <div className="space-y-1.5">
        {/* The box and its whole sentence are one label, so the tap area is the full row. */}
        <label
          htmlFor={`${id}-consent`}
          className="flex cursor-pointer items-start gap-3 py-1 text-sm leading-relaxed"
        >
          <input
            id={`${id}-consent`}
            // A native box with no value of its own: ticked, it posts "on" with or without a script.
            name={CONSENT_FIELD}
            type="checkbox"
            required
            defaultChecked={state?.consented === true}
            aria-invalid={errors?.consent ? true : undefined}
            aria-describedby={describe('consent')}
            onChange={(event) => {
              if (!event.currentTarget.checked) return;
              setUnticked(null);
              setTickedAfter(state);
            }}
            className="mt-0.5 size-5 shrink-0 rounded-sm accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
          <span className="min-w-0 break-words">{consentText}</span>
        </label>
        {problem('consent')}
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
          {SUBMISSION_PROBLEM_ORDER.map((field) => errors[field])
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
