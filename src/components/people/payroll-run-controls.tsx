'use client';

import { Play, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Dialog } from 'radix-ui';
import { type ReactNode, useEffect, useId, useRef, useState, useTransition } from 'react';
import {
  deletePayrollRunAction,
  markPayrollPaidAction,
  recalculatePayrollAction,
  runPayrollAction,
  unmarkPayrollPaidAction,
} from '@/app/(app)/people/payroll-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import {
  type RunControls,
  deleteDraftSentence,
  FIRST_RUN_NOTE,
  type RunMonthChoice,
  earlierOvertimeLine,
  markPaidSentence,
  monthInRange,
  recalculateNote,
  runCreatedSentence,
  runOptionLabel,
  runPayrollSentence,
  skippedRows,
  undoPaidSentence,
} from '@/lib/people/payroll';
import { monthLabel } from '@/lib/people/payroll-forms';
import type { RunResult } from '@/lib/people/payroll-writes';
import { RowPrompt } from './request-row';

async function settle<T>(call: () => Promise<CapResult<T>>): Promise<CapResult<T>> {
  try {
    return await call();
  } catch {
    return { ok: false, error: WRITE_FAILED };
  }
}

/** What a run or recalculation noted: overtime paid late, and the people left out with the reason. */
function Skipped({ skipped, earlierOvertime }: { skipped: RunResult['skipped']; earlierOvertime: number }) {
  const rows = skippedRows(skipped);
  const earlier = earlierOvertimeLine(earlierOvertime);
  if (rows.length === 0 && !earlier) return null;
  return (
    <div className="space-y-2 text-sm">
      {earlier ? <p className="text-muted-foreground">{earlier}</p> : null}
      {rows.length > 0 ? (
        <div className="space-y-1">
          <p className="font-medium">Left out ({rows.length})</p>
          <ul className="space-y-0.5 text-muted-foreground">
            {rows.map((r) => (
              <li key={r.id}>
                {r.name}: {r.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Run payroll": a dialog with a month (the suggested one to start with) that says what will happen. Once the
 * server accepts, it opens the new draft and lists anyone left out. In the demo the screen shows the later-button
 * instead of this.
 */
export function RunPayrollDialog({ choice }: { choice: RunMonthChoice }) {
  const fixed = choice.kind === 'fixed';
  const defaultMonth = fixed ? choice.month : choice.default;
  const firstMonth = fixed ? choice.month : choice.first;
  const lastMonth = fixed ? choice.month : choice.last;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [month, setMonth] = useState(defaultMonth);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<RunResult | null>(null);
  const id = useId();
  const valid = monthInRange(month, firstMonth, lastMonth);

  function show(next: boolean) {
    if (next) {
      setMonth(defaultMonth);
      setError(null);
      setDone(null);
      setOpen(true);
    } else if (!pending) setOpen(false);
  }

  function submit() {
    if (!valid) return;
    setError(null);
    start(async () => {
      const result = await settle(() => runPayrollAction({ month }));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(result.data as RunResult);
      router.push(`/people/payroll?run=${encodeURIComponent((result.data as RunResult).run_id)}`);
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={show}>
      <Dialog.Trigger asChild>
        <Button type="button" size="sm">
          <Play aria-hidden />
          Run payroll
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg outline-none">
          <Dialog.Title className="text-base font-semibold">Run payroll</Dialog.Title>
          {done ? (
            <div className="mt-3 space-y-3">
              <Dialog.Description className="text-sm text-muted-foreground">
                {runCreatedSentence(monthLabel(done.month), done.payslips)}
              </Dialog.Description>
              <Skipped skipped={done.skipped} earlierOvertime={done.earlier_overtime} />
              <div className="flex justify-end">
                <Button type="button" onClick={() => setOpen(false)}>
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="mt-3 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              {fixed ? (
                <p className="text-sm font-medium">Payroll for {monthLabel(choice.month)}</p>
              ) : (
                <>
                  <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-month`}>
                    Month
                    <Input
                      id={`${id}-month`}
                      type="month"
                      required
                      min={firstMonth}
                      max={lastMonth}
                      disabled={pending}
                      value={month}
                      onChange={(event) => {
                        setMonth(event.target.value);
                        setError(null);
                      }}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">{FIRST_RUN_NOTE}</p>
                </>
              )}
              <Dialog.Description className="text-sm text-muted-foreground">
                {valid ? runPayrollSentence(monthLabel(month)) : 'Choose the month to run.'}
              </Dialog.Description>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" disabled={pending} onClick={() => show(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending || !valid}>
                  Create draft
                </Button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type Step = 'idle' | 'paying' | 'undoing' | 'deleting';

/**
 * What an owner can do with the chosen run: Recalculate (one click), and Mark as paid, Delete draft or Undo paid,
 * each behind a second step that says what it will do. Which of them show is the page's call (`controls`, from
 * `runControls`); nothing renders for a control the run does not offer. Nothing can be sent twice: every button is
 * disabled while a call is in flight. A refusal shows under the buttons and clears when any control is used again.
 */
export function RunActions({
  runId,
  monthText,
  headcount,
  controls,
}: {
  runId: string;
  /** `October 2026`. */
  monthText: string;
  headcount: number;
  controls: RunControls;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  // The Recalculate refusal sits beside that button; the others sit under their prompt.
  const [recalcError, setRecalcError] = useState<string | null>(null);
  const [recalculated, setRecalculated] = useState<RunResult | null>(null);
  // Which action is in flight, so only the button that was pressed says it is working.
  const [recalculating, setRecalculating] = useState(false);
  // The run's payslip count when the recalculation was sent. The note comes from the recalculation's own result, so
  // it shows at once; the first change of the count to what the result says is the page catching up (keep it),
  // and any other change means a payslip was added or removed since (drop it).
  const [seenHeadcount, setSeenHeadcount] = useState(headcount);
  if (recalculated && headcount !== seenHeadcount) {
    if (headcount === recalculated.payslips && seenHeadcount !== recalculated.payslips) setSeenHeadcount(headcount);
    else setRecalculated(null);
  }
  const refocus = useRef<HTMLButtonElement | null>(null);
  const triggers = useRef<Partial<Record<Step, HTMLButtonElement | null>>>({});
  // Another run was chosen (or this one changed state): a stale prompt, refusal or result goes.
  const key = `${runId}:${controls.markPaid}:${controls.undoPaid}:${controls.deleteDraft}`;
  const [shownFor, setShownFor] = useState(key);
  if (shownFor !== key) {
    setShownFor(key);
    setStep('idle');
    setError(null);
    setRecalcError(null);
    setRecalculated(null);
  }
  useEffect(() => {
    if (step !== 'idle' || pending || !refocus.current) return;
    refocus.current.focus();
    refocus.current = null;
  }, [step, pending]);

  const close = () => {
    refocus.current = step === 'idle' ? null : (triggers.current[step] ?? null);
    setStep('idle');
    setError(null);
  };
  const open = (next: Step) => {
    setError(null);
    setRecalcError(null);
    setRecalculated(null);
    setStep(step === next ? 'idle' : next);
  };

  function recalculate() {
    setError(null);
    setRecalcError(null);
    setRecalculated(null);
    setStep('idle');
    setRecalculating(true);
    start(async () => {
      const result = await settle(() => recalculatePayrollAction({ run_id: runId }));
      setRecalculating(false);
      if (result.ok) {
        setSeenHeadcount(headcount);
        setRecalculated(result.data);
      }
      else setRecalcError(result.error);
    });
  }

  function confirm(call: () => Promise<CapResult<unknown>>, after?: () => void) {
    setError(null);
    start(async () => {
      const result = await settle(call);
      if (result.ok) {
        refocus.current = null;
        setStep('idle');
        after?.();
      } else setError(result.error);
    });
  }

  const sentence =
    step === 'paying'
      ? markPaidSentence(headcount, monthText)
      : step === 'undoing'
        ? undoPaidSentence(headcount, monthText)
        : step === 'deleting'
          ? deleteDraftSentence(monthText, headcount)
          : '';
  const run =
    step === 'paying'
      ? () => confirm(() => markPayrollPaidAction({ run_id: runId }))
      : step === 'undoing'
        ? () => confirm(() => unmarkPayrollPaidAction({ run_id: runId }))
        : () => confirm(() => deletePayrollRunAction({ run_id: runId }), () => router.replace('/people/payroll'));

  const trigger = (which: Exclude<Step, 'idle'>, label: string): ReactNode => (
    <Button
      key={which}
      ref={(node) => {
        triggers.current[which] = node;
      }}
      type="button"
      variant={which === 'paying' ? 'default' : 'outline'}
      size="sm"
      disabled={pending}
      aria-expanded={step === which}
      onClick={() => open(which)}
    >
      {label}
    </Button>
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {controls.recalculate ? (
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={recalculate}>
            <RefreshCw aria-hidden />
            {pending && recalculating ? 'Working…' : 'Recalculate'}
          </Button>
        ) : null}
        {recalcError ? (
          <p role="alert" className="text-sm text-destructive">
            {recalcError}
          </p>
        ) : null}
        {controls.markPaid ? trigger('paying', 'Mark as paid') : null}
        {controls.deleteDraft ? trigger('deleting', 'Delete draft') : null}
        {controls.undoPaid ? trigger('undoing', 'Undo paid') : null}
      </div>
      {step !== 'idle' ? (
        <RowPrompt focusKey={step} onEscape={close}>
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm">
              {sentence}
            </p>
            <Button
              type="button"
              size="sm"
              variant={step === 'paying' ? 'default' : 'destructive'}
              disabled={pending}
              onClick={run}
            >
              Confirm
            </Button>
            <Button type="button" variant="ghost" size="sm" data-autofocus disabled={pending} onClick={close}>
              Keep
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </RowPrompt>
      ) : null}
      {recalculated ? (
        <div role="status" className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {recalculateNote(recalculated.added)}
          </p>
          <Skipped skipped={recalculated.skipped} earlierOvertime={recalculated.earlier_overtime} />
        </div>
      ) : null}
    </div>
  );
}

/** The month picker: every run on record, newest first. Choosing one opens it (`?run=`). */
export function RunPicker({
  runs,
  currentId,
}: {
  runs: { id: string; label: string; status: 'draft' | 'paid'; headcount: number }[];
  currentId: string | null;
}) {
  const router = useRouter();
  const id = useId();
  if (runs.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm text-muted-foreground">
        Month
      </label>
      <select
        id={id}
        className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        value={currentId ?? ''}
        onChange={(event) => router.push(`/people/payroll?run=${encodeURIComponent(event.target.value)}`)}
      >
        {runs.map((r) => (
          <option key={r.id} value={r.id}>
            {runOptionLabel(r)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A payslip row's name, as a button that opens its detail in a dialog. `children` is the server-rendered detail. */
export function PayslipDialog({
  name,
  monthText,
  children,
}: {
  name: string;
  /** `October 2026`. */
  monthText: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="font-medium underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
          aria-label={`Open ${name}'s payslip for ${monthText}`}
        >
          {name}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg outline-none">
          <Dialog.Title className="text-base font-semibold">{name}</Dialog.Title>
          <Dialog.Description className="mb-4 text-sm text-muted-foreground">Payslip for {monthText}</Dialog.Description>
          {children}
          <div className="mt-4 flex justify-end">
            <Dialog.Close asChild>
              <Button type="button" variant="ghost">
                Close
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
