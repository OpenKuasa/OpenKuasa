'use client';

import { useState } from 'react';
import { Flag, Plus } from 'lucide-react';
import { deleteGoalForAction, saveGoalForAction } from '@/app/(app)/people/performance-actions';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { formatDate } from '@/lib/people/dates';
import { type GoalLike, goalCardView } from '@/lib/people/goals-training';
import { GoalCardControls } from './goal-card-controls';
import { GoalForm } from './goal-form';

/**
 * One employee's goals for an owner or admin (opened from the Employees screen): the same cards and controls as
 * My Goals, but saving and removing through the owner actions, with the employee named here and not typed anywhere.
 */
export function EmployeeGoals({ employeeId, name, goals }: { employeeId: string; name: string; goals: GoalLike[] }) {
  const [adding, setAdding] = useState(false);
  const save = (input: Record<string, unknown>) => saveGoalForAction({ ...input, employee_id: employeeId });
  const remove = (input: { goal_id: string }) => deleteGoalForAction(input);

  return (
    <div className="space-y-3">
      {adding ? (
        <div className="rounded-lg border p-3">
          <GoalForm initial={null} save={save} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
        </div>
      ) : (
        <Button type="button" size="sm" onClick={() => setAdding(true)}>
          <Plus aria-hidden />
          Add goal for {name}
        </Button>
      )}
      {goals.length === 0 ? <p className="text-sm text-muted-foreground">{name} has no goals yet.</p> : null}
      <ul className="space-y-3">
        {goals.map((goal) => {
          const view = goalCardView(goal);
          return (
            <li key={goal.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium">{goal.title}</p>
                <span className="shrink-0 text-xs text-muted-foreground">{view.label}</span>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Progress</span>
                  <span className="font-semibold tabular-nums">{goal.progress}%</span>
                </div>
                <Progress value={goal.progress} />
              </div>
              {goal.due_date ? (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Flag className="size-3.5" aria-hidden />
                  <span>Due {formatDate(goal.due_date)}</span>
                </div>
              ) : null}
              <GoalCardControls key={`${goal.id}-${goal.progress}-${goal.status}-${goal.title}-${goal.due_date}`} goal={goal} save={save} remove={remove} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
