'use client';

import { useId, useState, useTransition } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { type GoalLike, goalCardView, goalProgressInput, typedProgress } from '@/lib/people/goals-training';
import { GoalForm, type GoalResult, type SaveGoal } from './goal-form';

export type RemoveGoal = (input: { goal_id: string }) => Promise<GoalResult>;

type Where = 'progress' | 'remove';

const SELECT_CLASS =
  'h-7 rounded-lg border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

/**
 * What one goal card can do: change its progress and whether it is on track or at risk, Edit, and Remove (a second
 * step). The caller passes the actions (the own-record ones on My Goals, the owner ones on the Employees screen), so
 * this file imports none. A refusal shows beside the control used and clears when that control's state changes.
 * The caller should give the component a `key` that changes when the saved goal does, so a fresh read resets it.
 */
export function GoalCardControls({ goal, save, remove }: { goal: GoalLike; save: SaveGoal; remove: RemoveGoal }) {
  const [busy, start] = useTransition();
  const [pressed, setPressed] = useState<Where | null>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm'>('view');
  const [progress, setProgress] = useState(String(goal.progress));
  const [atRisk, setAtRisk] = useState(goal.status === 'at_risk');
  const [error, setError] = useState<{ at: Where; text: string } | null>(null);
  const ids = useId();
  const view = goalCardView({ progress: typedProgress(progress, goal.progress), status: goal.status });
  const showChoice = view.showAtRisk;
  const unchanged = progress.trim() === String(goal.progress) && (!showChoice || atRisk === (goal.status === 'at_risk'));

  function run(at: Where, call: () => Promise<GoalResult>, after?: () => void) {
    setError(null);
    setPressed(at);
    start(async () => {
      let result: GoalResult;
      try {
        result = await call();
      } catch {
        result = { ok: false, error: WRITE_FAILED };
      }
      setPressed(null);
      if (result.ok) after?.();
      else setError({ at, text: result.error ?? WRITE_FAILED });
    });
  }

  function saveProgress() {
    const converted = goalProgressInput(goal, progress, atRisk);
    if (!converted.ok) {
      setError({ at: 'progress', text: converted.error });
      return;
    }
    run('progress', () => save(converted.input));
  }

  if (mode === 'edit') {
    return <GoalForm initial={goal} save={save} onDone={() => setMode('view')} onCancel={() => setMode('view')} />;
  }

  return (
    <div className="space-y-2" onKeyDown={(event) => {
      if (event.key === 'Escape' && mode === 'confirm' && !busy) {
        event.stopPropagation();
        setError(null);
        setMode('view');
      }
    }}>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          saveProgress();
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-progress`}>
          Progress (%)
          <Input
            id={`${ids}-progress`}
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            className="h-7 w-20 text-xs"
            disabled={busy}
            value={progress}
            onChange={(event) => {
              setError(null);
              setProgress(event.target.value);
            }}
          />
        </label>
        {showChoice ? (
          <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-risk`}>
            Where it stands
            <select
              id={`${ids}-risk`}
              className={SELECT_CLASS}
              disabled={busy}
              value={atRisk ? 'at_risk' : 'on_track'}
              onChange={(event) => {
                setError(null);
                setAtRisk(event.target.value === 'at_risk');
              }}
            >
              <option value="on_track">On track</option>
              <option value="at_risk">At risk</option>
            </select>
          </label>
        ) : (
          <span className="pb-1 text-xs text-muted-foreground">Done</span>
        )}
        <Button type="submit" variant="outline" size="sm" className="h-7 px-2.5 text-xs" disabled={busy || unchanged}>
          {pressed === 'progress' ? 'Working…' : 'Update'}
        </Button>
      </form>
      {error?.at === 'progress' ? (
        <p role="alert" className="text-xs text-destructive">
          {error.text}
        </p>
      ) : null}

      {mode === 'confirm' ? (
        <div className="space-y-1.5">
          <p className="text-xs">Remove this goal? This cannot be undone.</p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="h-7 px-2.5 text-xs"
              disabled={busy}
              onClick={() => run('remove', () => remove({ goal_id: goal.id }))}
            >
              {pressed === 'remove' ? 'Working…' : 'Remove goal'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-xs"
              autoFocus
              data-autofocus
              disabled={busy}
              onClick={() => {
                setError(null);
                setMode('view');
              }}
            >
              Keep
            </Button>
          </div>
          {error?.at === 'remove' ? (
            <p role="alert" className="text-xs text-destructive">
              {error.text}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={busy}
            aria-label={`Edit goal ${goal.title}`}
            onClick={() => {
              setError(null);
              setMode('edit');
            }}
          >
            <Pencil aria-hidden />
            Edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
            disabled={busy}
            aria-label={`Remove goal ${goal.title}`}
            onClick={() => {
              setError(null);
              setMode('confirm');
            }}
          >
            <Trash2 aria-hidden />
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}
