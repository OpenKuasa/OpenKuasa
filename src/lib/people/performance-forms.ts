/**
 * What a goal, review, course or announcement form holds and what it sends, and the one place a course's status
 * and the self-service enrol and withdraw rules are worked out. Pure: no clock (callers pass today's date, in
 * Malaysia, as `YYYY-MM-DD`), no network. The database re-checks everything; these only say it in words first.
 */
import { isRealDate } from './dates';
import { COMPETENCIES, type Competency } from './types';

type Converted<T> = { ok: true; input: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

export const GOAL_TITLE_MAX = 200;
export const REVIEW_COMMENT_MAX = 2000;
export const COURSE_TITLE_MAX = 200;
export const COURSE_TAG_MAX = 80;
export const ANNOUNCEMENT_TITLE_MAX = 200;
export const ANNOUNCEMENT_BODY_MAX = 5000;

export const RATINGS = ['exceeds', 'meets', 'below'] as const;
export const ANNOUNCEMENT_CATEGORY_KEYS = ['general', 'holiday', 'benefits', 'strategy', 'policy'] as const;

// ---- Periods and scores -------------------------------------------------------

/** The periods a review can be for: the current and previous two years, each as H2, H1 and FY, newest first. */
export function reviewPeriods(today: string): string[] {
  const year = Number(today.slice(0, 4));
  return [year, year - 1, year - 2].flatMap((y) => [`H2 ${y}`, `H1 ${y}`, `FY ${y}`]);
}

/** `H1 2026`, `h1 2026`, `2026 H1`, `FY2026` and the like as `H1 2026` / `FY 2026`; null for anything else, or a year outside 2000 to 2100. */
export function toPeriod(text: string): string | null {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  const match = /^(h[12]|fy)\s*(\d{4})$/i.exec(value) ?? /^(\d{4})\s*(h[12]|fy)$/i.exec(value);
  if (!match) return null;
  const [kind, year] = /^\d/.test(match[1]) ? [match[2], match[1]] : [match[1], match[2]];
  const y = Number(year);
  if (y < 2000 || y > 2100) return null;
  return `${kind.toUpperCase()} ${year}`;
}

/** A score from 1 to 5 in steps of 0.5; text must be written plainly (`4`, `4.5`), never `5.0`, `05`, `3,5` or `1e0`. */
export function toScore(text: string | number): number | null {
  if (typeof text === 'number') {
    return Number.isFinite(text) && text >= 1 && text <= 5 && Number.isInteger(text * 2) ? text : null;
  }
  if (typeof text !== 'string' || !/^[1-5](\.5)?$/.test(text.trim())) return null;
  const score = Number(text.trim());
  return score <= 5 ? score : null;
}

// ---- Forms ----------------------------------------------------------------------

const dueDateOk = (date: string): boolean => isRealDate(date) && date >= '2000-01-01' && date <= '2100-12-31';

/** What the goal form sends. An empty due date is none. */
export function toGoalInput(values: {
  title: string;
  progress: string;
  due_date: string;
  at_risk: boolean;
}): Converted<{ title: string; progress: number; due_date: string | null; at_risk: boolean }> {
  const title = values.title.trim();
  if (title === '') return bad('Give the goal a title.');
  if (title.length > GOAL_TITLE_MAX) return bad(`Keep the title to ${GOAL_TITLE_MAX} characters.`);
  const progressText = values.progress.trim();
  const progress = /^\d{1,3}$/.test(progressText) ? Number(progressText) : NaN;
  if (!(progress >= 0 && progress <= 100)) return bad('Progress must be a whole number from 0 to 100.');
  const due = values.due_date.trim();
  if (due !== '' && !dueDateOk(due)) return bad('Enter a real due date between 2000 and 2100, or leave it empty.');
  return { ok: true, input: { title, progress, due_date: due === '' ? null : due, at_risk: values.at_risk === true } };
}

/** What the review form sends (the employee is chosen separately). Each score is named when it is wrong. */
export function toReviewInput(values: {
  period: string;
  competencies: Record<string, string | number>;
  rating: string;
  comment: string;
}): Converted<{
  period: string;
  competencies: Record<Competency, number>;
  rating: 'exceeds' | 'meets' | 'below';
  comment: string | null;
}> {
  const period = toPeriod(values.period);
  if (period === null) return bad('Choose the review period, like H1 2026, H2 2026 or FY 2026.');
  const scores: Partial<Record<Competency, number>> = {};
  for (const name of COMPETENCIES) {
    const score = toScore(values.competencies?.[name] as string | number);
    if (score === null) return bad(`Score ${name} from 1 to 5 in half steps, like 4 or 4.5.`);
    scores[name] = score;
  }
  const rating = (RATINGS as readonly string[]).includes(values.rating) ? (values.rating as (typeof RATINGS)[number]) : null;
  if (rating === null) return bad('Choose whether it exceeds, meets or is below expectations.');
  const comment = values.comment.trim();
  if (comment.length > REVIEW_COMMENT_MAX) return bad(`Keep the comment to ${REVIEW_COMMENT_MAX} characters.`);
  return {
    ok: true,
    input: { period, competencies: scores as Record<Competency, number>, rating, comment: comment === '' ? null : comment },
  };
}

/** What the course form sends. Category and provider are optional; both dates are needed and the end is not before the start. */
export function toTrainingInput(values: {
  title: string;
  category: string;
  provider: string;
  starts_on: string;
  ends_on: string;
}): Converted<{
  title: string;
  category: string | null;
  provider: string | null;
  starts_on: string;
  ends_on: string;
}> {
  const title = values.title.trim();
  if (title === '') return bad('Give the course a title.');
  if (title.length > COURSE_TITLE_MAX) return bad(`Keep the title to ${COURSE_TITLE_MAX} characters.`);
  const category = values.category.trim();
  const provider = values.provider.trim();
  if (category.length > COURSE_TAG_MAX) return bad(`Keep the category to ${COURSE_TAG_MAX} characters.`);
  if (provider.length > COURSE_TAG_MAX) return bad(`Keep the provider to ${COURSE_TAG_MAX} characters.`);
  const starts_on = values.starts_on.trim();
  const ends_on = values.ends_on.trim();
  if (!isRealDate(starts_on)) return bad('Enter the first day of the course.');
  if (!isRealDate(ends_on)) return bad('Enter the last day of the course.');
  if (ends_on < starts_on) return bad('The last day cannot be before the first day.');
  return {
    ok: true,
    input: { title, category: category === '' ? null : category, provider: provider === '' ? null : provider, starts_on, ends_on },
  };
}

/** What the announcement form sends. The body is kept as typed. Whether it is published is a separate choice. */
export function toAnnouncementInput(values: {
  title: string;
  body: string;
  category: string;
}): Converted<{ title: string; body: string; category: (typeof ANNOUNCEMENT_CATEGORY_KEYS)[number] }> {
  const title = values.title.trim();
  if (title === '') return bad('Give the announcement a title.');
  if (title.length > ANNOUNCEMENT_TITLE_MAX) return bad(`Keep the title to ${ANNOUNCEMENT_TITLE_MAX} characters.`);
  if (values.body.length > ANNOUNCEMENT_BODY_MAX) return bad(`Keep the text to ${ANNOUNCEMENT_BODY_MAX} characters.`);
  const category = (ANNOUNCEMENT_CATEGORY_KEYS as readonly string[]).includes(values.category)
    ? (values.category as (typeof ANNOUNCEMENT_CATEGORY_KEYS)[number])
    : null;
  if (category === null) return bad('Choose a category.');
  return { ok: true, input: { title, body: values.body, category } };
}

// ---- Courses ----------------------------------------------------------------------

type CourseDates = { starts_on: string | null; ends_on: string | null };

/** The database's rule: ended once today is after the last day; started from the first day. A date a course lacks is never reached. */
export const courseEnded = (course: CourseDates, today: string): boolean => course.ends_on !== null && today > course.ends_on;
export const courseStarted = (course: CourseDates, today: string): boolean => course.starts_on !== null && today >= course.starts_on;

/** The one place a course's status is worked out. `today` is the Malaysia date. A course with no dates is upcoming. */
export function courseStatus(course: CourseDates, today: string): 'upcoming' | 'in_progress' | 'completed' {
  if (courseEnded(course, today)) return 'completed';
  return courseStarted(course, today) ? 'in_progress' : 'upcoming';
}

/** A member may enrol themselves while the course has not ended. */
export const canSelfEnrol = (course: CourseDates, today: string): boolean => !courseEnded(course, today);

/** A member may withdraw while the course has not started and they are not marked completed. */
export function canSelfWithdraw(course: CourseDates, enrolment: { completed: boolean } | null, today: string): boolean {
  return enrolment !== null && !enrolment.completed && !courseStarted(course, today);
}
