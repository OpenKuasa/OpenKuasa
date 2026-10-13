'use client';

import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { correctAttendanceAction } from '@/app/(app)/people/attendance-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import { toCorrectionInput } from '@/lib/people/attendance-forms';
import { timeInMalaysia, todayInMalaysia } from '@/lib/people/dates';
import { type CorrectionPrefill, prefillClockOut } from '@/lib/people/team-attendance';
import type { AttendanceStatus } from '@/lib/people/types';
import { RowPrompt, usePromptId } from './request-row';

const STATUSES: { value: AttendanceStatus; label: string }[] = [
  { value: 'present', label: 'Present' },
  { value: 'late', label: 'Late' },
  { value: 'absent', label: 'Absent' },
  { value: 'on_leave', label: 'On leave' },
];

const SELECT_CLASS =
  'h-7 rounded-lg border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

/**
 * "Correct" on one employee's day. It opens the form in the row's own prompt area (as "Mark paid" does): status,
 * clock-in and clock-out (only for present and late), a note, Confirm and Keep. The times are what the owner types,
 * read as Malaysia time by the database; whether a clock-in is late is the database's call, not this form's.
 * A demo visitor sees the button disabled.
 */
export function CorrectAttendance({
  employeeId,
  name,
  workDate,
  prefill,
  disabled,
}: {
  employeeId: string;
  name: string;
  workDate: string;
  prefill: CorrectionPrefill;
  disabled: boolean;
}) {
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AttendanceStatus>(prefill.status);
  const [clockIn, setClockIn] = useState(prefill.clock_in);
  // The row's clock-out is kept, so saving does not erase a real one; blank only when it has none or is still to come.
  const prefillOut = () => prefillClockOut(prefill, workDate, todayInMalaysia(new Date()), timeInMalaysia(new Date()));
  const [clockOut, setClockOut] = useState(prefillOut);
  const [note, setNote] = useState(prefill.note);
  const [error, setError] = useState<string | null>(null);
  const off = disabled || busy;
  const trigger = useRef<HTMLButtonElement>(null);
  const promptId = usePromptId();
  const ids = useId();
  const withTimes = status === 'present' || status === 'late';
  // Focus returns to the button once the prompt has closed and the button is enabled again.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current || busy || open) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [busy, open]);

  const close = () => {
    setOpen(false);
    setError(null);
    refocus.current = true;
  };

  function submit() {
    const converted = toCorrectionInput(
      { employee_id: employeeId, work_date: workDate, status, clock_in: clockIn, clock_out: clockOut, note },
      // The browser's date and time only to refuse a future day or time with its own sentence; the database is the judge.
      todayInMalaysia(new Date()),
      timeInMalaysia(new Date()),
    );
    if (!converted.ok) {
      setError(converted.error);
      return;
    }
    setError(null);
    start(async () => {
      let result: CapResult<unknown>;
      try {
        result = await correctAttendanceAction(converted.input);
      } catch {
        result = { ok: false, error: WRITE_FAILED };
      }
      if (result.ok) {
        setOpen(false);
        refocus.current = true;
      } else setError(result.error);
    });
  }

  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2.5 text-xs"
        disabled={off}
        aria-expanded={open}
        aria-controls={promptId}
        aria-label={`Correct ${name}'s attendance`}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          // Open on what the row holds now, not on what an earlier, abandoned edit left behind.
          setStatus(prefill.status);
          setClockIn(prefill.clock_in);
          setClockOut(prefillOut());
          setNote(prefill.note);
          setError(null);
          setOpen(true);
        }}
      >
        Correct
      </Button>
      {open || error ? (
        <RowPrompt focusKey={open ? 'correcting' : ''} onEscape={close}>
          {open ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-status`}>
                Status
                <select
                  id={`${ids}-status`}
                  data-autofocus
                  className={SELECT_CLASS}
                  disabled={off}
                  value={status}
                  onChange={(event) => {
                    setError(null);
                    setStatus(event.target.value as AttendanceStatus);
                  }}
                >
                  {STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              {withTimes ? (
                <>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-in`}>
                    Clock-in
                    <Input
                      id={`${ids}-in`}
                      type="time"
                      required
                      className="h-7 w-28 text-xs"
                      disabled={off}
                      value={clockIn}
                      onChange={(event) => setClockIn(event.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-out`}>
                    Clock-out (optional)
                    <Input
                      id={`${ids}-out`}
                      type="time"
                      className="h-7 w-28 text-xs"
                      disabled={off}
                      value={clockOut}
                      onChange={(event) => setClockOut(event.target.value)}
                    />
                  </label>
                </>
              ) : null}
              <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-note`}>
                Note (optional)
                <Input
                  id={`${ids}-note`}
                  maxLength={500}
                  className="h-7 w-56 text-xs"
                  disabled={off}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>
              <Button type="submit" size="sm" className="h-7 px-2.5 text-xs" disabled={off}>
                Confirm
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2.5 text-xs" disabled={off} onClick={close}>
                Keep
              </Button>
            </form>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </RowPrompt>
      ) : null}
    </>
  );
}
