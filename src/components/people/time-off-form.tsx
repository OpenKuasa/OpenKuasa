'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  TIME_OFF_FORM_DEFAULTS,
  type TimeOffFormInput,
  type TimeOffFormValues,
  toTimeOffInput,
} from '@/lib/people/time-off-forms';

/**
 * The form for asking for a few hours off. It knows nothing about whose
 * time-off it is: the server takes the employee from the session.
 */
export function TimeOffForm({
  disabled,
  error,
  onSubmit,
  onCancel,
}: {
  disabled: boolean;
  /** What the server said about the last attempt. */
  error: string | null;
  onSubmit: (input: TimeOffFormInput) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<TimeOffFormValues>(TIME_OFF_FORM_DEFAULTS);
  const [invalid, setInvalid] = useState<string | null>(null);

  const set = <K extends keyof TimeOffFormValues>(field: K, value: TimeOffFormValues[K]) =>
    setValues((state) => ({ ...state, [field]: value }));

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const result = toTimeOffInput(values);
        setInvalid(result.ok ? null : result.error);
        if (result.ok) onSubmit(result.input);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Day">
          <Input
            aria-label="Day"
            type="date"
            required
            disabled={disabled}
            value={values.off_date}
            onChange={(event) => set('off_date', event.target.value)}
          />
        </Field>
        <Field label="From">
          <Input
            aria-label="From"
            type="time"
            required
            disabled={disabled}
            value={values.start_time}
            onChange={(event) => set('start_time', event.target.value)}
          />
        </Field>
        <Field label="To">
          <Input
            aria-label="To"
            type="time"
            required
            disabled={disabled}
            value={values.end_time}
            onChange={(event) => set('end_time', event.target.value)}
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
          Request time-off
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
