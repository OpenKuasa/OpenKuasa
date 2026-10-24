import type { FocusMenu } from '@/lib/agents/focus/plan';

/** "1 day", "14 days". */
const daysText = (n: number): string => (n === 1 ? '1 day' : `${n} days`);

/** Lekir's own spend defaults: RM 0.50 a run, RM 2 a day, RM 5 a week. */
export const HIRE_DEFAULTS = { max_cost_cents: 50, daily_cap_cents: 200, weekly_cap_cents: 500 } as const;

/** The longest focus the workspace may write. */
export const HIRE_MAX_FOCUS_CHARS = 500;

/**
 * The fixed menu of checks Lekir's agent can run (spec §4.1). The focus text can only pick from
 * this. Every check reads only stages, statuses, dates and counts: never contact details, CVs,
 * skills, ratings or feedback text.
 */
export const HIRE_FOCUS_MENU: FocusMenu = {
  product: 'hire',
  checks: [
    {
      key: 'application_unscreened',
      params: { days: { min: 1, max: 60, default: 5 } },
      summary: 'Active applications still at Applied more than N days after the person applied',
      describe: (p) => `Flag applications still at Applied more than ${daysText(p.days)} after applying`,
    },
    {
      key: 'screening_no_interview',
      params: { days: { min: 3, max: 90, default: 14 } },
      summary: 'Active applications at Screening, applied more than N days ago, with no interview ever booked',
      describe: (p) => `Flag applications at Screening with no interview booked ${daysText(p.days)} after applying`,
    },
    {
      key: 'application_quiet',
      params: { days: { min: 3, max: 90, default: 14 } },
      summary: 'Active applications at Interview or Offer with no activity (interviews, offer) for N days',
      describe: (p) => `Flag applications at Interview or Offer with no activity for ${daysText(p.days)}`,
    },
    {
      key: 'interview_not_updated',
      params: { days: { min: 1, max: 30, default: 1 } },
      summary: 'Interviews still marked Scheduled more than N days after their time',
      describe: (p) => `Flag interviews still marked Scheduled ${daysText(p.days)} after their time`,
    },
    {
      key: 'feedback_missing',
      params: { days: { min: 1, max: 30, default: 2 } },
      summary: 'Completed interviews with no feedback recorded, held more than N days ago',
      describe: (p) => `Flag completed interviews with no feedback ${daysText(p.days)} later`,
    },
    {
      key: 'offer_waiting',
      params: { days: { min: 1, max: 60, default: 7 } },
      summary: 'Active applications at Offer whose offer was made more than N days ago with no answer recorded',
      describe: (p) => `Flag offers with no answer after ${daysText(p.days)}`,
    },
    {
      key: 'job_open_long',
      params: { days: { min: 7, max: 365, default: 45 } },
      summary: 'Open jobs opened more than N days ago with fewer people hired than the headcount',
      describe: (p) => `Flag open jobs not filled after ${daysText(p.days)}`,
    },
    {
      key: 'job_few_applicants',
      params: {
        days: { min: 3, max: 90, default: 14 },
        min: { min: 1, max: 50, default: 1 },
      },
      summary: 'Open jobs, open at least N days, with fewer than a minimum number of new applications in the last N days',
      describe: (p) =>
        `Flag open jobs with fewer than ${p.min} new ${p.min === 1 ? 'application' : 'applications'} in ${daysText(p.days)}`,
    },
    {
      key: 'job_closing_soon',
      params: { days: { min: 1, max: 30, default: 7 } },
      summary: 'Open jobs whose closing date is within N days',
      describe: (p) => `Warn about open jobs closing within ${daysText(p.days)}`,
    },
    {
      key: 'pool_idle',
      params: { days: { min: 30, max: 365, default: 90 } },
      summary: 'Talent pool candidates on file more than N days who are not in any current application',
      describe: (p) => `Flag talent pool candidates on file ${p.days}+ days with no current application`,
    },
  ],
};

export const HIRE_STARTER_EXAMPLES: readonly string[] = [
  'Anyone waiting more than 5 days to be screened',
  'Interviews with no feedback',
  'Offers with no answer after a week',
  'Jobs open more than 45 days',
];
