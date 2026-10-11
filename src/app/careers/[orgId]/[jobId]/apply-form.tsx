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
  APPLY_HONEYPOT, APPLY_LIMITS, APPLY_MESSAGES, CV_FILE_FIELD, applyProblems, chosenFile, countCharacters,
  cvFileProblem, fieldProblem, fileSizeLabel, isRequired, isStaleForm, shownFields,
  type ApplyErrors, type ApplyField, type ApplyValues, type CvFileInfo,
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
 *
 * The CV is one group of two inputs, a PDF to upload or a link to paste, and
 * either one meets a required CV. The file input is not one of the form's
 * fields (`APPLY_FIELDS`): it sits in the group, in front of the link, and its
 * problem is reported there. The form posts as `multipart/form-data` in both
 * layers with nothing set here: React writes that encoding itself for a form
 * whose `action` is a server function, and the script sends the same
 * `FormData`, file included. A file cannot be put back into a form the server
 * draws again, so layer 1 says when one has to be chosen again; layer 2 never
 * loses it, because a form sent from the script is not reset.
 */

const LABELS: Record<Exclude<ApplyField, 'consent'>, string> = {
  name: 'Full name',
  email: 'Email',
  phone: 'Phone',
  cv_url: 'Link to your CV',
  cover_letter: 'Cover letter',
  portfolio_url: 'Portfolio link',
  expected_salary: 'Expected monthly salary',
};

const CV_HELP =
  'Paste a link to your CV, for example Google Drive or LinkedIn. Make sure anyone with the link can view it.';

/** What a problem can be about: one of the form's fields, or the file in the CV group. */
type ProblemKey = ApplyField | typeof CV_FILE_FIELD;

/** One form to a page, so plain ids: the summary's links point at them. */
const fieldId = (field: ProblemKey) => `apply-${field}`;
const errorId = (field: ProblemKey) => `${fieldId(field)}-error`;
/** The CV group's own ids: its helper text, and its problem when a CV is required and there is none. */
const CV_GROUP_HELP = 'apply-cv-help';
const CV_GROUP_ERROR = 'apply-cv-error';

/** Everything with a problem, in the order the form shows it: the file comes where the CV group is, before the link. */
const problemKeys = (errors: ApplyErrors, shown: readonly ApplyField[]): ProblemKey[] =>
  shown
    .flatMap((field): ProblemKey[] => (field === 'cv_url' ? [CV_FILE_FIELD, field] : [field]))
    .filter((key) => errors[key]);

/** True when the CV group's problem is that there is no CV at all, which is neither input's problem alone. */
const isMissingCv = (errors: ApplyErrors) => errors.cv_url === APPLY_MESSAGES.cvRequired;

/**
 * The control a problem's summary link and the focus go to. A missing CV goes
 * to the group's first control, the file input: its message is just above it,
 * and focus there does not open a phone's keyboard over that message.
 */
const controlFor = (key: ProblemKey, errors: ApplyErrors): ProblemKey =>
  key === 'cv_url' && isMissingCv(errors) ? CV_FILE_FIELD : key;

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

/**
 * The file in the form's CV input as it stands, read the way the action reads
 * a post, or null. Only what the rules need of it: its bytes are never read here.
 */
const chosenIn = (formElement: HTMLFormElement): CvFileInfo | null =>
  chosenFile(new FormData(formElement).get(CV_FILE_FIELD));

type Action = (prev: ApplyState, formData: FormData) => Promise<ApplyState>;

