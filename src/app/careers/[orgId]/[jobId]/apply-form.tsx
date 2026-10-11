'use client';

import {
  useActionState, useEffect, useRef, useState, useTransition,
  type ChangeEvent, type FocusEvent, type FormEvent, type MouseEvent, type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { CAREERS_LINK_FOCUS } from '@/components/hire/public-careers-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { ApplicationFormValues } from '@/lib/hire/application-form';
import {
  APPLY_HONEYPOT, APPLY_LIMITS, APPLY_MESSAGES, applyProblems, countCharacters, fieldProblem, isRequired, isStaleForm,
  shownFields,
  type ApplyErrors, type ApplyField, type ApplyValues,
} from '@/lib/hire/application-fields';
import type { ApplyState } from './actions';

/*
 * The form a visitor fills to apply. It is built in two layers.
 *
 * 1. What the server answered. Everything drawn here comes from `state`, the
 *    action's last answer: the problems, what was typed, the thank-you. That
 *    is all there is before the script loads, and all there ever is without
 *    one: the form posts as a plain form through `useActionState` and the
 *    page comes back with the answer in it.
 * 2. The script (`useSending`, `useLiveChecks`). With it running, a field is
 *    checked when the visitor leaves it and the whole form before it is sent,
 *    by the same rules and in the same words as the server. The form is then
 *    sent from here, not posted by the browser, so that a post that fails
 *    can be caught and said in the form with everything typed still in it.
 *    The answer is drawn by layer 1, exactly as a posted one would be.
 *
 * The whole-form message (`state.error`) is the server's for a refusal, and
 * the script's own for the two things only it can know: that no answer came,
 * and that the form on screen is no longer the one the workspace asks for.
 */

const LABELS: Record<Exclude<ApplyField, 'consent'>, string> = {
  name: 'Full name',
  email: 'Email',
  phone: 'Phone',
  cv_url: 'CV link',
  cover_letter: 'Cover letter',
  portfolio_url: 'Portfolio link',
  expected_salary: 'Expected monthly salary',
};

const CV_HELP =
  'Paste a link to your CV, for example Google Drive or LinkedIn. Make sure anyone with the link can view it.';

/** One form to a page, so plain ids: the summary's links point at them. */
const fieldId = (field: ApplyField) => `apply-${field}`;
const errorId = (field: ApplyField) => `${fieldId(field)}-error`;

/** 44px tall with 16px text at every width, so a phone neither misses the tap nor zooms in. */
const CONTROL = 'h-11 text-base md:text-base motion-reduce:transition-none';

const withCommas = (value: number) => value.toLocaleString('en-US');
/** Counted as the check counts a cover letter: trimmed, and by the check's own counter. */
const letterLength = (letter: string) => countCharacters(letter.trim());
/** A text area's line breaks can arrive as two characters; the server counts them as one. */
const oneLineBreak = (value: string) => value.replace(/\r\n?/g, '\n');
/** How long after the finger lifts a press on the send button still counts: until the tap's own events have run. */
const PRESS_LINGER_MS = 400;

/* ---- layer 2: the script --------------------------------------------- */

/** The form's fields as they stand, read the way the action reads a post. */
function typed(formElement: HTMLFormElement): ApplyValues {
  const data = new FormData(formElement);
  const text = (field: Exclude<ApplyField, 'consent'>) => {
    const value = data.get(field);
    return typeof value === 'string' ? oneLineBreak(value) : '';
  };
  return {
    name: text('name'), email: text('email'), phone: text('phone'), cv_url: text('cv_url'),
    cover_letter: text('cover_letter'), portfolio_url: text('portfolio_url'),
    expected_salary: text('expected_salary'),
    consent: data.get('consent') === 'on',
  };
}

type Action = (prev: ApplyState, formData: FormData) => Promise<ApplyState>;

/**
 * Sends the form from the script and keeps the answer. The action is called
 * as a function, not through the form's `action`: a call made that way cannot
 * be caught (a failure replaces the whole page with an error screen), and
 * when it finishes React resets the form. Called from a submit handler that
 * has stopped the browser's own post, neither happens: a failure is caught
 * here, and no field is touched.
 *
 * One answer needs more than showing: a problem with a field this form does
 * not have. The workspace started asking for it after the page was loaded.
 * The page is fetched again, which brings the form as it is now (the fields
 * already here stay as they are, with what was typed), and the answer is
 * kept with a line saying so. Its problem appears under the new field as
 * soon as that field does.
 */
function useSending(action: Action, form: ApplicationFormValues) {
  const router = useRouter();
  const [answer, setAnswer] = useState<ApplyState>(undefined);
  const [pending, startSending] = useTransition();

  /** `values` is what the form holds, to show again if no answer comes. `settled` runs once it is over, either way. */
  const send = (formData: FormData, values: ApplyValues, settled: () => void) => {
    startSending(async () => {
      try {
        // The previous answer is not sent back: the action ignores it, and it holds what was typed.
        const next = await action(undefined, formData);
        if (isStaleForm(next?.errors ?? {}, shownFields(form))) {
          router.refresh();
          setAnswer({ ...next, error: APPLY_MESSAGES.formChanged });
        } else {
          setAnswer(next ?? { error: APPLY_MESSAGES.failed, values });
        }
      } catch {
        // No connection, a page older than the site, a post too large: nothing is known but that no answer came.
        setAnswer({ error: APPLY_MESSAGES.unreachable, values });
      } finally {
        settled();
      }
    });
  };

  return { answer, pending, send };
}

type Checks = {
  /** The server's answer these checks were made after. A newer answer replaces them. */
  after: ApplyState;
  errors: ApplyErrors;
  /** True once the whole form has been checked, which is when the summary appears. */
  summarised: boolean;
  /** True once the visitor has tried again, which retires the server's whole-form message. */
  retried: boolean;
};

/** Before the browser has checked anything, the server's answer is the whole story. */
const fromServer = (state: ApplyState): Checks => ({
  after: state, errors: state?.errors ?? {}, summarised: Boolean(state?.errors), retried: false,
});

/**
 * The problems to show and the handlers that find them. Until a handler runs,
 * this returns exactly what the server answered.
 */
function useLiveChecks(
  state: ApplyState,
  form: ApplicationFormValues,
  send: (formData: FormData, values: ApplyValues, settled: () => void) => void,
) {
  const [checks, setChecks] = useState<Checks | null>(null);
  const live = checks && checks.after === state ? checks : fromServer(state);
  /** True from the moment the form is sent until the answer, or the failure, comes back. */
  const sending = useRef(false);
  /** The field to move to once the page has been redrawn with its problems. */
  const wanted = useRef<ApplyField | null>(null);
  /** True while the send button is being pressed, which a phone does not always show by moving focus to it. */
  const pressing = useRef(false);
  const letGo = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The server answered: sending is over, and its first problem takes focus.
  useEffect(() => {
    sending.current = false;
    const errors = state?.errors;
    const first = errors ? shownFields(form).find((field) => errors[field]) : undefined;
    if (first) document.getElementById(fieldId(first))?.focus();
  }, [state, form]);

  // The browser stopped a post: after the summary is drawn, so the field is scrolled to where it ends up.
  useEffect(() => {
    if (!wanted.current) return;
    document.getElementById(fieldId(wanted.current))?.focus();
    wanted.current = null;
  });

  const check = (field: ApplyField, formElement: HTMLFormElement) => {
    const problem = fieldProblem(field, typed(formElement), form);
    setChecks((previous) => {
      const base = previous && previous.after === state ? previous : fromServer(state);
      const errors = { ...base.errors };
      if (problem) errors[field] = problem;
      else delete errors[field];
      return { ...base, errors };
    });
  };

  /** Leaving a field checks that field. Typing in it does not. */
  const onBlur = (event: FocusEvent<HTMLFormElement>) => {
    const name = (event.target as { name?: unknown }).name;
    const field = shownFields(form).find((shown) => shown === name);
    if (!field) return;
    // Going to the button: it checks every field itself, and a message drawn now could move it from under the tap.
    const next = event.relatedTarget;
    if (next instanceof HTMLButtonElement && next.type === 'submit') return;
    // The same, where the tapped button took no focus and so cannot be seen above. One check is skipped, no more.
    if (pressing.current) {
      pressing.current = false;
      return;
    }
    check(field, event.currentTarget);
  };

  const released = () => {
    clearTimeout(letGo.current);
    pressing.current = false;
  };
  /** For the send button: lets `onBlur` know a press on it is under way. */
  const press = {
    onPointerDown: () => {
      clearTimeout(letGo.current);
      pressing.current = true;
    },
    // A touch screen moves focus only after the finger has lifted, so the press outlives the lift by a moment.
    onPointerUp: () => {
      clearTimeout(letGo.current);
      letGo.current = setTimeout(released, PRESS_LINGER_MS);
    },
    onPointerCancel: released,
    onClick: released,
  };

  /** Ticking the box answers its message at once: there is nothing more to leave it for. */
  const onConsentChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.currentTarget.checked && event.currentTarget.form) check('consent', event.currentTarget.form);
  };

  /**
   * Sending checks everything. Any problem stops it; none sends the form, once.
   * The browser's own post is always stopped: this handler only runs with the
   * script, and with the script the form is sent from here.
   */
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sending.current) return;
    const values = typed(event.currentTarget);
    const errors = applyProblems(values, form);
    const first = shownFields(form).find((field) => errors[field]);
    setChecks({ after: state, errors, summarised: true, retried: true });
    if (first) {
      wanted.current = first;
      return;
    }
    sending.current = true;
    send(new FormData(event.currentTarget), values, () => {
      sending.current = false;
    });
  };

  /** A summary link goes to its field and puts the cursor in it. Without the script it only scrolls there. */
  const goTo = (field: ApplyField) => (event: MouseEvent<HTMLAnchorElement>) => {
    const target = document.getElementById(fieldId(field));
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  return {
    errors: live.errors,
    summarised: live.summarised,
    /** The server's message about the whole application, until the visitor tries again. */
    notice: live.retried ? undefined : state?.error,
    onBlur, onConsentChange, onSubmit, goTo, press,
  };
}

