'use client';

import { useId, useState, useTransition } from 'react';
import { saveAttendanceSettingsAction } from '@/app/(app)/people/attendance-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toSettingsInput } from '@/lib/people/attendance-forms';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import { type Weekday, WEEKDAYS } from '@/lib/people/types';

const DAY_NAME: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

/**
 * The work week (seven day checkboxes in a labelled group, so the keyboard and a screen reader get each day's
 * name and whether it is on), the start time and the grace period, with Save. A demo visitor sees it disabled.
 */
export function AttendanceSettingsForm({
  initial,
  disabled,
}: {
  initial: { work_week: Weekday[]; work_start_time: string; late_grace_minutes: number };
  disabled: boolean;
}) {
  const [week, setWeek] = useState<Weekday[]>(initial.work_week);
  const [start, setStart] = useState(initial.work_start_time);
  const [grace, setGrace] = useState(String(initial.late_grace_minutes));
  const [pending, run] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const ids = useId();
  const off = disabled || pending;

  const touch = () => {
    setSaved(false);
    setError(null);
  };

  function submit() {
    const converted = toSettingsInput({ work_week: week, work_start_time: start, late_grace_minutes: grace });
    if (!converted.ok) {
      setSaved(false);
      setError(converted.error);
      return;
    }
    setError(null);
    run(async () => {
      let result: CapResult<unknown>;
      try {
        result = await saveAttendanceSettingsAction(converted.input);
      } catch {
        result = { ok: false, error: WRITE_FAILED };
      }
      if (result.ok) setSaved(true);
      else setError(result.error);
    });
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <fieldset className="space-y-2" disabled={off}>
        <legend className="mb-1 text-sm font-medium">Working days</legend>
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map((day) => {
            const on = week.includes(day);
            return (
              <label
                key={day}
                className="flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
              >
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--primary)]"
                  checked={on}
                  onChange={() => {
                    touch();
                    setWeek((current) => (on ? current.filter((d) => d !== day) : [...current, day]));
                  }}
                />
                <span>{DAY_NAME[day]}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm" htmlFor={`${ids}-start`}>
          Start time
          <Input
            id={`${ids}-start`}
            type="time"
            required
            disabled={off}
            value={start}
            onChange={(event) => {
              touch();
              setStart(event.target.value);
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm" htmlFor={`${ids}-grace`}>
          Grace period (minutes)
          <Input
            id={`${ids}-grace`}
            type="number"
            inputMode="numeric"
            min={0}
            max={240}
            step={1}
            required
            disabled={off}
            value={grace}
            onChange={(event) => {
              touch();
              setGrace(event.target.value);
            }}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={off}>
          Save
        </Button>
        <span className="text-xs text-muted-foreground">Applies from the next clock-in.</span>
        <span role="status" className="text-xs font-medium text-emerald-600">
          {saved ? 'Saved.' : ''}
        </span>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
