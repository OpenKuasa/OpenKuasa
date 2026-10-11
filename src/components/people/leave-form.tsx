'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import type { LeavePreview } from '@/lib/people/leave';
import {
  LEAVE_FORM_DEFAULTS,
  type LeaveFormInput,
  type LeaveFormValues,
  type LeavePreviewFormInput,
  previewLines,
  toLeaveInput,
  toPreviewInput,
} from '@/lib/people/leave-forms';
import { leaveLabel } from '@/lib/people/overview';
import type { LeaveType } from '@/lib/people/types';

const LEAVE_TYPES: LeaveType[] = ['annual', 'medical', 'emergency', 'unpaid', 'maternity', 'paternity'];
const PREVIEW_DELAY_MS = 300;
const PREVIEW_FAILED = 'The day count could not be worked out here. It will be counted when you submit.';

/**
 * The form for applying for leave. It knows nothing about whose leave it is:
 * the screen around it supplies the employee. The preview runs as the dates
 * change and only informs; a failed preview never blocks submitting.
 */
export function LeaveForm({
  disabled,
  error,
  onPreview,
  onSubmit,
  onCancel,
}: {
  disabled: boolean;
  /** What the server said about the last attempt. */
  error: string | null;
  onPreview: (input: LeavePreviewFormInput) => Promise<CapResult<LeavePreview>>;
  onSubmit: (input: LeaveFormInput) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<LeaveFormValues>(LEAVE_FORM_DEFAULTS);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [settled, setSettled] = useState<{ key: string; result: CapResult<LeavePreview> } | null>(null);

  const previewInput = toPreviewInput(values);
  const key = previewInput ? JSON.stringify(previewInput) : null;
  const latest = useRef(onPreview);
  useEffect(() => {
    latest.current = onPreview;
  });

  useEffect(() => {
    if (!key) return;
    let current = true;
    const timer = setTimeout(async () => {
      let result: CapResult<LeavePreview>;
      try {
        result = await latest.current(JSON.parse(key) as LeavePreviewFormInput);
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

  const set = <K extends keyof LeaveFormValues>(field: K, value: LeaveFormValues[K]) => {
    setInvalid(null);
    setValues((state) => ({ ...state, [field]: value }));
  };

  const shown = key !== null && settled?.key === key ? settled.result : null;
  const lines = shown?.ok ? previewLines(shown.data) : null;
  const single = values.start_date !== '' && values.start_date === values.end_date;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const result = toLeaveInput(values);
        setInvalid(result.ok ? null : result.error);
        if (result.ok) onSubmit(result.input);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Type of leave">
          <Select value={values.leave_type} disabled={disabled} onValueChange={(value) => set('leave_type', value as LeaveType)}>
            <SelectTrigger aria-label="Type of leave" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEAVE_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {leaveLabel(type)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="First day">
          <Input
            aria-label="First day"
            type="date"
            required
            disabled={disabled}
            value={values.start_date}
            onChange={(event) => {
              const start = event.target.value;
              setInvalid(null);
              // A later last day than the first is the common case; keep the last day from falling behind.
              setValues((state) => ({ ...state, start_date: start, end_date: state.end_date < start ? start : state.end_date }));
            }}
          />
        </Field>
        <Field label="Last day">
          <Input
            aria-label="Last day"
            type="date"
            required
            disabled={disabled}
            min={values.start_date || undefined}
            value={values.end_date}
            onChange={(event) => set('end_date', event.target.value)}
          />
        </Field>
      </div>

      {single ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            disabled={disabled}
            checked={values.half_day}
            onChange={(event) => set('half_day', event.target.checked)}
          />
          Half a day
        </label>
      ) : null}

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
        {key !== null && shown === null ? <p className="text-muted-foreground">Counting the days…</p> : null}
        {shown && !shown.ok ? (
          <p className="text-muted-foreground">{shown.error === WRITE_FAILED ? PREVIEW_FAILED : shown.error}</p>
        ) : null}
        {lines ? (
          <>
            <p className="font-medium">{lines.days}</p>
            {lines.balance.map((line) => (
              <p key={line} className="text-muted-foreground">
                {line}
              </p>
            ))}
            {lines.warning ? <p className="text-amber-700 dark:text-amber-400">{lines.warning}</p> : null}
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
          Apply for leave
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
