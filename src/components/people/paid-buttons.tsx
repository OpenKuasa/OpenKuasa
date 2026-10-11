'use client';

import { useState, useTransition } from 'react';
import { markClaimPaidAction, unmarkClaimPaidAction } from '@/app/(app)/people/pay-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import { todayInMalaysia } from '@/lib/people/dates';

/**
 * "Mark paid" on an approved claim and "Undo paid" on a paid one. Each needs a
 * second, deliberate step: a date (today by default) and an optional reference
 * for marking, and a question for undoing. A demo visitor sees them disabled.
 */
export function PaidButtons({
  id,
  paid,
  claimDate,
  disabled,
}: {
  id: string;
  /** The claim is paid: Undo paid shows. Otherwise it is approved and Mark paid shows. */
  paid: boolean;
  /** The claim's own date: the earliest a payment can be dated. */
  claimDate: string;
  disabled: boolean;
}) {
  const [busy, start] = useTransition();
  const [step, setStep] = useState<'idle' | 'marking' | 'undoing'>('idle');
  const [paidOn, setPaidOn] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const off = disabled || busy;

  function run(call: () => Promise<CapResult<unknown>>) {
    setError(null);
    start(async () => {
      let result: CapResult<unknown>;
      try {
        result = await call();
      } catch {
        result = { ok: false, error: WRITE_FAILED };
      }
      if (result.ok) setStep('idle');
      else setError(result.error);
    });
  }

  const close = () => {
    setStep('idle');
    setError(null);
  };

  const today = todayInMalaysia(new Date());

  return (
    <div className="space-y-1.5">
      {step === 'idle' ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-xs"
          disabled={off}
          onClick={() => {
            setError(null);
            if (paid) {
              setStep('undoing');
            } else {
              setPaidOn(today);
              setReference('');
              setStep('marking');
            }
          }}
        >
          {paid ? 'Undo paid' : 'Mark paid'}
        </Button>
      ) : null}
      {step === 'marking' ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = reference.trim();
            run(() => markClaimPaidAction({ id, paid_on: paidOn, reference: trimmed === '' ? null : trimmed }));
          }}
        >
          <Input
            aria-label="Date paid"
            type="date"
            required
            min={claimDate}
            max={today}
            className="h-7 w-36 text-xs"
            disabled={off}
            value={paidOn}
            onChange={(event) => setPaidOn(event.target.value)}
          />
          <Input
            aria-label="Payment reference (optional)"
            placeholder="Reference (optional)"
            maxLength={100}
            className="h-7 w-40 text-xs"
            disabled={off}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
          <Button type="submit" size="sm" className="h-7 px-2.5 text-xs" disabled={off || paidOn === ''}>
            Confirm paid
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2.5 text-xs" disabled={off} onClick={close}>
            Keep
          </Button>
        </form>
      ) : null}
      {step === 'undoing' ? (
        <>
          <p role="alert" className="max-w-64 whitespace-normal text-xs text-destructive">
            Undo the paid mark? The claim goes back to approved.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="h-7 px-2.5 text-xs"
              disabled={off}
              onClick={() => run(() => unmarkClaimPaidAction({ id }))}
            >
              Confirm
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2.5 text-xs" disabled={off} onClick={close}>
              Keep
            </Button>
          </div>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="max-w-64 whitespace-normal text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