/**
 * Sends the form from the script and keeps the answer. The action is called
 * as a function, not through the form's `action`: a call made that way cannot
 * be caught (a failure replaces the whole page with an error screen), and
 * when it finishes React resets the form. Called from a submit handler that
 * has stopped the browser's own post, neither happens: a failure is caught
 * here, and no field is touched: a chosen file stays chosen through a refusal
 * or a failure, to be sent again.
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
  /** The control to move to once the page has been redrawn with its problems. */
  const wanted = useRef<ProblemKey | null>(null);
  /**
   * The file in the CV input, as far as the script has seen: its name and size
   * are shown from here. Null on the server and before a file is chosen.
   */
  const [picked, setPicked] = useState<CvFileInfo | null>(null);
  /**
   * True once the visitor has chosen or removed a file with the script running.
   * From then on the file input is as they left it, and nothing was lost from it.
   */
  const [fileHandled, setFileHandled] = useState(false);
  /** True while the send button is being pressed, which a phone does not always show by moving focus to it. */
  const pressing = useRef(false);
  const letGo = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The server answered: sending is over, and its first problem takes focus.
  useEffect(() => {
    sending.current = false;
    const errors = state?.errors;
    const first = errors ? problemKeys(errors, shownFields(form))[0] : undefined;
    if (errors && first) document.getElementById(fieldId(controlFor(first, errors)))?.focus();
  }, [state, form]);

  // The browser stopped a post: after the summary is drawn, so the field is scrolled to where it ends up.
  useEffect(() => {
    if (!wanted.current) return;
    document.getElementById(fieldId(wanted.current))?.focus();
    wanted.current = null;
  });

  /** Changes the problems on show, starting from the server's when nothing has been checked since it answered. */
  const amend = (change: (errors: ApplyErrors) => void) => {
    setChecks((previous) => {
      const base = previous && previous.after === state ? previous : fromServer(state);
      const errors = { ...base.errors };
      change(errors);
      return { ...base, errors };
    });
  };

  const check = (field: ApplyField, formElement: HTMLFormElement) => {
    // A chosen file meets a required CV, so the link is checked knowing whether there is one.
    const problem = fieldProblem(field, typed(formElement), form, chosenIn(formElement) !== null);
    amend((errors) => {
      if (problem) errors[field] = problem;
      else delete errors[field];
    });
  };

  /**
   * Choosing a file checks it at once, by what it says of itself: there is
   * nothing to leave a file input for. A problem is said under the input and
   * the input keeps focus, to choose again. Any file, good or not, answers
   * "there is no CV".
   */
  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = chosenFile(input.files?.[0]);
    const problem = cvFileProblem(file);
    setPicked(file);
    setFileHandled(true);
    amend((errors) => {
      if (problem) errors[CV_FILE_FIELD] = problem;
      else delete errors[CV_FILE_FIELD];
      if (file && isMissingCv(errors)) delete errors.cv_url;
    });
    // Where the browser's file picker leaves focus differs from one browser to the next.
    input.focus();
  };

  /** Empties the file input, which a visitor cannot do in every browser, and goes back to it. */
  const onRemoveFile = () => {
    const input = document.getElementById(fieldId(CV_FILE_FIELD));
    if (input instanceof HTMLInputElement) input.value = '';
    setPicked(null);
    setFileHandled(true);
    amend((errors) => {
      delete errors[CV_FILE_FIELD];
    });
    // The button is gone with the file: focus must not be left on nothing.
    input?.focus();
  };

  /** Typing a link answers "there is no CV" at once. The link itself is checked on leaving it, like any field. */
  const onLinkChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!isMissingCv(live.errors) || event.currentTarget.value.trim() === '') return;
    amend((errors) => {
      if (isMissingCv(errors)) delete errors.cv_url;
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
    const file = chosenIn(event.currentTarget);
    const errors = applyProblems(values, form, file !== null);
    const fileProblem = cvFileProblem(file);
    if (fileProblem) errors[CV_FILE_FIELD] = fileProblem;
    const first = problemKeys(errors, shownFields(form))[0];
    // The input is the truth: a file chosen before the script was running, or put back by the browser, is seen here.
    setPicked(file);
    setChecks({ after: state, errors, summarised: true, retried: true });
    if (first) {
      wanted.current = controlFor(first, errors);
      return;
    }
    sending.current = true;
    const formData = new FormData(event.currentTarget);
    // An untouched file input stands in the form as an empty, nameless file. It is no file, so it is not sent.
    if (!file) formData.delete(CV_FILE_FIELD);
    send(formData, values, () => {
      sending.current = false;
    });
  };

  /** A summary link goes to its field and puts the cursor in it. Without the script it only scrolls there. */
  const goTo = (field: ProblemKey) => (event: MouseEvent<HTMLAnchorElement>) => {
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
    picked,
    fileHandled,
    onBlur, onConsentChange, onFileChange, onRemoveFile, onLinkChange, onSubmit, goTo, press,
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

function Problem({ field, id, children }: { field?: ProblemKey; id?: string; children: string | undefined }) {
  if (!children) return null;
  return (
    <p id={id ?? (field ? errorId(field) : undefined)} role="alert" className="text-sm font-medium break-words text-destructive">
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
    errors, summarised, notice, picked, fileHandled, onBlur, onConsentChange, onFileChange, onRemoveFile, onLinkChange,
    onSubmit, goTo, press,
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
  const problems = problemKeys(errors, shown);

  /** A CV is required and there is neither a file nor a link: the group's problem, said under its legend. */
  const missingCv = isMissingCv(errors);
  const cvRequired = isRequired('cv_url', form);
  /**
   * The server drew the form again after a post that carried a file, and a
   * form drawn again holds no file. Not said while the input holds one, not
   * once the visitor has chosen or removed a file here (an input they emptied
   * themselves has lost nothing), and not beside a message about the file
   * itself, which already asks for another.
   */
  const chooseAgain = state?.fileDropped === true && !picked && !fileHandled && !errors[CV_FILE_FIELD];
  const fileAgainId = `${fieldId(CV_FILE_FIELD)}-again`;
  const fileHintId = `${fieldId(CV_FILE_FIELD)}-hint`;
  const linkHelpId = `${fieldId('cv_url')}-help`;
  const ids = (...list: (string | false | undefined)[]) => list.filter(Boolean).join(' ');
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
    // The CV group stands where the link always stood: a PDF to upload, or the link. Either one is a CV.
    cv_url: () => (
      <fieldset
        aria-describedby={ids(CV_GROUP_HELP, missingCv && CV_GROUP_ERROR)}
        // A fieldset is by default as wide as its widest word; a long file name must wrap, not widen the page.
        className="min-w-0 space-y-3"
      >
        {/* Plain inline text: a legend laid out as a flex row is not drawn the same in every browser. */}
        <legend className="p-0 text-sm leading-normal font-medium">
          CV <Mark required={cvRequired} />
          {/* Neither input is required alone, so neither can say it: the group's name does. */}
          {cvRequired ? <span className="sr-only">(required)</span> : null}
        </legend>
        <p id={CV_GROUP_HELP} className="text-sm text-muted-foreground">Upload a PDF or paste a link.</p>
        <Problem id={CV_GROUP_ERROR}>{missingCv ? errors.cv_url : undefined}</Problem>

        <div className="space-y-1.5">
          <Label htmlFor={fieldId(CV_FILE_FIELD)} className="flex-wrap leading-normal">Upload a PDF</Label>
          <Input
            // The browser's own file input, in plain sight: it works without the script, takes focus and shows it.
            id={fieldId(CV_FILE_FIELD)}
            name={CV_FILE_FIELD}
            type="file"
            accept="application/pdf,.pdf"
            aria-invalid={errors[CV_FILE_FIELD] ? true : undefined}
            aria-describedby={ids(
              fileHintId,
              errors[CV_FILE_FIELD] && errorId(CV_FILE_FIELD),
              chooseAgain && fileAgainId,
              missingCv && CV_GROUP_ERROR,
            )}
            onChange={onFileChange}
            className={`${CONTROL} cursor-pointer py-1 file:mr-3 file:h-8 file:cursor-pointer file:rounded-md file:border file:border-solid file:border-input file:bg-muted file:px-3`}
          />
          <p id={fileHintId} className="text-sm text-muted-foreground">PDF, up to 5 MB</p>
          <Problem field={CV_FILE_FIELD}>{errors[CV_FILE_FIELD]}</Problem>
          {chooseAgain ? (
            <p id={fileAgainId} role="alert" className="text-sm font-medium break-words text-destructive">
              {APPLY_MESSAGES.cvFileAgain}
            </p>
          ) : null}
          {picked ? (
            <div className="flex items-center gap-3">
              {/* A file name can be one long word: it breaks anywhere rather than push the page sideways. */}
              <p className="min-w-0 flex-1 text-sm break-all">
                {picked.name} <span className="whitespace-nowrap text-muted-foreground">({fileSizeLabel(picked.size)})</span>
              </p>
              <Button
                type="button"
                variant="outline"
                aria-label={`Remove ${picked.name}`}
                onClick={onRemoveFile}
                className="h-11 shrink-0 px-4 text-base motion-reduce:transition-none"
              >
                Remove
              </Button>
            </div>
          ) : null}
        </div>

        <p className="text-sm text-muted-foreground">or</p>

        <div className="space-y-1.5">
          <Label htmlFor={fieldId('cv_url')} className="flex-wrap leading-normal">{LABELS.cv_url}</Label>
          <Input
            id={fieldId('cv_url')}
            name="cv_url"
            type="url"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            defaultValue={values?.cv_url}
            // Wrong only for what is in it. With no CV at all the group is what is wrong, and says so above.
            aria-invalid={errors.cv_url && !missingCv ? true : undefined}
            aria-describedby={ids(linkHelpId, errors.cv_url && (missingCv ? CV_GROUP_ERROR : errorId('cv_url')))}
            onChange={onLinkChange}
            className={CONTROL}
          />
          <p id={linkHelpId} className="text-sm text-muted-foreground">{CV_HELP}</p>
          <Problem field="cv_url">{missingCv ? undefined : errors.cv_url}</Problem>
        </div>
      </fieldset>
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
            I agree that {orgName} may store and use the details I&apos;ve given to consider me for this role,
            that they are processed through OpenKuasa, and that they may be reviewed with the help of an AI assistant, which sends
            them to an AI service provider and may give the employer a recommendation. <Mark required />
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
                  href={`#${fieldId(controlFor(field, errors))}`}
                  onClick={goTo(controlFor(field, errors))}
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