/* ---- layer 1: what the server answered ------------------------------- */

/** The message shown in place of the form, for both end states. */
function Outcome({ title, children }: { title?: string; children: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // The form is gone, so the message takes focus and is read out.
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      className="space-y-2 rounded-xl border bg-card p-4 text-card-foreground shadow-sm outline-none"
    >
      {title ? <h3 className="text-lg font-semibold tracking-tight">{title}</h3> : null}
      <p className="text-base leading-relaxed break-words">{children}</p>
    </div>
  );
}

/** A required field's asterisk, or the word that says a field can be left empty. */
function Mark({ required }: { required: boolean }) {
  return required ? (
    <span aria-hidden="true" className="text-destructive">*</span>
  ) : (
    <span className="font-normal text-muted-foreground">(optional)</span>
  );
}

function Problem({ field, children }: { field: ApplyField; children: string | undefined }) {
  if (!children) return null;
  return (
    <p id={errorId(field)} role="alert" className="text-sm font-medium break-words text-destructive">
      {children}
    </p>
  );
}

function Field({ field, form, children }: { field: Exclude<ApplyField, 'consent'>; form: ApplicationFormValues; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={fieldId(field)} className="flex-wrap leading-normal">
        {LABELS[field]}
        <Mark required={isRequired(field, form)} />
      </Label>
      {children}
    </div>
  );
}

