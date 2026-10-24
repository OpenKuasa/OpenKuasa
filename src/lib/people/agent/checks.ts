import type { FocusMenu } from '@/lib/agents/focus/plan';

/** "1 day", "14 days". */
const daysText = (n: number): string => (n === 1 ? '1 day' : `${n} days`);

/** "1st", "22nd", "25th". */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** Lekiu's own spend defaults: RM 0.50 a run, RM 2 a day, RM 5 a week. */
export const PEOPLE_DEFAULTS = { max_cost_cents: 50, daily_cap_cents: 200, weekly_cap_cents: 500 } as const;

/** The longest focus the workspace may write. */
export const PEOPLE_MAX_FOCUS_CHARS = 500;

/**
 * The fixed menu of checks Lekiu's agent can run (spec §4.1). The focus text can only pick from
 * this. Every check covers active employees only.
 */
export const PEOPLE_FOCUS_MENU: FocusMenu = {
  product: 'people',
  checks: [
    {
      key: 'document_expiring',
      params: { days: { min: 1, max: 120, default: 30 } },
      summary: 'Employee documents (contracts, permits, certificates) expiring within N days, or already expired',
      describe: (p) => `Warn about documents expiring within ${daysText(p.days)}, or already expired`,
    },
    {
      key: 'goal_overdue',
      params: { days: { min: 0, max: 90, default: 0 } },
      summary: 'Goals not marked done that are more than N days past their due date (0 means any day late)',
      describe: (p) =>
        p.days === 0
          ? 'Flag goals past their due date and not done'
          : `Flag goals more than ${daysText(p.days)} past their due date and not done`,
    },
    {
      key: 'leave_waiting',
      params: { days: { min: 1, max: 30, default: 3 } },
      summary: 'Leave requests waiting for a decision for more than N days',
      describe: (p) => `Flag leave requests waiting more than ${daysText(p.days)} for a decision`,
    },
    {
      key: 'leave_starts_soon',
      params: { days: { min: 1, max: 14, default: 3 } },
      summary: 'Leave requests still waiting for a decision that start within N days, or have already started',
      describe: (p) => `Warn about undecided leave starting within ${daysText(p.days)}`,
    },
    {
      key: 'claim_waiting',
      params: { days: { min: 1, max: 30, default: 7 } },
      summary: 'Expense claims waiting for a decision for more than N days',
      describe: (p) => `Flag claims waiting more than ${daysText(p.days)} for a decision`,
    },
    {
      key: 'overtime_waiting',
      params: { days: { min: 1, max: 30, default: 7 } },
      summary: 'Overtime records waiting for a decision for more than N days',
      describe: (p) => `Flag overtime waiting more than ${daysText(p.days)} for a decision`,
    },
    {
      key: 'letter_draft_stale',
      params: { days: { min: 3, max: 60, default: 7 } },
      summary: 'Draft HR letters created more than N days ago and not yet issued',
      describe: (p) => `Flag draft letters not issued after ${daysText(p.days)}`,
    },
    {
      key: 'absent_streak',
      params: { days: { min: 1, max: 10, default: 3 } },
      summary: 'Employees marked absent N or more working days in a row, up to their latest attendance day',
      describe: (p) =>
        p.days === 1
          ? 'Flag anyone marked absent on their latest working day'
          : `Flag anyone marked absent ${p.days} working days in a row`,
    },
    {
      key: 'payroll_unpaid',
      params: { day: { min: 15, max: 31, default: 25 } },
      summary: "From day N of the month, the month's payroll is missing or not marked paid",
      describe: (p) => `Warn if the month's payroll isn't marked paid by the ${ordinal(p.day)}`,
    },
  ],
};

export const PEOPLE_STARTER_EXAMPLES: readonly string[] = [
  'Contracts expiring in the next month',
  'Leave waiting more than 3 days',
  'Claims and overtime waiting more than a week',
  "Remind me if payroll isn't paid by the 25th",
];
