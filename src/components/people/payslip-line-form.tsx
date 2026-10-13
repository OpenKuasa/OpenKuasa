'use client';

import { Plus } from 'lucide-react';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import {
  deletePayslipLineAction,
  removePayslipAction,
  savePayslipLineAction,
} from '@/app/(app)/people/payroll-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import { centsToField, removePayslipSentence } from '@/lib/people/payroll';
import { toLineInput } from '@/lib/people/payroll-forms';
import { RowPrompt, usePromptId } from './request-row';

const SELECT_CLASS =
  'h-7 rounded-lg border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

async function settle(call: () => Promise<CapResult<unknown>>): Promise<CapResult<unknown>> {
  try {
    return await call();
  } catch {
    return { ok: false, error: WRITE_FAILED };
  }
}

export type LineValue = { id: string; kind: 'earning' | 'deduction'; label: string; amount_cents: number };

/**
 * "Add line" (no `line`) or "Edit" (one of the owner's own lines) on a draft payslip. The form opens under the
 * button with a kind, a name and an amount in ringgit; it closes once the server accepts. A refusal shows under
 * the form and clears when any field changes.
 */
export function PayslipLineForm({ payslipId, line }: { payslipId: string; line?: LineValue }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string>(line?.kind ?? 'earning');
  const [label, setLabel] = useState(line?.label ?? '');
  const [amount, setAmount] = useState(line ? centsToField(line.amount_cents) : '');
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const ids = useId();
  const promptId = usePromptId();
  useEffect(() => {
    if (!refocus.current || pending || open) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [pending, open]);

  const close = () => {
    setOpen(false);
    setError(null);
    refocus.current = true;
  };

  function openForm() {
    // Open on what the line holds now (or empty, to add).
    setKind(line?.kind ?? 'earning');
    setLabel(line?.label ?? '');
    setAmount(line ? centsToField(line.amount_cents) : '');
    setError(null);
    setOpen(true);
  }

  function submit() {
    const converted = toLineInput({ kind, label, amount });
    if (!converted.ok) {
      setError(converted.error);
      return;
    }
    setError(null);
    start(async () => {
      const result = await settle(() =>
        savePayslipLineAction({ payslip_id: payslipId, line_id: line?.id ?? null, ...converted.input }),
      );
      if (result.ok) {
        setOpen(false);
        refocus.current = true;
        if (!line) {
          setLabel('');
          setAmount('');
          setKind('earning');
        }
      } else setError(result.error);
    });
  }

  const changed = () => setError(null);
  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2.5 text-xs"
        disabled={pending}
        aria-expanded={open}
        aria-controls={promptId}
        aria-label={line ? `Edit ${line.label}` : undefined}
        onClick={() => (open ? close() : openForm())}
      >
        {line ? null : <Plus aria-hidden />}
        {line ? 'Edit' : 'Add line'}
      </Button>
      {open ? (
        <RowPrompt focusKey="line-form" onEscape={close}>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <select
              aria-label="Earning or deduction"
              className={SELECT_CLASS}
              disabled={pending}
              value={kind}
              onChange={(event) => {
                setKind(event.target.value);
                changed();
              }}
            >
              <option value="earning">Earning (adds to gross)</option>
              <option value="deduction">Deduction (comes off net)</option>
            </select>
            <Input
              id={`${ids}-label`}
              aria-label="Line name"
              placeholder="Name, like Sales commission"
              required
              maxLength={80}
              autoComplete="off"
              className="h-7 w-48 text-xs"
              disabled={pending}
              value={label}
              onChange={(event) => {
                setLabel(event.target.value);
                changed();
              }}
            />
            <Input
              id={`${ids}-amount`}
              aria-label="Amount in ringgit"
              placeholder="Amount, like 1,200.50"
              required
              inputMode="decimal"
              autoComplete="off"
              className="h-7 w-36 text-right text-xs tabular-nums"
              disabled={pending}
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                changed();
              }}
            />
            <Button type="submit" size="sm" className="h-7 px-2.5 text-xs" disabled={pending}>
              Save line
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2.5 text-xs" disabled={pending} onClick={close}>
              Cancel
            </Button>
          </form>
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

/** "Remove" on one of the owner's own lines. Needs a second step. */
export function RemoveLine({ lineId, label }: { lineId: string; label: string }) {
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const promptId = usePromptId();
  useEffect(() => {
    if (!refocus.current || pending || asking) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [pending, asking]);

  const close = () => {
    setAsking(false);
    setError(null);
    refocus.current = true;
  };

  function remove() {
    setError(null);
    start(async () => {
      const result = await settle(() => deletePayslipLineAction({ line_id: lineId }));
      if (result.ok) {
        setAsking(false);
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
        disabled={pending}
        aria-expanded={asking}
        aria-controls={promptId}
        aria-label={`Remove ${label}`}
        onClick={() => {
          if (asking) close();
          else {
            setError(null);
            setAsking(true);
          }
        }}
      >
        Remove
      </Button>
      {asking || error ? (
        <RowPrompt focusKey={asking ? 'removing' : ''} onEscape={close}>
          {asking ? (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-xs text-destructive">
                Remove this line from the payslip?
              </p>
              <Button type="button" variant="destructive" size="sm" className="h-7 px-2.5 text-xs" disabled={pending} onClick={remove}>
                Confirm
              </Button>
              <Button type="button" variant="ghost" size="sm" data-autofocus className="h-7 px-2.5 text-xs" disabled={pending} onClick={close}>
                Keep
              </Button>
            </div>
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

/** "Remove payslip" on a draft payslip. Needs a second step that says what it does. */
export function RemovePayslip({
  payslipId,
  employeeName,
  monthText,
}: {
  payslipId: string;
  employeeName: string;
  /** `October 2026`. */
  monthText: string;
}) {
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const promptId = usePromptId();
  useEffect(() => {
    if (!refocus.current || pending || asking) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [pending, asking]);

  const close = () => {
    setAsking(false);
    setError(null);
    refocus.current = true;
  };

  function remove() {
    setError(null);
    start(async () => {
      const result = await settle(() => removePayslipAction({ payslip_id: payslipId }));
      if (result.ok) setAsking(false);
      else setError(result.error);
    });
  }

  return (
    <div className="space-y-1.5">
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        aria-expanded={asking}
        aria-controls={promptId}
        onClick={() => {
          if (asking) close();
          else {
            setError(null);
            setAsking(true);
          }
        }}
      >
        Remove payslip
      </Button>
      {asking || error ? (
        <RowPrompt focusKey={asking ? 'removing' : ''} onEscape={close}>
          {asking ? (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-xs text-destructive">
                {removePayslipSentence(employeeName, monthText)}
              </p>
              <Button type="button" variant="destructive" size="sm" className="h-7 px-2.5 text-xs" disabled={pending} onClick={remove}>
                Confirm
              </Button>
              <Button type="button" variant="ghost" size="sm" data-autofocus className="h-7 px-2.5 text-xs" disabled={pending} onClick={close}>
                Keep
              </Button>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </RowPrompt>
      ) : null}
    </div>
  );
}
