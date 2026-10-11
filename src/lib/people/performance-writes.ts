/**
 * The app's write path for goals, reviews and training. Every change is one call to a database function
 * (`hr_save_goal`, `hr_release_review`, ...): the tables take no direct writes, and the functions decide who may do
 * what. This file only checks the shape of an input, makes the call and turns a refusal into a sentence. No score
 * is worked out here: a review's `score` is the row's.
 *
 * A refusal arrives as a Postgres error whose message is a bare code, for example `PERF_NOT_DRAFT`. The acting user
 * is the session's. The workspace is the context's (never the input's); the employee comes from the input only for
 * the owner and admin actions, and from the viewer for a member's own. Nothing typed (a goal's title, a review's
 * comment, a course's name) and no score is ever logged: only the database's code and the function's name.
 */
import { z } from 'zod';
import {
  type CapResult,
  type PeopleWriteContext,
} from './capabilities';
import { isRealDate } from './dates';
import { blank } from './loose-input';
import { PERFORMANCE_REFUSALS } from './performance-refusals';
import { type Row, call, guid, isRow, optionalGuid, parse, text } from './performance-rpc';
import { COMPETENCIES, type Competency, type ReviewStatus } from './types';

// ---- Sentences ---------------------------------------------------------------

export { PERFORMANCE_REFUSALS };

// ---- Inputs --------------------------------------------------------------------

/** An optional text that is empty (or blank) when none: sent to the database as null. */
const optionalText = (max: number, message: string) =>
  z
    .preprocess((value) => (typeof value === 'string' ? blank(value) : value), z.string().max(max, message).nullable())
    .optional();

const title = (max: number) =>
  z.string().trim().min(1, 'Give it a title.').max(max, `Keep the title to ${max} characters.`);

const goalDate = z
  .preprocess(
    (value) => (typeof value === 'string' ? blank(value) : value),
    z
      .string()
      .refine((date) => isRealDate(date) && date >= '2000-01-01' && date <= '2100-12-31', 'Enter a real due date between 2000 and 2100.')
      .nullable(),
  )
  .optional();

const score = z
  .number('Score each competency from 1 to 5.')
  .min(1, 'Score each competency from 1 to 5 in half steps.')
  .max(5, 'Score each competency from 1 to 5 in half steps.')
  .refine((n) => Number.isInteger(n * 2), 'Score each competency from 1 to 5 in half steps.');

const date = (what: string) => z.string(`Enter ${what}.`).refine(isRealDate, `Enter ${what} as a real date.`);

export const saveGoalInput = z.object({
  employee_id: guid('The employee whose goal it is, by their id.'),
  goal_id: optionalGuid('The goal to change, by its id. Leave out to add one.'),
  title: title(200),
  progress: z.number('Progress must be a number.').int('Progress must be a whole number.').min(0, 'Progress cannot be below 0.').max(100, 'Progress cannot be above 100.'),
  due_date: goalDate,
  at_risk: z.boolean().optional(),
});
export const goalIdInput = z.object({ goal_id: guid('The goal, by its id.') });

export const saveReviewInput = z.object({
  employee_id: guid('The employee reviewed, by their id.'),
  review_id: optionalGuid('The draft review to change, by its id. Leave out to add one.'),
  period: z.string().regex(/^(H1|H2|FY) (20\d\d|2100)$/, 'The period must be like H1 2026, H2 2026 or FY 2026.'),
  competencies: z.strictObject({
    Delivery: score,
    Teamwork: score,
    Ownership: score,
    Communication: score,
  }),
  rating: z.enum(['exceeds', 'meets', 'below'], 'Choose exceeds, meets or below.'),
  comment: optionalText(2000, 'Keep the comment to 2,000 characters.'),
});
export const reviewIdInput = z.object({ review_id: guid('The review, by its id.') });

export const saveTrainingInput = z
  .object({
    training_id: optionalGuid('The course to change, by its id. Leave out to add one.'),
    title: title(200),
    category: optionalText(80, 'Keep the category to 80 characters.'),
    provider: optionalText(80, 'Keep the provider to 80 characters.'),
    starts_on: date('the first day of the course'),
    ends_on: date('the last day of the course'),
  })
  .refine((v) => !isRealDate(v.starts_on) || !isRealDate(v.ends_on) || v.ends_on >= v.starts_on, {
    message: 'The last day cannot be before the first day.',
    path: ['ends_on'],
  });
export const trainingIdInput = z.object({ training_id: guid('The course, by its id.') });
export const enrolmentInput = z.object({
  training_id: guid('The course, by its id.'),
  employee_id: guid('The employee, by their id.'),
});
export const completionInput = z.object({
  training_id: guid('The course, by its id.'),
  employee_id: guid('The employee, by their id.'),
  // Required: a missing flag is refused, never read as true or false.
  completed: z.boolean('Say whether they completed it.'),
});

// ---- Replies ---------------------------------------------------------------------

