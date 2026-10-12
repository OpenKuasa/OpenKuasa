'use client';

import { useId, useState, useTransition } from 'react';
import {
  deleteTrainingAction,
  enrolAction,
  setTrainingCompletedAction,
  unenrolAction,
} from '@/app/(app)/people/performance-actions';
import { Button } from '@/components/ui/button';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { canMarkCompleted, courseRemoval, enrolmentRemoval } from '@/lib/people/goals-training';
import { type CourseValues, CourseForm } from './course-form';
import { RowPrompt, usePromptId } from './request-row';

export type CoursePerson = { employee_id: string; name: string; completed: boolean; completed_at: string | null };
type Mode = 'people' | 'edit' | 'remove' | null;
type Result = { ok: boolean; error?: string };

const SELECT_CLASS =
  'h-7 rounded-lg border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';
const SMALL = 'h-7 px-2.5 text-xs';

/**
 * An owner's or admin's controls on one course, in its table row: People (who is enrolled, with Enrol someone, Remove
 * and Mark completed), Edit and Remove. Each opens in the row's own prompt area. `today` is the Malaysia date the
 * screen worked out. Rules shown here are the pure ones in `goals-training.ts`; the database decides in the end.
 * A refusal shows beside the control used and clears when that control is used again or changes.
 */
