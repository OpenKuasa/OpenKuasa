'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { deleteLetterAction, issueLetterAction, unissueLetterAction } from '@/app/(app)/people/letter-actions';
import { Button } from '@/components/ui/button';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import type { LetterRow } from '@/lib/people/documents';
import {
  deleteDraftSentence,
  issueState,
  letterIssueSentence,
  letterPullBackSentence,
} from '@/lib/people/letters-screens';
import { LetterDialog } from './letter-form';
import { LetterViewDialog } from './letter-view';
import { RowPrompt } from './request-row';

type Step = 'idle' | 'issuing' | 'pulling' | 'deleting';

async function settle<T>(call: () => Promise<CapResult<T>>): Promise<CapResult<T>> {
  try {
    return await call();
  } catch {
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * What an owner or admin can do with one letter. A draft: Edit, Issue and Delete. An issued one: View and Pull back
 * to draft. Issue, Pull back and Delete each take a second step that says what will happen. Issue is disabled, with
 * the reason beside it, while the text has no body or still holds a placeholder. Every button is disabled while a
 * call is in flight and only the one pressed says "Working…". A refusal clears when the question changes or the
 * letter changes state.
 */
export function LetterRowControls({ letter, workspaceName }: { letter: LetterRow; workspaceName: string }) {
  const [pending, start] = useTransition();
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<Step | null>(null);
  const refocus = useRef<HTMLButtonElement | null>(null);
  const triggers = useRef<Partial<Record<Step, HTMLButtonElement | null>>>({});

  const draft = letter.status === 'draft';
  const key = `${letter.id}:${letter.status}`;
  const [shownFor, setShownFor] = useState(key);
  if (shownFor !== key) {
    setShownFor(key);
    setStep('idle');
    setError(null);
    setWorking(null);
  }
  useEffect(() => {
    if (step !== 'idle' || pending || !refocus.current) return;
    refocus.current.focus();
    refocus.current = null;
  }, [step, pending]);

  const issue = issueState(letter.title, letter.body);
  const close = () => {
    refocus.current = step === 'idle' ? null : (triggers.current[step] ?? null);
    setStep('idle');
    setError(null);
  };
  const open = (next: Exclude<Step, 'idle'>) => {
    if (step === next) return;
    setError(null);
    setStep(next);
  };

  const sentence =
    step === 'issuing'
      ? letterIssueSentence(letter.employee_name)
      : step === 'pulling'
        ? letterPullBackSentence(letter.employee_name)
        : step === 'deleting'
          ? deleteDraftSentence(letter.employee_name, letter.title)
          : '';

  function confirm() {
    const input = { letter_id: letter.id };
    const call =
      step === 'issuing'
        ? () => issueLetterAction(input)
        : step === 'pulling'
          ? () => unissueLetterAction(input)
          : step === 'deleting'
            ? () => deleteLetterAction(input)
            : null;
    if (!call) return;
    setError(null);
    setWorking(step);
    start(async () => {
      const result = await settle(call);
      setWorking(null);
      if (result.ok) {
        refocus.current = null;
        setStep('idle');
      } else setError(result.error);
    });
  }

  const trigger = (which: Exclude<Step, 'idle'>, label: string, name: string, disabled = false) => (
    <Button
      key={which}
      ref={(node) => {
        triggers.current[which] = node;
      }}
      type="button"
      variant="outline"
      size="sm"
      disabled={pending || disabled}
      aria-expanded={step === which}
      aria-label={name}
      onClick={() => open(which)}
    >
      {label}
    </Button>
  );

  const confirmLabel = step === 'issuing' ? 'Issue' : step === 'pulling' ? 'Pull back' : 'Delete';

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {draft ? (
          <>
            <LetterDialog
              letter={{
                id: letter.id,
                employee_id: letter.employee_id,
                employee_name: letter.employee_name,
                letter_type: letter.letter_type,
                title: letter.title,
                body: letter.body,
                ack_requested: letter.ack_requested,
              }}
            />
            {trigger('issuing', 'Issue', `Issue ${letter.title}`, !issue.allowed)}
            {trigger('deleting', 'Delete', `Delete ${letter.title}`)}
          </>
        ) : (
          <>
            <LetterViewDialog letter={letter} workspaceName={workspaceName} />
            {trigger('pulling', 'Pull back to draft', `Pull ${letter.title} back to draft`)}
          </>
        )}
      </div>
      {draft && !issue.allowed ? (
        <p className="max-w-xs whitespace-normal text-xs text-muted-foreground">Cannot be issued yet. {issue.reason}</p>
      ) : null}
      {step !== 'idle' ? (
        <RowPrompt focusKey={step} onEscape={close}>
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm">
              {sentence}
            </p>
            <Button
              type="button"
              size="sm"
              variant={step === 'deleting' ? 'destructive' : 'default'}
              disabled={pending}
              onClick={confirm}
            >
              {pending && working === step ? 'Working…' : confirmLabel}
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
    </div>
  );
}