const textOrNull = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' ? value : undefined;
export type SavedGoal = {
  id: string;
  employee_id: string;
  title: string;
  progress: number;
  /** `YYYY-MM-DD`, or null when there is no due date. */
  due_date: string | null;
  status: 'on_track' | 'at_risk' | 'done';
};

export type SavedReview = {
  id: string;
  employee_id: string;
  period: string;
  competencies: Record<Competency, number>;
  /** The average of the four, set by the database. */
  score: number;
  rating: 'exceeds' | 'meets' | 'below';
  comment: string | null;
  status: ReviewStatus;
  released_at: string | null;
  reviewer_name: string | null;
  /** `YYYY-MM-DD`, the Malaysia date of the last save. */
  reviewed_at: string | null;
};

export type SavedTraining = {
  id: string;
  title: string;
  category: string | null;
  provider: string | null;
  starts_on: string;
  ends_on: string;
};

function pickGoal(row: Row): SavedGoal | null {
  const id = text(row.id);
  const employeeId = text(row.employee_id);
  const name = text(row.title);
  const due = textOrNull(row.due_date);
  const status = row.status === 'on_track' || row.status === 'at_risk' || row.status === 'done' ? row.status : null;
  if (!id || !employeeId || !name || due === undefined || !status) return null;
  if (typeof row.progress !== 'number' || !Number.isFinite(row.progress)) return null;
  return { id, employee_id: employeeId, title: name, progress: row.progress, due_date: due, status };
}

function pickReview(row: Row): SavedReview | null {
  const id = text(row.id);
  const employeeId = text(row.employee_id);
  const period = text(row.period);
  const rating = row.rating === 'exceeds' || row.rating === 'meets' || row.rating === 'below' ? row.rating : null;
  const status = row.status === 'draft' || row.status === 'released' ? row.status : null;
  const comment = textOrNull(row.comment);
  const releasedAt = textOrNull(row.released_at);
  const reviewer = textOrNull(row.reviewer_name);
  const reviewedAt = textOrNull(row.reviewed_at);
  if (!id || !employeeId || !period || !rating || !status) return null;
  if (comment === undefined || releasedAt === undefined || reviewer === undefined || reviewedAt === undefined) return null;
  if (typeof row.score !== 'number' || !Number.isFinite(row.score) || !isRow(row.competencies)) return null;
  const competencies: Partial<Record<Competency, number>> = {};
  for (const name of COMPETENCIES) {
    const value = row.competencies[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    competencies[name] = value;
  }
  return {
    id,
    employee_id: employeeId,
    period,
    competencies: competencies as Record<Competency, number>,
    score: row.score,
    rating,
    comment,
    status,
    released_at: releasedAt,
    reviewer_name: reviewer,
    reviewed_at: reviewedAt,
  };
}

function pickTraining(row: Row): SavedTraining | null {
  const id = text(row.id);
  const name = text(row.title);
  const category = textOrNull(row.category);
  const provider = textOrNull(row.provider);
  const starts = text(row.starts_on);
  const ends = text(row.ends_on);
  if (!id || !name || category === undefined || provider === undefined || !starts || !ends) return null;
  return { id, title: name, category, provider, starts_on: starts, ends_on: ends };
}

const pickIds = (...keys: string[]) => (row: Row): Record<string, string> | null => {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = text(row[key]);
    if (!value) return null;
    out[key] = value;
  }
  return out;
};

// ---- Goals -------------------------------------------------------------------------

