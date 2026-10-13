'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import { todayInMalaysia } from '@/lib/people/dates';
import {
  type OvertimeFormInput,
  type OvertimeFormValues,
  type OvertimePreviewFormInput,
  overtimeFormDefaults,
  overtimePreviewLines,
  toOvertimeInput,
  toOvertimePreviewInput,
} from '@/lib/people/overtime-forms';
import type { OvertimePreview } from '@/lib/people/pay-requests';

const PREVIEW_DELAY_MS = 300;
const PREVIEW_FAILED = 'The amount could not be worked out here. It will be worked out when you submit.';

/**
 * The form for recording overtime. It knows nothing about whose overtime it
 * is: the screen around it supplies the employee, and remounts the form (with
 * a `key`) when that changes. The preview runs as the date and hours change and
 * only informs; a failed preview never blocks submitting.
 */
export function OvertimeForm({
  disabled,
  error,
  onPreview,
  onSubmit,
  onCancel,
}: {
  disabled: boolean;
  /** What the server said about the last attempt. */
  error: string | null;
  onPreview: (input: OvertimePreviewFormInput) => Promise<CapResult<OvertimePreview>>;
  onSubmit: (input: OvertimeFormInput) => void;
  onCancel: () => void;
}) {
  const [today] = useState(() => todayInMalaysia(new Date()));
  const [values, setValues] = useState<OvertimeFormValues>(() => overtimeFormDefaults(today));
  const [invalid, setInvalid] = useState<string | null>(null);
  const [settled, setSettled] = useState<{ key: string; result: CapResult<OvertimePreview> } | null>(null);

  const previewInput = toOvertimePreviewInput(values, today);
  const key = previewInput ? JSON.stringify(previewInput) : null;
  const latest = useRef(onPreview);
  useEffect(() => {
    latest.current = onPreview;
  });

  useEffect(() => {
    if (!key) return;
    let current = true;
    const timer = setTimeout(async () => {
      let result: CapResult<OvertimePreview>;
      try {
        result = await latest.current(JSON.parse(key) as OvertimePreviewFormInput);
      } catch {
        result = { ok: false, error: WRITE_FAILED };
      }
      if (current) setSettled({ key, result });
    }, PREVIEW_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [key]);

  const set = <K extends keyof OvertimeFormValues>(field: K, value: OvertimeFormValues[K]) => {
    setInvalid(null);
    setValues((state) => ({ ...state, [field]: value }));
  };

  const shown = key !== null && settled?.key === key ? settled.result : null;
  const lines = shown?.ok ? overtimePreviewLines(shown.data) : null;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const result = toOvertimeInput(values, today);
        setInvalid(result.ok ? null : result.error);
        if (result.ok) onSubmit(result.input);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date worked">
          <Input
            aria-label="Date worked"
            type="date"
            required
            max={today}
            disabled={disabled}
            value={values.work_date}
            onChange={(event) => set('work_date', event.target.value)}
          />
        </Field>
        <Field label="Hours">
          <Input
            aria-label="Hours"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="2.5"
            required
            disabled={disabled}
            value={values.hours}
            onChange={(event) => set('hours', event.target.value)}
          />
        </Field>
      </div>

      <Field label="Reason (optional)">
        <Input
          aria-label="Reason"
          type="text"
          maxLength={500}
          disabled={disabled}
          value={values.reason}
          onChange={(event) => set('reason', event.target.value)}
        />
      </Field>

      <div role="status" aria-live="polite" className="min-h-5 space-y-1 text-sm">
        {key !== null && shown === null ? <p className="text-muted-foreground">Working out the pay…</p> : null}
        {shown && !shown.ok ? (
          <p className="text-muted-foreground">{shown.error === WRITE_FAILED ? PREVIEW_FAILED : shown.error}</p>
        ) : null}
        {lines ? (
          <>
            <p className="font-medium">
              {lines.kind}: {lines.amount}
            </p>
            {lines.note ? <p className="text-muted-foreground">{lines.note}</p> : null}
          </>
        ) : null}
      </div>

      {invalid || error ? (
        <p role="alert" className="text-sm text-destructive">
          {invalid ?? error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={disabled}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={disabled}>
          Submit overtime
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
