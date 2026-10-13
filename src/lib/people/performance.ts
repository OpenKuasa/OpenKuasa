/**
 * Models for the four performance screens: My Goals, Scorecard, Review Scores
 * and Training. Pure functions over the rows the database let the viewer read.
 * Scores are 1 to 5. On a team screen a member is never shown a figure titled
 * as the team's: their model carries `team: false` and no team figures.
 *
 * A draft review is invisible to the person it is about. The database already
 * refuses to hand it over; these models filter again, so a member's figures are
 * built from their own RELEASED reviews only, and for owners and admins every
 * average counts released reviews only (a draft is listed and marked, never
 * counted). A review written before the competencies existed has `{}` for them:
 * it counts in the score averages and adds nothing to the competency ones.
 */

import { formatDate, formatDay } from './dates';
import { departmentAverages, isTeamView, ownRows } from './own';
import { courseStatus, canSelfEnrol, canSelfWithdraw } from './performance-forms';
import { average } from './series';
import type { Employee, Goal, PeopleViewer, Review, Training, TrainingEnrolment } from './types';

/** Cuts text to at most `max` characters, ending in an ellipsis when it was cut. */
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** `4.2 / 5`. */
export function formatScore(score: number): string {
  return `${(Math.round(score * 10) / 10).toFixed(1)} / 5`;
}

const byNameThenText = (a: string, b: string) => a.localeCompare(b);

/* ---- My Goals ---------------------------------------------------------- */

export type GoalRow = {
  id: string;
  title: string;
  /** The title cut to 28 characters, for the chart axis. */
  short: string;
  progress: number;
  status: Goal['status'];
  due_date: string | null;
};

export type GoalsModel = {
  /** False when the account is linked to no employee record. */
  linked: boolean;
  counts: { total: number; on_track: number; at_risk: number; done: number };
  /** Mean progress as a whole percent; null with no goals. */
  average_progress: number | null;
  goals: GoalRow[];
};

export function buildGoalsModel(goals: Goal[], viewer: PeopleViewer): GoalsModel {
  const mine = ownRows(goals, viewer);
  const count = (status: Goal['status']) => mine.filter((g) => g.status === status).length;
  const mean = mine.length === 0 ? null : mine.reduce((sum, g) => sum + g.progress, 0) / mine.length;
  return {
    linked: viewer.employeeId !== null,
    counts: { total: mine.length, on_track: count('on_track'), at_risk: count('at_risk'), done: count('done') },
    average_progress: mean === null ? null : Math.round(mean),
    goals: mine
      .map((g) => ({
        id: g.id,
        title: g.title,
        short: shorten(g.title, 28),
        progress: g.progress,
        status: g.status,
        due_date: g.due_date,
      }))
      .sort((a, b) => {
        if (a.due_date !== b.due_date) {
          if (a.due_date === null) return 1;
          if (b.due_date === null) return -1;
          return a.due_date < b.due_date ? -1 : 1;
        }
        return byNameThenText(a.title, b.title);
      }),
  };
}

/* ---- Reviews: who sees which ------------------------------------------- */

/** Only a released review counts toward any figure. */
const isReleased = (review: Review) => review.status === 'released';

/**
 * The reviews this viewer's screens may use. A team viewer (an owner or admin, or anyone in the demo) has every
 * review the database let through, drafts included. Anyone else has their own RELEASED reviews and nothing else,
 * whatever they were handed.
 */
export function reviewsFor(reviews: Review[], viewer: PeopleViewer): Review[] {
  return isTeamView(viewer) ? reviews : ownRows(reviews, viewer).filter(isReleased);
}

/** The scores a review carries, in name order; entries that are not finite numbers are left out. `{}` gives none. */
export function competencyEntries(review: Pick<Review, 'competencies'>): [string, number][] {
  return Object.entries(review.competencies ?? {})
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    .sort(([a], [b]) => byNameThenText(a, b));
}

