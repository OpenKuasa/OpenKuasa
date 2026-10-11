'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { markClaimPaidAction, unmarkClaimPaidAction } from '@/app/(app)/people/pay-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import { todayInMalaysia } from '@/lib/people/dates';
import { RowPrompt, usePromptId } from './request-row';

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
  const trigger = useRef<HTMLButtonElement>(null);
  const promptId = usePromptId();
  // Set when a prompt has just been closed; focus goes back to the button once it is enabled again (it is
  // disabled while the action runs, and a disabled button cannot take focus). Never set on first render.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current || busy || step !== 'idle') return;
    refocus.current = false;
    trigger.current?.focus();
  }, [busy, step]);

  function run(call: () => Promise<CapResult<unknown>>) {
    setError(null);
    start(async () => {
      let result: CapResult<unknown>;
      try {
        result = await call();
      } catch {
        result = { ok: false, error: WRITE_FAILED };
      }
      if (result.ok) {
        setStep('idle');
        refocus.current = true;
      } else setError(result.error);
    });
  }

  // Keep and Escape: the prompt goes and focus returns to the button that opened it.
  const close = () => {
    setStep('idle');
    setError(null);
    refocus.current = true;
  };

  const today = todayInMalaysia(new Date());

  // The button stays in the Action column; the form, the question and any error go to the row's prompt area
  // (`RowPrompt`), which is as wide as the table.
  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2.5 text-xs"
        disabled={off}
        aria-expanded={step !== 'idle'}
        aria-controls={promptId}
        onClick={() => {
          if (step !== 'idle') {
            close();
            return;
          }
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
      {step !== 'idle' || error ? (
        <RowPrompt focusKey={step === 'idle' ? '' : step} onEscape={close}>
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
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-xs text-destructive">
                Undo the paid mark? The claim goes back to approved.
              </p>
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-autofocus
                className="h-7 px-2.5 text-xs"
                disabled={off}
                onClick={close}
              >
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
