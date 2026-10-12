'use client';

import { useEffect, useId, useState, useTransition } from 'react';
import { updateApplicationFormAction } from '@/app/(app)/hire/actions';
import {
  APPLICATION_FORM_FIELDS,
  APPLICATION_FORM_KEYS,
  applicationFormOf,
  changedSwitches,
  takeSaved,
  type ApplicationFormKey,
  type ApplicationFormValues,
} from '@/lib/hire/application-form';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

// The same words and look as the product's other client screens (see careers-controls.tsx).
const NOT_SENT = 'That change could not be sent. Check your connection and try again.';
const ALERT_CLASS =
  'rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive';
/** 44 pixels of hit area on every button. */
const TARGET = 'min-h-11 min-w-11';
const NO_PERMISSION = 'You do not have permission to change this';
const DEMO_ONLY = 'Not available in the demo';

/** Who is looking: someone who may change the form, someone who may only read it, or a demo visitor. */
export type ApplicationFormMode = 'edit' | 'view' | 'demo';

/** What the demo's sample screen has always shown. Nothing here is saved anywhere. */
const DEMO_SAMPLE: ApplicationFormValues = {
  require_cv: true, require_cover_letter: false, ask_portfolio: true, ask_expected_salary: true,
};

/**
 * The Settings screen's "Application form" card: the four switches that decide
 * what the public apply form asks for. Toggling changes nothing until Save.
 */
export function ApplicationFormCard({
  saved,
  mode,
}: {
  /** The workspace's saved switches. */
  saved: ApplicationFormValues;
  mode: ApplicationFormMode;
}) {
  const [pending, start] = useTransition();
  /** What is saved, as far as this card knows: the server's values, then each save's result. */
  const [baseline, setBaseline] = useState<ApplicationFormValues>(mode === 'demo' ? DEMO_SAMPLE : saved);
  const [values, setValues] = useState<ApplicationFormValues>(baseline);
  /** The last `saved` this card took in, to notice when the server sends a newer one. */
  const [known, setKnown] = useState(saved);
  // The assistant, or someone else, can change a switch while this screen is open: the screen
  // is refreshed and `saved` arrives changed. Show it, keeping any switch the user has
  // changed and not saved. (Adjusting state while rendering, as the branding form does.)
  if (mode !== 'demo' && APPLICATION_FORM_KEYS.some((key) => saved[key] !== known[key])) {
    setKnown(saved);
    setValues(takeSaved(baseline, values, saved));
    setBaseline(saved);
  }
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const base = useId();

  const canEdit = mode === 'edit';
  const changes = changedSwitches(baseline, values);
  const dirty = canEdit && Object.keys(changes).length > 0;

  // Closing or reloading the tab with unsaved switches asks first. Moving to another screen
  // inside the app cannot be intercepted reliably in this Next.js version: there the
  // "Unsaved changes" words beside Save are the guard.
  useEffect(() => {
    if (!dirty) return;
    const ask = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [dirty]);

  function toggle(key: ApplicationFormKey, next: boolean) {
    setValues((current) => ({ ...current, [key]: next }));
    setNotice(null);
  }

  /** Sends only the switches that differ from what is saved. Also what "Try again" runs. */
  function save() {
    if (!dirty || pending) return;
    // Cleared first, so the same message twice in a row is announced twice.
    setNotice(null);
    setError(null);
    start(async () => {
      try {
        const result = await updateApplicationFormAction(changes);
        if (result.ok) {
          const next = applicationFormOf(result.data);
          setBaseline(next);
          setValues(next);
          setNotice('Application form saved.');
        } else {
          // The switches keep what was chosen, so the same change can be sent again.
          setError(result.error);
        }
      } catch {
        setError(NOT_SENT);
      }
    });
  }

  function discard() {
    setValues(baseline);
    setError(null);
    setNotice(null);
  }

  const reason = mode === 'demo' ? DEMO_ONLY : mode === 'view' ? NO_PERMISSION : null;
  const reasonId = `${base}-reason`;

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="divide-y">
        {APPLICATION_FORM_KEYS.map((key) => {
          const field = APPLICATION_FORM_FIELDS[key];
          const id = `${base}-${key}`;
          const helpId = `${id}-help`;
          return (
            <div key={key} className="flex min-h-11 items-center justify-between gap-4 py-2">
              <div className="min-w-0">
                <Label htmlFor={id} className="font-medium">
                  {field.label}
                </Label>
                <p id={helpId} className="text-xs text-muted-foreground">
                  {field.help}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {/* The state in words: not shown by colour alone. The switch itself carries aria-checked. */}
                <span className="w-7 text-right text-sm font-semibold tabular-nums" aria-hidden="true">
                  {values[key] ? 'On' : 'Off'}
                </span>
                <Switch
                  id={id}
                  // 44 pixels of hit area around an 18 pixel switch.
                  className="after:-inset-y-3.5"
                  checked={values[key]}
                  disabled={!canEdit || pending}
                  aria-describedby={reason ? `${helpId} ${reasonId}` : helpId}
                  onCheckedChange={(next) => toggle(key, next)}
                />
              </div>
            </div>
          );
        })}
      </div>

      {reason && (
        <p id={reasonId} className="mt-3 text-xs font-medium text-muted-foreground">
          {reason}
        </p>
      )}
      {mode !== 'demo' && (
        <p className="mt-3 text-xs text-muted-foreground">
          Saved to your workspace. The public apply form follows these switches.
        </p>
      )}

      {error && (
        <div role="alert" className={cn(ALERT_CLASS, 'mt-3 flex flex-wrap items-center justify-between gap-2')}>
          <span>{error}</span>
          <Button type="button" variant="outline" size="sm" className={TARGET} disabled={pending} onClick={save}>
            Try again
          </Button>
        </div>
      )}

      {canEdit && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {dirty && <span className="mr-auto text-sm font-medium">Unsaved changes</span>}
          {dirty && (
            <Button type="button" variant="outline" size="sm" className={TARGET} disabled={pending} onClick={discard}>
              Discard
            </Button>
          )}
          <Button
            type="submit"
            size="sm"
            // Inert, not disabled, when there is nothing to save: it keeps focus through a save.
            aria-disabled={!dirty || pending}
            className={cn(TARGET, (!dirty || pending) && 'cursor-not-allowed opacity-50')}
          >
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}

      {/* Always in the page, so a change to its text is announced. It never takes focus. */}
      <p aria-live="polite" className={cn('mt-2 text-sm text-muted-foreground', !notice && 'sr-only')}>
        {notice}
      </p>
    </form>
  );
}
