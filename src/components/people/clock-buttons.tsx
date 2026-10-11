'use client';

import { LogIn, LogOut } from 'lucide-react';
import { useState, useTransition } from 'react';
import { clockInAction, clockOutAction } from '@/app/(app)/people/attendance-actions';
import { Button } from '@/components/ui/button';
import { clockButtonLabel, clockResultMessage } from '@/lib/people/attendance';
import { WRITE_FAILED } from '@/lib/people/capabilities';

/**
 * The employee's own clock button: "Clock in" or "Clock out", one at a time (`action` says which, or none).
 * It sends nothing: the database fixes the employee, the day and the time. While a call is in flight the
 * button is disabled; a refusal shows the database's own sentence beside it, and a success says what
 * happened from the row the database returned. The same instance stays mounted as `action` changes, so
 * the success sentence survives the page refreshing after it; a refusal is cleared when `action` changes.
 */
export function ClockButtons({ action }: { action: 'in' | 'out' | null }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  // A refusal belongs to the button it was shown beside: once the button changes (or goes), it is stale.
  // A success sentence stays, so it survives the page refreshing after it.
  const [shownFor, setShownFor] = useState(action);
  if (shownFor !== action) {
    setShownFor(action);
    if (message?.tone === 'error') setMessage(null);
  }

  function click() {
    if (action === null) return;
    const which = action;
    setMessage(null);
    start(async () => {
      try {
        const result = await (which === 'in' ? clockInAction() : clockOutAction());
        setMessage(
          result.ok
            ? { tone: 'ok', text: clockResultMessage(which, result.data) }
            : { tone: 'error', text: result.error },
        );
      } catch {
        setMessage({ tone: 'error', text: WRITE_FAILED });
      }
    });
  }

  return (
    <span className="flex flex-col items-start gap-1 md:items-end">
      {action !== null ? (
        <Button type="button" size="sm" disabled={pending} onClick={click}>
          {action === 'in' ? <LogIn aria-hidden /> : <LogOut aria-hidden />}
          {clockButtonLabel(action, pending)}
        </Button>
      ) : null}
      {message ? (
        <span
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={
            message.tone === 'error'
              ? 'max-w-72 whitespace-normal text-xs text-destructive'
              : 'max-w-72 whitespace-normal text-xs text-muted-foreground'
          }
        >
          {message.text}
        </span>
      ) : null}
    </span>
  );
}
