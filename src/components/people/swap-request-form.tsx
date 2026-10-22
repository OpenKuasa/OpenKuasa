'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { requestShiftSwapAction } from '@/app/(app)/people/swap-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CapResult } from '@/lib/people/capabilities';
import type { SwapChoices } from '@/lib/people/swaps';

const SELECT_CLASS =
  'h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

/**
 * "Ask for a swap": one of the member's own future shifts, a colleague's shift it may be swapped for (the second
 * list follows the first), and an optional note. The colleague is asked first; an approver decides after.
 */
export function SwapRequestForm({ choices, disabled }: { choices: SwapChoices; disabled: boolean }) {
  const router = useRouter();
  const ids = { mine: useId(), theirs: useId(), note: useId() };
  const [mine, setMine] = useState('');
  const [theirs, setTheirs] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const off = disabled || busy;
  const options = mine ? (choices.theirs[mine] ?? []) : [];

  if (choices.mine.length === 0) {
    return <p className="text-sm text-muted-foreground">None of your shifts in the next 60 days can be swapped right now.</p>;
  }

  const submit = () => {
    setMessage(null);
    start(async () => {
      let result: CapResult<unknown>;
      try {
        result = await requestShiftSwapAction({ my_shift_id: mine, their_shift_id: theirs, note: note.trim() || null });
      } catch {
        result = { ok: false, error: 'That request could not be sent. Please try again.' };
      }
      if (result.ok) {
        setMine('');
        setTheirs('');
        setNote('');
        setMessage({ ok: true, text: 'Sent. Your colleague is asked first, then it goes for approval.' });
        router.refresh();
      } else {
        setMessage({ ok: false, text: result.error });
      }
    });
  };

  return (
    <form
      className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="grid gap-1 text-sm" htmlFor={ids.mine}>
        <span className="font-medium">Your shift</span>
        <select
          id={ids.mine}
          className={SELECT_CLASS}
          value={mine}
          disabled={off}
          onChange={(event) => {
            setMine(event.target.value);
            setTheirs('');
          }}
        >
          <option value="">Pick one of your shifts</option>
          {choices.mine.map((c) => (
            <option key={c.shift_id} value={c.shift_id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm" htmlFor={ids.theirs}>
        <span className="font-medium">For a colleague&apos;s shift</span>
        <select id={ids.theirs} className={SELECT_CLASS} value={theirs} disabled={off || !mine} onChange={(event) => setTheirs(event.target.value)}>
          <option value="">{mine ? 'Pick a colleague and shift' : 'Pick your shift first'}</option>
          {options.map((c) => (
            <option key={c.shift_id} value={c.shift_id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm" htmlFor={ids.note}>
        <span className="font-medium">Note (optional)</span>
        <Input id={ids.note} maxLength={500} value={note} disabled={off} onChange={(event) => setNote(event.target.value)} />
      </label>
      <Button type="submit" disabled={off || !mine || !theirs}>
        Ask for the swap
      </Button>
      {message ? (
        <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-sm text-emerald-600 md:col-span-4' : 'text-sm text-destructive md:col-span-4'}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