/**
 * The apply form for one job. Works as a plain form post without JavaScript;
 * with it, the page is not reloaded, problems are found before sending, and a
 * post that fails leaves the form as it was.
 */
export function ApplyForm({
  action,
  form,
  orgName,
}: {
  /** The submit action, already tied to this workspace and job. */
  action: Action;
  /** What this workspace's form asks for. Decides what is shown; the action decides for itself what is required. */
  form: ApplicationFormValues;
  orgName: string;
}) {
  // Without the script: the browser posts the form and the page comes back with the answer in `posted`.
  const [posted, formAction, posting] = useActionState<ApplyState, FormData>(action, undefined);
  // With it: the form is sent from the submit handler, and the answer is kept here.
  const sent = useSending(action, form);
  /** The last answer, however it came. Everything below is drawn from it alone. */
  const state = sent.answer ?? posted;
  const pending = posting || sent.pending;
  const values = state?.values;
  const {
    errors, summarised, notice, onBlur, onConsentChange, onSubmit, goTo, press,
  } = useLiveChecks(state, form, sent.send);
  /** Null until the visitor types in the cover letter; until then the count is of what the server sent back. */
  const [letterCount, setLetterCount] = useState<number | null>(null);

  if (state?.done) {
    const { firstName } = state.done;
    return (
      <Outcome title="Application sent">
        {`${firstName ? `Thanks, ${firstName}.` : 'Thanks.'} ${orgName} has your details and will be in touch if there's a match.`}
      </Outcome>
    );
  }
  if (state?.closed) return <Outcome>{APPLY_MESSAGES.closed}</Outcome>;

  const shown = shownFields(form);
  /** A problem with a field this form does not have cannot be shown here; `useSending` fetches the form that has it. */
  const problems = shown.filter((field) => errors[field]);
  const counted = letterCount ?? letterLength(values?.cover_letter ?? '');

  /** What every field's input shares: its name, whether it is required, and its message when it has one. */
  const wiring = (field: ApplyField, ...described: string[]) => {
    const required = isRequired(field, form);
    const ids = errors[field] ? [...described, errorId(field)] : described;
    return {
      id: fieldId(field),
      name: field,
      required: required || undefined,
      'aria-required': required ? (true as const) : undefined,
      'aria-invalid': errors[field] ? (true as const) : undefined,
      'aria-describedby': ids.length > 0 ? ids.join(' ') : undefined,
    };
  };

  const fields: Record<ApplyField, () => ReactNode> = {
    name: () => (
      <Field field="name" form={form}>
        <Input {...wiring('name')} autoComplete="name" defaultValue={values?.name} className={CONTROL} />
        <Problem field="name">{errors.name}</Problem>
      </Field>
    ),
    email: () => (
      <Field field="email" form={form}>
        <Input
          {...wiring('email')}
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          defaultValue={values?.email}
          className={CONTROL}
        />
        <Problem field="email">{errors.email}</Problem>
      </Field>
    ),
    phone: () => (
      <Field field="phone" form={form}>
        <Input {...wiring('phone')} type="tel" autoComplete="tel" defaultValue={values?.phone} className={CONTROL} />
        <Problem field="phone">{errors.phone}</Problem>
      </Field>
    ),
    cv_url: () => (
      <Field field="cv_url" form={form}>
        <Input
          {...wiring('cv_url', `${fieldId('cv_url')}-help`)}
          type="url"
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
          defaultValue={values?.cv_url}
          className={CONTROL}
        />
        <p id={`${fieldId('cv_url')}-help`} className="text-sm text-muted-foreground">{CV_HELP}</p>
        <Problem field="cv_url">{errors.cv_url}</Problem>
      </Field>
    ),
    cover_letter: () => (
      <Field field="cover_letter" form={form}>
        <Textarea
          {...wiring('cover_letter', `${fieldId('cover_letter')}-count`)}
          rows={6}
          defaultValue={values?.cover_letter}
          onChange={(event) => setLetterCount(letterLength(event.currentTarget.value))}
          className="min-h-32 text-base md:text-base motion-reduce:transition-none"
        />
        <p
          // Tied to the field, so it is read with it. Not a live region: that would speak at every pause in typing.
          id={`${fieldId('cover_letter')}-count`}
          className={`text-sm tabular-nums ${counted > APPLY_LIMITS.cover_letter ? 'font-medium text-destructive' : 'text-muted-foreground'}`}
        >
          {`${withCommas(counted)} / ${withCommas(APPLY_LIMITS.cover_letter)}`}
        </p>
        <Problem field="cover_letter">{errors.cover_letter}</Problem>
      </Field>
    ),
    portfolio_url: () => (
      <Field field="portfolio_url" form={form}>
        <Input
          {...wiring('portfolio_url')}
          type="url"
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
          defaultValue={values?.portfolio_url}
          className={CONTROL}
        />
        <Problem field="portfolio_url">{errors.portfolio_url}</Problem>
      </Field>
    ),
    expected_salary: () => (
      <Field field="expected_salary" form={form}>
        <div className="flex items-center gap-2">
          <span id={`${fieldId('expected_salary')}-unit`} className="shrink-0 text-base text-muted-foreground">RM</span>
          <Input
            {...wiring('expected_salary', `${fieldId('expected_salary')}-unit`, `${fieldId('expected_salary')}-period`)}
            // Ringgit as typed: the server turns it into sen.
            type="text"
            inputMode="decimal"
            defaultValue={values?.expected_salary}
            className={`${CONTROL} flex-1`}
          />
          <span id={`${fieldId('expected_salary')}-period`} className="shrink-0 text-base text-muted-foreground">a month</span>
        </div>
        <Problem field="expected_salary">{errors.expected_salary}</Problem>
      </Field>
    ),
    consent: () => (
      <div className="space-y-1">
        {/* The box and its whole sentence are one label, so the tap area is the full row. */}
        <label
          htmlFor={fieldId('consent')}
          className="flex min-h-11 cursor-pointer items-start gap-3 py-2 text-sm leading-relaxed"
        >
          <input
            {...wiring('consent')}
            // A native box with no value of its own: ticked, it posts "on" with or without a script.
            type="checkbox"
            defaultChecked={values?.consent === true}
            onChange={onConsentChange}
            className={`mt-0.5 size-5 shrink-0 rounded-sm accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${CAREERS_LINK_FOCUS}`}
          />
          <span className="min-w-0 break-words">
            I agree that {orgName} may store and use the details I&apos;ve given to consider me for this role, and
            that they are processed through OpenKuasa. <Mark required />
          </span>
        </label>
        <Problem field="consent">{errors.consent}</Problem>
        <p className="text-sm">
          <a
            href="/privacy"
            target="_blank"
            rel="noopener"
            className={`inline-flex min-h-11 items-center rounded-sm font-medium underline underline-offset-4 ${CAREERS_LINK_FOCUS}`}
          >
            Privacy
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      </div>
    ),
  };

  return (
    // The server and the checks above word every message, so the browser's
    // own checks are switched off rather than shown in a second voice.
    <form action={formAction} noValidate onBlur={onBlur} onSubmit={onSubmit} className="space-y-5">
      {summarised && problems.length > 0 ? (
        <div
          role="group"
          aria-labelledby="apply-summary"
          className="rounded-xl border border-destructive/50 bg-destructive/10 p-4"
        >
          <h3 id="apply-summary" className="font-semibold">
            {problems.length === 1 ? '1 thing needs fixing' : `${problems.length} things need fixing`}
          </h3>
          <ul className="mt-1 list-disc pl-5">
            {problems.map((field) => (
              <li key={field}>
                <a
                  href={`#${fieldId(field)}`}
                  onClick={goTo(field)}
                  className={`inline-flex min-h-11 items-center rounded-sm font-medium break-words underline underline-offset-4 ${CAREERS_LINK_FOCUS}`}
                >
                  {errors[field]}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-sm text-muted-foreground">* Required</p>

      {shown.map((field) => (
        <div key={field}>{fields[field]()}</div>
      ))}

      {/*
        Not for people: off screen, out of the tab order and hidden from screen
        readers, but still in the page, where a script that fills in every
        field gives itself away.
      */}
      <div aria-hidden="true" className="absolute -left-[9999px] top-auto size-px overflow-hidden">
        <label htmlFor="apply-extra">Leave this field empty</label>
        <input id="apply-extra" name={APPLY_HONEYPOT} type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>

      {notice ? (
        <p role="alert" className="text-sm font-medium break-words text-destructive">
          {notice}
        </p>
      ) : null}

      <Button
        {...press}
        type="submit"
        size="lg"
        disabled={pending}
        className="h-11 w-full text-base motion-reduce:transition-none"
      >
        {pending ? 'Sending…' : 'Send application'}
      </Button>
    </form>
  );
}