export function CourseAdmin({
  course,
  people,
  candidates,
  today,
}: {
  course: CourseValues;
  people: CoursePerson[];
  candidates: { id: string; name: string }[];
  today: string;
}) {
  const [busy, start] = useTransition();
  const [mode, setMode] = useState<Mode>(null);
  const [key, setKey] = useState<string | null>(null);
  // A refusal belongs to the state it was given for: when the course or who is on it changes after a refresh, it goes.
  const signature = JSON.stringify([course, people]);
  const [held, setHeld] = useState<{ sig: string; map: Record<string, string> }>({ sig: '', map: {} });
  const errors = held.sig === signature ? held.map : {};
  const setErrors = (update: Record<string, string> | ((current: Record<string, string>) => Record<string, string>)) =>
    setHeld((current) => {
      const map = current.sig === signature ? current.map : {};
      return { sig: signature, map: typeof update === 'function' ? update(map) : update };
    });
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const promptId = usePromptId();
  const ids = useId();
  const removal = courseRemoval(people);
  const mayMark = canMarkCompleted(course, today);
  const fresh = candidates.some((c) => c.id === pick) ? pick : '';

  const clear = (which: string) =>
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([name]) => name !== which)));
  function open(next: Exclude<Mode, null>) {
    if (mode === next) return; // a second press of the same button leaves it open
    setErrors({});
    setConfirmId(null);
    setMode(next);
  }
  function close() {
    setErrors({});
    setConfirmId(null);
    setMode(null);
  }

  function run(which: string, call: () => Promise<Result>, after?: () => void) {
    clear(which);
    setKey(which);
    start(async () => {
      let result: Result;
      try {
        result = await call();
      } catch {
        result = { ok: false, error: WRITE_FAILED };
      }
      setKey(null);
      if (result.ok) after?.();
      else setErrors((current) => ({ ...current, [which]: result.error ?? WRITE_FAILED }));
    });
  }

  const err = (which: string) =>
    errors[which] ? (
      <p role="alert" className="text-xs text-destructive">
        {errors[which]}
      </p>
    ) : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        <Button type="button" variant="outline" size="sm" className={SMALL} disabled={busy} aria-expanded={mode === 'people'} aria-controls={promptId} onClick={() => open('people')}>
          People ({people.length})
        </Button>
        <Button type="button" variant="ghost" size="sm" className={SMALL} disabled={busy} aria-expanded={mode === 'edit'} aria-controls={promptId} aria-label={`Edit ${course.title}`} onClick={() => open('edit')}>
          Edit
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`${SMALL} text-destructive hover:text-destructive`}
          disabled={busy || !removal.allowed}
          aria-expanded={mode === 'remove'}
          aria-controls={promptId}
          aria-label={`Remove ${course.title}`}
          onClick={() => open('remove')}
        >
          Remove
        </Button>
      </div>
      {removal.reason ? <p className="mt-1 max-w-56 whitespace-normal text-xs text-muted-foreground">{removal.reason}</p> : null}

      {mode ? (
        <RowPrompt focusKey={mode} onEscape={close}>
          {mode === 'edit' ? (
            <CourseForm initial={course} onDone={close} onCancel={close} />
          ) : mode === 'remove' ? (
            <div className="space-y-1.5">
              <p className="text-xs">
                Remove {course.title}? {people.length > 0 ? `Everyone enrolled (${people.length}) is removed from it too. ` : ''}This cannot be undone.
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className={SMALL}
                  disabled={busy}
                  onClick={() => run('remove', () => deleteTrainingAction({ training_id: course.id }), close)}
                >
                  {key === 'remove' ? 'Working…' : 'Remove course'}
                </Button>
                <Button type="button" variant="ghost" size="sm" className={SMALL} data-autofocus disabled={busy} onClick={close}>
                  Keep
                </Button>
              </div>
              {err('remove')}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs font-medium">Enrolled in {course.title}</p>
              {people.length === 0 ? <p className="text-xs text-muted-foreground">No one is enrolled yet.</p> : null}
              <ul className="space-y-2">
                {people.map((person) => {
                  const mine = enrolmentRemoval(person);
                  const doneKey = `done:${person.employee_id}`;
                  const removeKey = `remove:${person.employee_id}`;
                  return (
                    <li key={person.employee_id} className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium">{person.name}</span>
                        <span className="text-xs text-muted-foreground">{person.completed ? 'Completed' : 'Enrolled'}</span>
                        {person.completed ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className={SMALL}
                            disabled={busy}
                            aria-label={`Undo completion for ${person.name}`}
                            onClick={() =>
                              run(doneKey, () => setTrainingCompletedAction({ training_id: course.id, employee_id: person.employee_id, completed: false }))
                            }
                          >
                            {key === doneKey ? 'Working…' : 'Undo completion'}
                          </Button>
                        ) : mayMark ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className={SMALL}
                            disabled={busy}
                            aria-label={`Mark ${person.name} completed`}
                            onClick={() =>
                              run(doneKey, () => setTrainingCompletedAction({ training_id: course.id, employee_id: person.employee_id, completed: true }))
                            }
                          >
                            {key === doneKey ? 'Working…' : 'Mark completed'}
                          </Button>
                        ) : null}
                        {confirmId === person.employee_id ? null : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className={`${SMALL} text-destructive hover:text-destructive`}
                            disabled={busy || !mine.allowed}
                            aria-label={`Remove ${person.name} from ${course.title}`}
                            onClick={() => {
                              clear(removeKey);
                              setConfirmId(person.employee_id);
                            }}
                          >
                            Remove
                          </Button>
                        )}
                        {!mine.allowed && confirmId !== person.employee_id ? <span className="text-xs text-muted-foreground">{mine.reason}</span> : null}
                      </div>
                      {err(doneKey)}
                      {confirmId === person.employee_id ? (
                        <div className="space-y-1">
                          <p className="text-xs">Remove {person.name} from this course?</p>
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              className={SMALL}
                              disabled={busy}
                              onClick={() =>
                                run(removeKey, () => unenrolAction({ training_id: course.id, employee_id: person.employee_id }), () => setConfirmId(null))
                              }
                            >
                              {key === removeKey ? 'Working…' : 'Remove'}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className={SMALL}
                              data-autofocus
                              disabled={busy}
                              onClick={() => {
                                clear(removeKey);
                                setConfirmId(null);
                              }}
                            >
                              Keep
                            </Button>
                          </div>
                          {err(removeKey)}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {!mayMark && people.length > 0 ? (
                <p className="text-xs text-muted-foreground">Completion can be marked once the course has started.</p>
              ) : null}

              <div className="space-y-1 border-t pt-2">
                {candidates.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Everyone active is already enrolled.</p>
                ) : (
                  <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (fresh === '') return;
                      run('enrol', () => enrolAction({ training_id: course.id, employee_id: fresh }), () => setPick(''));
                    }}
                  >
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-who`}>
                      Enrol someone
                      <select
                        id={`${ids}-who`}
                        className={SELECT_CLASS}
                        disabled={busy}
                        value={fresh}
                        onChange={(event) => {
                          clear('enrol');
                          setPick(event.target.value);
                        }}
                      >
                        <option value="">Choose an employee</option>
                        {candidates.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button type="submit" size="sm" className={SMALL} disabled={busy || fresh === ''}>
                      {key === 'enrol' ? 'Working…' : 'Enrol'}
                    </Button>
                  </form>
                )}
                {err('enrol')}
              </div>
              <Button type="button" variant="ghost" size="sm" className={SMALL} disabled={busy} onClick={close}>
                Close
              </Button>
            </div>
          )}
        </RowPrompt>
      ) : null}
    </>
  );
}