const scoreOf = (review: Review) => (Number.isFinite(review.score) ? review.score : 0);

/* ---- Scorecard --------------------------------------------------------- */

export type ScorecardRow = {
  id: string;
  employee: string;
  period: string;
  score: number;
  /** `Delivery 4.1 · Teamwork 3.5`, in name order. Empty for a review with no competency scores. */
  competencies: string;
  /** A draft: team viewers only, listed and marked but left out of every figure above. */
  draft: boolean;
};

export type ScorecardModel = {
  /** True for HR and the demo; false for a member, who gets only their own released reviews. */
  team: boolean;
  /** Released reviews: the ones every average is over. */
  scored: number;
  /** Team only: how many drafts are listed. Null for a member, who is never told a draft exists. */
  drafts: number | null;
  average: number | null;
  /** Team only: the top-scored released review. */
  highest: { employee: string; score: number } | null;
  /** Team only. */
  department_averages: { department: string; average: number; count: number }[];
  /** Mean per competency name, in name order, over released reviews. For a member this is their own. */
  competencies: { label: string; score: number }[];
  rows: ScorecardRow[];
};

function competencyAverages(reviews: Review[]): { label: string; score: number }[] {
  const values = new Map<string, number[]>();
  for (const review of reviews) {
    for (const [name, value] of competencyEntries(review)) values.set(name, [...(values.get(name) ?? []), value]);
  }
  return [...values.entries()]
    .sort(([a], [b]) => byNameThenText(a, b))
    .map(([label, list]) => ({ label, score: average(list) ?? 0 }));
}

const competencyText = (review: Review) =>
  competencyEntries(review)
    .map(([name, value]) => `${name} ${(Math.round(value * 10) / 10).toFixed(1)}`)
    .join(' · ');

export function buildScorecardModel(reviews: Review[], employees: Employee[], viewer: PeopleViewer): ScorecardModel {
  const team = isTeamView(viewer);
  const visible = reviewsFor(reviews, viewer);
  const counted = visible.filter(isReleased);
  const rows = [...visible]
    .sort((a, b) => scoreOf(b) - scoreOf(a) || byNameThenText(a.employee_name, b.employee_name))
    .map((review) => ({
      id: review.id,
      employee: review.employee_name,
      period: review.period,
      score: scoreOf(review),
      competencies: competencyText(review),
      draft: !isReleased(review),
    }));
  const top = rows.find((row) => !row.draft);
  return {
    team,
    scored: counted.length,
    drafts: team ? visible.length - counted.length : null,
    average: average(counted.map(scoreOf)),
    highest: team && top ? { employee: top.employee, score: top.score } : null,
    department_averages: team ? departmentAverages(counted.map((r) => ({ ...r, score: scoreOf(r) })), employees) : [],
    competencies: competencyAverages(counted),
    rows,
  };
}

/* ---- Review Scores ----------------------------------------------------- */

export type ReviewRow = {
  id: string;
  employee_id: string;
  employee: string;
  period: string;
  rating: Review['rating'];
  score: number;
  reviewer: string | null;
  reviewed_at: string | null;
  status: Review['status'];
  /** A draft: team viewers only; never counted. */
  draft: boolean;
  released_at: string | null;
  comment: string | null;
  /** The four scores by name, for the edit form and the detail. `{}` on an old review. */
  competencies: Record<string, number>;
};

export type ReviewsModel = {
  team: boolean;
  /** Released reviews: the ones every figure is over. */
  scored: number;
  /** Team only: how many drafts are listed. Null for a member, who is never told a draft exists. */
  drafts: number | null;
  average: number | null;
  /** Team only, over released reviews. */
  ratings: { exceeds: number; meets: number; below: number } | null;
  /** Team only, over released reviews. */
  department_averages: { department: string; average: number; count: number }[];
  /** Drafts first (team only), then highest score first. */
  rows: ReviewRow[];
};

