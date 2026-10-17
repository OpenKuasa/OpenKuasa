'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { decideClaimAction, decideOvertimeAction } from '@/app/(app)/people/pay-actions';
import { decideLeaveAction, decideTimeOffAction } from '@/app/(app)/people/leave-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CapResult } from '@/lib/people/capabilities';
import { LEAVE_REFUSALS, PAY_REFUSALS } from '@/lib/people/refusals';
import { RowPrompt, usePromptId } from './request-row';

type Kind = 'leave' | 'time_off' | 'claim' | 'overtime';

type Decide = (input: { id: string; approve: boolean; note: string | null }) => Promise<CapResult<unknown>>;

const DECIDE: Record<Kind, Decide> = {
  leave: decideLeaveAction,
  time_off: decideTimeOffAction,
  claim: decideClaimAction,
  overtime: decideOvertimeAction,
};

/**
 * Approve and Reject (with an optional note) for one report's pending request, as a manager sees it. It does
 * nothing else: the server action and the database check every decision again, and answer in a sentence when
 * someone else decided first. A decision that comes back saved (including an overtime decision with no amount)
 * refreshes the page through the action's own revalidation.
 */
export function TeamDecideButtons({ kind, id }: { kind: Kind; id: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rejectButton = useRef<HTMLButtonElement>(null);
  const promptId = usePromptId();

  function decide(approve: boolean) {
    const trimmed = note.trim();
    const input = { id, approve, note: approve || trimmed === '' ? null : trimmed };
    setError(null);
    start(async () => {
      let result: CapResult<unknown>;
      try {
        result = await DECIDE[kind](input);
      } catch {
        result = { ok: false, error: 'That change could not be saved. Please try again.' };
      }
      if (result.ok) {
        setRejecting(false);
        setNote('');
      } else {
        setError(result.error);
        // Someone else decided it first: load the page afresh so the stale row and its buttons go.
        if (result.error === LEAVE_REFUSALS.LEAVE_NOT_PENDING || result.error === PAY_REFUSALS.PAY_NOT_PENDING) {
          router.refresh();
        }
      }
    });
  }

  // Escape closes the note and returns focus to the button that opened it.
  const closeNote = () => {
    setRejecting(false);
    setNote('');
    setError(null);
    rejectButton.current?.focus();
  };

  return (
    <>
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <Button type="button" size="sm" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => decide(true)}>
          {busy ? 'Saving…' : 'Approve'}
        </Button>
        <Button
          ref={rejectButton}
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-xs"
          disabled={busy}
          aria-expanded={rejecting}
          aria-controls={promptId}
          onClick={() => {
            setError(null);
            if (rejecting) closeNote();
            else setRejecting(true);
          }}
        >
          Reject
        </Button>
      </div>
      {rejecting || error ? (
        <RowPrompt focusKey={rejecting ? 'reject' : ''} onEscape={() => (rejecting ? closeNote() : setError(null))}>
          {rejecting ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                decide(false);
              }}
            >
              <Input
                aria-label="Note for the rejection (optional)"
                placeholder="Note (optional)"
                maxLength={500}
                className="h-7 w-64 text-xs"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <Button type="submit" variant="destructive" size="sm" className="h-7 px-2.5 text-xs" disabled={busy}>
                {busy ? 'Saving…' : 'Confirm reject'}
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