/** Adds a goal for the employee (no `goal_id`) or changes one of theirs. Progress 100 makes it done; below that `at_risk` chooses. */
export async function saveGoal(
  ctx: PeopleWriteContext,
  input: z.input<typeof saveGoalInput>,
): Promise<CapResult<SavedGoal>> {
  const parsed = parse(saveGoalInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return call(
    ctx,
    'saveGoal',
    'hr_save_goal',
    {
      p_employee: v.employee_id,
      p_goal: v.goal_id ?? null,
      p_title: v.title,
      p_progress: v.progress,
      p_due_date: v.due_date ?? null,
      p_at_risk: v.at_risk ?? false,
    },
    pickGoal,
  );
}

/** Removes a goal. The database checks it is the caller's own, or the caller an owner or admin. */
export async function deleteGoal(
  ctx: PeopleWriteContext,
  input: z.infer<typeof goalIdInput>,
): Promise<CapResult<{ id: string; employee_id: string }>> {
  const parsed = parse(goalIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'deleteGoal', 'hr_delete_goal', { p_goal: parsed.data.goal_id }, (row) => {
    const ids = pickIds('id', 'employee_id')(row);
    return ids ? { id: ids.id, employee_id: ids.employee_id } : null;
  });
}

// ---- Reviews -------------------------------------------------------------------------

/** Adds a draft review (no `review_id`) or changes a draft. The database works out the overall score. */
export async function saveReview(
  ctx: PeopleWriteContext,
  input: z.input<typeof saveReviewInput>,
): Promise<CapResult<SavedReview>> {
  const parsed = parse(saveReviewInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return call(
    ctx,
    'saveReview',
    'hr_save_review',
    {
      p_employee: v.employee_id,
      p_review: v.review_id ?? null,
      p_period: v.period,
      p_competencies: v.competencies,
      p_rating: v.rating,
      p_comment: v.comment ?? null,
    },
    pickReview,
  );
}

/** Draft to released: from now the employee reads it. */
export async function releaseReview(
  ctx: PeopleWriteContext,
  input: z.infer<typeof reviewIdInput>,
): Promise<CapResult<SavedReview>> {
  const parsed = parse(reviewIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'releaseReview', 'hr_release_review', { p_review: parsed.data.review_id }, pickReview);
}

/** Released to draft: the employee no longer reads it. Offered on the Review Scores screen only, never as an assistant tool. */
export async function unreleaseReview(
  ctx: PeopleWriteContext,
  input: z.infer<typeof reviewIdInput>,
): Promise<CapResult<SavedReview>> {
  const parsed = parse(reviewIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'unreleaseReview', 'hr_unrelease_review', { p_review: parsed.data.review_id }, pickReview);
}

/** Deletes a draft review. */
export async function deleteReview(
  ctx: PeopleWriteContext,
  input: z.infer<typeof reviewIdInput>,
): Promise<CapResult<{ id: string; employee_id: string }>> {
  const parsed = parse(reviewIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'deleteReview', 'hr_delete_review', { p_review: parsed.data.review_id }, (row) => {
    const ids = pickIds('id', 'employee_id')(row);
    return ids ? { id: ids.id, employee_id: ids.employee_id } : null;
  });
}

// ---- Training --------------------------------------------------------------------------

/** Adds a course (no `training_id`) or changes one. The workspace is the context's. */
export async function saveTraining(
  ctx: PeopleWriteContext,
  input: z.input<typeof saveTrainingInput>,
): Promise<CapResult<SavedTraining>> {
  const parsed = parse(saveTrainingInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return call(
    ctx,
    'saveTraining',
    'hr_save_training',
    {
      p_org: ctx.orgId,
      p_training: v.training_id ?? null,
      p_title: v.title,
      p_category: v.category ?? null,
      p_provider: v.provider ?? null,
      p_starts_on: v.starts_on,
      p_ends_on: v.ends_on,
    },
    pickTraining,
  );
}

/** Deletes a course and its enrolments, unless someone is marked completed on it. */
export async function deleteTraining(
  ctx: PeopleWriteContext,
  input: z.infer<typeof trainingIdInput>,
): Promise<CapResult<{ id: string }>> {
  const parsed = parse(trainingIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'deleteTraining', 'hr_delete_training', { p_training: parsed.data.training_id }, (row) => {
    const id = text(row.id);
    return id ? { id } : null;
  });
}

/** Enrols the employee. A member may enrol only themselves, while the course has not ended. */
export async function enrol(
  ctx: PeopleWriteContext,
  input: z.infer<typeof enrolmentInput>,
): Promise<CapResult<{ training_id: string; employee_id: string; completed: boolean }>> {
  const parsed = parse(enrolmentInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return call(ctx, 'enrol', 'hr_enrol', { p_training: v.training_id, p_employee: v.employee_id }, (row) => {
    const ids = pickIds('training_id', 'employee_id')(row);
    return ids && typeof row.completed === 'boolean'
      ? { training_id: ids.training_id, employee_id: ids.employee_id, completed: row.completed }
      : null;
  });
}

/** Removes the enrolment. A member may withdraw only themselves, until the course starts. */
export async function unenrol(
  ctx: PeopleWriteContext,
  input: z.infer<typeof enrolmentInput>,
): Promise<CapResult<{ training_id: string; employee_id: string }>> {
  const parsed = parse(enrolmentInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return call(ctx, 'unenrol', 'hr_unenrol', { p_training: v.training_id, p_employee: v.employee_id }, (row) => {
    const ids = pickIds('training_id', 'employee_id')(row);
    return ids ? { training_id: ids.training_id, employee_id: ids.employee_id } : null;
  });
}

/** Marks an enrolled employee completed once the course has started; undoing it is always allowed. */
export async function setTrainingCompleted(
  ctx: PeopleWriteContext,
  input: z.infer<typeof completionInput>,
): Promise<CapResult<{ training_id: string; employee_id: string; completed: boolean }>> {
  const parsed = parse(completionInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return call(
    ctx,
    'setTrainingCompleted',
    'hr_set_training_completed',
    { p_training: v.training_id, p_employee: v.employee_id, p_completed: v.completed },
    (row) => {
      const ids = pickIds('training_id', 'employee_id')(row);
      return ids && typeof row.completed === 'boolean'
        ? { training_id: ids.training_id, employee_id: ids.employee_id, completed: row.completed }
        : null;
    },
  );
}