export const RATING_LABEL: Record<Review['rating'], string> = {
  exceeds: 'Exceeds',
  meets: 'Meets',
  below: 'Below',
};

export function buildReviewsModel(reviews: Review[], employees: Employee[], viewer: PeopleViewer): ReviewsModel {
  const team = isTeamView(viewer);
  const visible = reviewsFor(reviews, viewer);
  const counted = visible.filter(isReleased);
  const rated = (rating: Review['rating']) => counted.filter((r) => r.rating === rating).length;
  return {
    team,
    scored: counted.length,
    drafts: team ? visible.length - counted.length : null,
    average: average(counted.map(scoreOf)),
    ratings: team ? { exceeds: rated('exceeds'), meets: rated('meets'), below: rated('below') } : null,
    department_averages: team ? departmentAverages(counted.map((r) => ({ ...r, score: scoreOf(r) })), employees) : [],
    rows: [...visible]
      .sort(
        (a, b) =>
          Number(isReleased(a)) - Number(isReleased(b)) ||
          scoreOf(b) - scoreOf(a) ||
          byNameThenText(a.employee_name, b.employee_name),
      )
      .map((r) => ({
        id: r.id,
        employee_id: r.employee_id,
        employee: r.employee_name,
        period: r.period,
        rating: r.rating,
        score: scoreOf(r),
        reviewer: r.reviewer_name,
        reviewed_at: r.reviewed_at,
        status: r.status,
        draft: !isReleased(r),
        released_at: r.released_at,
        comment: r.comment,
        competencies: Object.fromEntries(competencyEntries(r)),
      })),
  };
}

/* ---- Training ---------------------------------------------------------- */

export type TrainingStatus = ReturnType<typeof courseStatus>;

export const TRAINING_STATUS_LABEL: Record<TrainingStatus, string> = {
  upcoming: 'Upcoming',
  in_progress: 'In progress',
  completed: 'Completed',
};

const STATUS_ORDER: Record<TrainingStatus, number> = { in_progress: 0, upcoming: 1, completed: 2 };

