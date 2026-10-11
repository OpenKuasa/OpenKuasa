/**
 * The rules behind the Goals and Training controls that can be said without a browser: which one control a member
 * sees on a course, what an owner may remove and why not, which employees can still be enrolled, and what a goal
 * card holds. Pure. Course status, enrolling and withdrawing come only from `performance-forms.ts`; today is the
 * Malaysia date the caller passes in. The database re-checks everything; these say it in words first.
 */
import { canSelfEnrol, canSelfWithdraw, courseStarted, toGoalInput } from './performance-forms';
import { showsWriteControls } from './reviews-announcements';
import type { Employee, Goal } from './types';

type CourseDates = { starts_on: string | null; ends_on: string | null };

// ---- Training: a member -------------------------------------------------------

export type MemberCourseControl = 'enrol' | 'withdraw' | 'enrolled' | 'completed' | 'none';

/**
 * The one thing a member sees on a course: Enrol, Withdraw, "You are enrolled" or "Completed". An account with no
 * employee record, and the demo, see none.
 */
export function memberCourseControl(
  course: CourseDates,
  enrolment: { completed: boolean } | null,
  today: string,
  who: { linked: boolean; isDemo: boolean },
): MemberCourseControl {
  if (!who.linked || who.isDemo) return 'none';
  if (enrolment === null) return canSelfEnrol(course, today) ? 'enrol' : 'none';
  if (enrolment.completed) return 'completed';
  return canSelfWithdraw(course, enrolment, today) ? 'withdraw' : 'enrolled';
}

// ---- Training: an owner or admin ------------------------------------------------

type Removal = { allowed: true; reason: null } | { allowed: false; reason: string };

/** Marking someone completed needs the course to have started (undoing it never does). */
export const canMarkCompleted = (course: CourseDates, today: string): boolean => courseStarted(course, today);

/** A course with anyone marked completed cannot be removed; the sentence counts them from the data. */
export function courseRemoval(people: { completed: boolean }[]): Removal {
  const done = people.filter((p) => p.completed).length;
  if (done === 0) return { allowed: true, reason: null };
  const who = done === 1 ? '1 person is' : `${done} people are`;
  return { allowed: false, reason: `${who} marked as completed. Undo that first to remove the course.` };
}

/** Someone marked completed cannot be removed from the course until it is undone. */
export function enrolmentRemoval(person: { completed: boolean }): Removal {
  return person.completed
    ? { allowed: false, reason: 'Marked as completed. Undo that first to remove them.' }
    : { allowed: true, reason: null };
}

/** The active employees not yet on the course, by name. */
export function enrolCandidates(employees: Employee[], enrolled: { employee_id: string }[]): { id: string; name: string }[] {
  const taken = new Set(enrolled.map((e) => e.employee_id));
  return employees
    .filter((e) => e.status === 'active' && !taken.has(e.id))
    .map((e) => ({ id: e.id, name: e.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Goals ------------------------------------------------------------------------

export type GoalLike = Pick<Goal, 'id' | 'title' | 'progress' | 'due_date' | 'status'>;

const GOAL_LABEL = { on_track: 'On track', at_risk: 'At risk', done: 'Done' } as const;

/** Progress as typed when it is a whole number of up to three digits, else the saved progress. */
export const typedProgress = (text: string, fallback: number): number => (/^\d{1,3}$/.test(text.trim()) ? Number(text.trim()) : fallback);

/**
 * The one source for a goal card: its label, whether it is Done, and whether the at-risk choice shows. At 100 the
 * goal is Done whatever the stored status, and the choice is hidden. Pass the progress as typed (see `typedProgress`).
 */
export function goalCardView(goal: { progress: number; status: Goal['status'] }): { done: boolean; label: string; showAtRisk: boolean } {
  const done = goal.progress >= 100;
  return { done, label: done ? 'Done' : GOAL_LABEL[goal.status === 'done' ? 'on_track' : goal.status], showAtRisk: !done };
}

/** A progress change on a card: the title and due date stay, a finished goal is never sent as at risk. */
export function goalProgressInput(goal: GoalLike, progressText: string, atRisk: boolean) {
  const converted = toGoalInput({
    title: goal.title,
    progress: progressText,
    due_date: goal.due_date ?? '',
    at_risk: atRisk && goalCardView({ progress: typedProgress(progressText, goal.progress), status: goal.status }).showAtRisk,
  });
  return converted.ok ? { ok: true as const, input: { goal_id: goal.id, ...converted.input } } : converted;
}

/** Goals grouped by employee: dated ones first by date, then the rest by title. */
export function goalsByEmployee(goals: Goal[]): Record<string, GoalLike[]> {
  const grouped: Record<string, GoalLike[]> = {};
  for (const g of goals) {
    (grouped[g.employee_id] ??= []).push({ id: g.id, title: g.title, progress: g.progress, due_date: g.due_date, status: g.status });
  }
  for (const list of Object.values(grouped)) {
    list.sort((a, b) => {
      if (a.due_date !== b.due_date) {
        if (a.due_date === null) return 1;
        if (b.due_date === null) return -1;
        return a.due_date < b.due_date ? -1 : 1;
      }
      return a.title.localeCompare(b.title);
    });
  }
  return grouped;
}

// ---- What a screen renders for a viewer -------------------------------------------------

type ViewerKind = { isHr: boolean; isDemo: boolean; employeeId: string | null };

/**
 * Training: owner controls (Add course, Manage) only for an owner or admin outside the demo and with the data
 * loaded; placeholders only in the demo; the enrol column only for a linked member.
 */
export function trainingScreenControls(viewer: ViewerKind, loaded: boolean) {
  return {
    owner: loaded && showsWriteControls(viewer),
    demoPlaceholders: viewer.isDemo,
    memberEnrol: loaded && !viewer.isHr && !viewer.isDemo && viewer.employeeId !== null,
  };
}

/** My Goals: card controls with the data loaded outside the demo; Add only when linked; the placeholder only in the demo. */
export function myGoalsControls(viewer: ViewerKind, loaded: { linked: boolean } | null) {
  return {
    cards: !viewer.isDemo && loaded !== null,
    add: !viewer.isDemo && loaded !== null && loaded.linked,
    placeholder: viewer.isDemo,
  };
}

/** Employees: the "Goals" row action needs a table that can edit and goals that loaded. */
export const showGoalsAction = (canEdit: boolean, goals: unknown | null): boolean => canEdit && goals !== null;
