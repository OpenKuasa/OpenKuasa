'use client';

import { useId, useState, useTransition } from 'react';
import { Dialog } from 'radix-ui';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { type GoalLike, goalCardView, typedProgress } from '@/lib/people/goals-training';
import { GOAL_TITLE_MAX, toGoalInput } from '@/lib/people/performance-forms';

/** What a goal write answers. The caller passes the right server action in: this file reaches no action itself. */
export type GoalResult = { ok: boolean; error?: string };
export type SaveGoal = (input: Record<string, unknown>) => Promise<GoalResult>;

const SELECT_CLASS =
  'h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

/**
 * Add or edit one goal: title, progress (a whole number 0 to 100), due date and the on track / at risk choice
 * (hidden while progress reads 100, as a finished goal is simply Done). A refusal shows under the form and clears
 * as soon as any field changes. `save` is the own-record or the owner action, chosen by the screen.
 */
export function GoalForm({
  initial,
  save,
  onDone,
  onCancel,
}: {
  initial: GoalLike | null;
  save: SaveGoal;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [busy, start] = useTransition();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [progress, setProgress] = useState(initial ? String(initial.progress) : '0');
  const [due, setDue] = useState(initial?.due_date ?? '');
  const [atRisk, setAtRisk] = useState(initial?.status === 'at_risk');
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const choiceShown = goalCardView({ progress: typedProgress(progress, initial?.progress ?? 0), status: initial?.status ?? 'on_track' }).showAtRisk;
  const change = <T,>(set: (value: T) => void) => (value: T) => {
    setError(null);
    set(value);
  };

  function submit() {
    const converted = toGoalInput({ title, progress, due_date: due, at_risk: atRisk && choiceShown });
    if (!converted.ok) {
      setError(converted.error);
      return;
    }
    setError(null);
    start(async () => {
      let result: GoalResult;
      try {
        result = await save(initial ? { goal_id: initial.id, ...converted.input } : converted.input);
      } catch {
        result = { ok: false, error: WRITE_FAILED };
      }
      if (result.ok) onDone();
      else setError(result.error ?? WRITE_FAILED);
    });
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-title`}>
        Title
        <Input
          id={`${ids}-title`}
          autoFocus
          required
          maxLength={GOAL_TITLE_MAX}
          disabled={busy}
          value={title}
          onChange={(event) => change(setTitle)(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-progress`}>
          Progress (%)
          <Input
            id={`${ids}-progress`}
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            required
            className="w-24"
            disabled={busy}
            value={progress}
            onChange={(event) => change(setProgress)(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-due`}>
          Due date (optional)
          <Input
            id={`${ids}-due`}
            type="date"
            className="w-40"
            disabled={busy}
            value={due}
            onChange={(event) => change(setDue)(event.target.value)}
          />
        </label>
        {choiceShown ? (
          <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-risk`}>
            Where it stands
            <select
              id={`${ids}-risk`}
              className={SELECT_CLASS}
              disabled={busy}
              value={atRisk ? 'at_risk' : 'on_track'}
              onChange={(event) => change(setAtRisk)(event.target.value === 'at_risk')}
            >
              <option value="on_track">On track</option>
              <option value="at_risk">At risk</option>
            </select>
          </label>
        ) : (
          <p className="pb-1.5 text-xs text-muted-foreground">At 100% the goal is Done.</p>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Working…' : initial ? 'Save goal' : 'Add goal'}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The "Add Goal" button and its dialog, for one's own goals. */
export function AddGoal({ save }: { save: SaveGoal }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button type="button" size="sm">
          <Plus aria-hidden />
          Add Goal
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg outline-none">
          <Dialog.Title className="text-base font-semibold">Add a goal</Dialog.Title>
          <Dialog.Description className="mb-4 text-sm text-muted-foreground">
            Something you are working towards, and how far along it is.
          </Dialog.Description>
          <GoalForm initial={null} save={save} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