/** `12 Oct 2026`, or `12 Oct – 15 Oct 2026` for a range; `—` when there is no date. */
export function dateRange(start: string | null, end: string | null): string {
  if (!start && !end) return '—';
  if (!start || !end || start === end) return formatDate((start ?? end)!);
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${sameYear ? formatDay(start) : formatDate(start)} – ${formatDate(end)}`;
}

export type TrainingRow = {
  id: string;
  title: string;
  category: string;
  /** The category as stored: null when none (the form's value; `category` reads "Uncategorised" then). */
  category_value: string | null;
  provider: string | null;
  starts_on: string | null;
  ends_on: string | null;
  dates: string;
  /** Worked out from the dates and today in Malaysia, by `courseStatus`. */
  status: TrainingStatus;
  /** Headcounts: team view only, null for a member. */
  enrolled: number | null;
  completed: number | null;
  /** The viewer's own enrolment in this course. */
  mine: 'enrolled' | 'completed' | null;
  /** The viewer may enrol themselves: linked, not in the demo, not enrolled, and the course has not ended. */
  can_enrol: boolean;
  /** The viewer may withdraw themselves: enrolled, not completed, and the course has not started. */
  can_withdraw: boolean;
  /** Team view only (null for a member): who is enrolled, by name. */
  people: { employee_id: string; name: string; completed: boolean; completed_at: string | null }[] | null;
};

export type TrainingModel = {
  team: boolean;
  by_status: Record<TrainingStatus, number>;
  /** Team view only. A member's model has no headcount at all. */
  team_stats: {
    enrolled: number;
    completed: number;
    by_category: { category: string; count: number }[];
    by_course: { label: string; enrolled: number; completed: number }[];
  } | null;
  rows: TrainingRow[];
};

/**
 * `today` is the Malaysia date (`todayInMalaysia`). `employees` names the people on a course for a team viewer;
 * leave it out and they are all "Unknown".
 */
export function buildTrainingModel(
  trainings: Training[],
  enrolments: TrainingEnrolment[],
  viewer: PeopleViewer,
  today: string,
  employees: Employee[] = [],
): TrainingModel {
  const team = isTeamView(viewer);
  const statusOf = new Map(trainings.map((t) => [t.id, courseStatus(t, today)]));
  const count = (s: TrainingStatus) => trainings.filter((t) => statusOf.get(t.id) === s).length;
  const mine = new Map(ownRows(enrolments, viewer).map((e) => [e.training_id, e.completed]));
  const names = new Map(employees.map((e) => [e.id, e.name]));
  const enrolled = new Map<string, number>();
  const completed = new Map<string, number>();
  for (const e of enrolments) {
    enrolled.set(e.training_id, (enrolled.get(e.training_id) ?? 0) + 1);
    if (e.completed) completed.set(e.training_id, (completed.get(e.training_id) ?? 0) + 1);
  }
  const mayActForSelf = viewer.employeeId !== null && !viewer.isDemo;

  const sorted = [...trainings].sort((a, b) => {
    const [sa, sb] = [statusOf.get(a.id)!, statusOf.get(b.id)!];
    if (STATUS_ORDER[sa] !== STATUS_ORDER[sb]) return STATUS_ORDER[sa] - STATUS_ORDER[sb];
    if (a.starts_on !== b.starts_on) {
      if (a.starts_on === null) return 1;
      if (b.starts_on === null) return -1;
      return a.starts_on < b.starts_on ? -1 : 1;
    }
    return byNameThenText(a.title, b.title);
  });

  const rows = sorted.map((t): TrainingRow => {
    const own = mine.get(t.id);
    const ownEnrolment = own === undefined ? null : { completed: own };
    return {
      id: t.id,
      title: t.title,
      category: t.category ?? 'Uncategorised',
      category_value: t.category,
      provider: t.provider,
      starts_on: t.starts_on,
      ends_on: t.ends_on,
      dates: dateRange(t.starts_on, t.ends_on),
      status: statusOf.get(t.id)!,
      enrolled: team ? (enrolled.get(t.id) ?? 0) : null,
      completed: team ? (completed.get(t.id) ?? 0) : null,
      mine: own === undefined ? null : own ? 'completed' : 'enrolled',
      can_enrol: mayActForSelf && ownEnrolment === null && canSelfEnrol(t, today),
      can_withdraw: mayActForSelf && canSelfWithdraw(t, ownEnrolment, today),
      people: team
        ? enrolments
            .filter((e) => e.training_id === t.id)
            .map((e) => ({
              employee_id: e.employee_id,
              name: names.get(e.employee_id) ?? 'Unknown',
              completed: e.completed,
              completed_at: e.completed_at ?? null,
            }))
            .sort((a, b) => byNameThenText(a.name, b.name))
        : null,
    };
  });

  let teamStats: TrainingModel['team_stats'] = null;
  if (team) {
    const category = new Map<string, number>();
    let total = 0;
    let done = 0;
    for (const t of trainings) {
      const n = enrolled.get(t.id) ?? 0;
      total += n;
      done += completed.get(t.id) ?? 0;
      if (n > 0) category.set(t.category ?? 'Uncategorised', (category.get(t.category ?? 'Uncategorised') ?? 0) + n);
    }
    teamStats = {
      enrolled: total,
      completed: done,
      by_category: [...category.entries()]
        .map(([name, count]) => ({ category: name, count }))
        .sort((a, b) => b.count - a.count || byNameThenText(a.category, b.category)),
      by_course: rows.map((r) => ({ label: shorten(r.title, 28), enrolled: r.enrolled ?? 0, completed: r.completed ?? 0 })),
    };
  }

  return {
    team,
    by_status: { upcoming: count('upcoming'), in_progress: count('in_progress'), completed: count('completed') },
    team_stats: teamStats,
    rows,
  };
}
