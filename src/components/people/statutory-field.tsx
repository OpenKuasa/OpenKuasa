'use client';

import { useId, useState, useTransition } from 'react';
import { setPayslipStatutoryAction } from '@/app/(app)/people/payroll-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import { toStatutoryInput } from '@/lib/people/payroll-forms';
import { centsToField } from '@/lib/people/payroll';
import type { StatutoryField as Field } from '@/lib/people/types';

/**
 * One of EPF, SOCSO, EIS or PCB on a draft payslip, as a field the owner can type over. Saving an empty field
 * (or pressing Reset) puts the figure back to the proposed amount. Saving the figure as it stands pins it
 * (marks it set by HR) when it is not already. The figure shown is the payslip's own; this
 * component works nothing out. A refusal shows under the field and clears as soon as the field changes.
 */
export function StatutoryFigure({
  payslipId,
  field,
  label,
  amountCents,
  setByHr,
}: {
  payslipId: string;
  field: Field;
  label: string;
  amountCents: number;
  setByHr: boolean;
}) {
  const [pending, start] = useTransition();
  const [text, setText] = useState(centsToField(amountCents));
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  // The figure changed under us (saved, reset, or recalculated): show what the payslip now holds.
  const [shownFor, setShownFor] = useState(amountCents);
  if (shownFor !== amountCents) {
    setShownFor(amountCents);
    setText(centsToField(amountCents));
  }
  const unchanged = text.trim() === centsToField(amountCents);

  function send(amount: string) {
    const converted = toStatutoryInput({ field, amount });
    if (!converted.ok) {
      setError(converted.error);
      return;
    }
    setError(null);
    start(async () => {
      let result: CapResult<unknown>;
      try {
        result = await setPayslipStatutoryAction({ payslip_id: payslipId, ...converted.input });
      } catch {
        result = { ok: false, error: WRITE_FAILED };
      }
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          send(text);
        }}
      >
        <label htmlFor={id} className="w-16 text-sm">
          {label}
        </label>
        <span className="text-xs text-muted-foreground">RM</span>
        <Input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          aria-label={`${label} amount, in ringgit. Leave empty to use the proposed amount.`}
          className="h-7 w-28 text-right text-xs tabular-nums"
          disabled={pending}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
        />
        <Button type="submit" variant="outline" size="sm" className="h-7 px-2.5 text-xs" disabled={pending || (unchanged && setByHr)}>
          Save
        </Button>
        {setByHr ? (
          <>
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[0.7rem] text-muted-foreground">set by HR</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-xs"
              disabled={pending}
              aria-label={`Reset ${label} to the proposed amount`}
              onClick={() => send('')}
            >
              Reset
            </Button>
          </>
        ) : null}
      </form>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
