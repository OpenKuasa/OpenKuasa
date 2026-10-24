import { describe, expect, it } from 'vitest';
import { readBack, validatePlan, type FocusPlan } from '@/lib/agents/focus/plan';
import {
  PEOPLE_DEFAULTS,
  PEOPLE_FOCUS_MENU,
  PEOPLE_MAX_FOCUS_CHARS,
  PEOPLE_STARTER_EXAMPLES,
} from '@/lib/people/agent/checks';

describe('PEOPLE_FOCUS_MENU', () => {
  it('has the nine checks of spec §4.1 with their ranges and defaults', () => {
    expect(PEOPLE_FOCUS_MENU.product).toBe('people');
    const shape = Object.fromEntries(PEOPLE_FOCUS_MENU.checks.map((c) => [c.key, c.params]));
    expect(shape).toEqual({
      document_expiring: { days: { min: 1, max: 120, default: 30 } },
      goal_overdue: { days: { min: 0, max: 90, default: 0 } },
      leave_waiting: { days: { min: 1, max: 30, default: 3 } },
      leave_starts_soon: { days: { min: 1, max: 14, default: 3 } },
      claim_waiting: { days: { min: 1, max: 30, default: 7 } },
      overtime_waiting: { days: { min: 1, max: 30, default: 7 } },
      letter_draft_stale: { days: { min: 3, max: 60, default: 7 } },
      absent_streak: { days: { min: 1, max: 10, default: 3 } },
      payroll_unpaid: { day: { min: 15, max: 31, default: 25 } },
    });
  });

  it('reads every check back in one plain line', () => {
    const plan = validatePlan(PEOPLE_FOCUS_MENU, {
      checks: PEOPLE_FOCUS_MENU.checks.map((c) => ({ key: c.key, params: {} })),
    }).plan;
    expect(readBack(PEOPLE_FOCUS_MENU, plan)).toEqual([
      'Warn about documents expiring within 30 days, or already expired',
      'Flag goals past their due date and not done',
      'Flag leave requests waiting more than 3 days for a decision',
      'Warn about undecided leave starting within 3 days',
      'Flag claims waiting more than 7 days for a decision',
      'Flag overtime waiting more than 7 days for a decision',
      'Flag draft letters not issued after 7 days',
      'Flag anyone marked absent 3 working days in a row',
      "Warn if the month's payroll isn't marked paid by the 25th",
    ]);
  });

  it('says "1 day", not "1 days", and counts goal days past due', () => {
    const plan: FocusPlan = {
      checks: [
        { key: 'document_expiring', params: { days: 1 } },
        { key: 'goal_overdue', params: { days: 1 } },
        { key: 'leave_waiting', params: { days: 1 } },
        { key: 'goal_overdue', params: { days: 14 } },
        { key: 'absent_streak', params: { days: 1 } },
        { key: 'payroll_unpaid', params: { day: 31 } },
        { key: 'payroll_unpaid', params: { day: 22 } },
        { key: 'payroll_unpaid', params: { day: 23 } },
      ],
    };
    expect(readBack(PEOPLE_FOCUS_MENU, plan)).toEqual([
      'Warn about documents expiring within 1 day, or already expired',
      'Flag goals more than 1 day past their due date and not done',
      'Flag leave requests waiting more than 1 day for a decision',
      'Flag goals more than 14 days past their due date and not done',
      'Flag anyone marked absent on their latest working day',
      "Warn if the month's payroll isn't marked paid by the 31st",
      "Warn if the month's payroll isn't marked paid by the 22nd",
      "Warn if the month's payroll isn't marked paid by the 23rd",
    ]);
  });

  it('drops keys off the menu and clamps params', () => {
    const { plan } = validatePlan(PEOPLE_FOCUS_MENU, {
      checks: [
        { key: 'approve_leave', params: {} },
        { key: 'letter_draft_stale', params: { days: 1 } },
        { key: 'payroll_unpaid', params: { day: 2 } },
        { key: 'document_expiring', params: { days: 900 } },
      ],
    });
    expect(plan.checks).toEqual([
      { key: 'letter_draft_stale', params: { days: 3 } },
      { key: 'payroll_unpaid', params: { day: 15 } },
      { key: 'document_expiring', params: { days: 120 } },
    ]);
  });
});

describe('people agent constants', () => {
  it('starter examples, defaults and the focus limit', () => {
    expect(PEOPLE_STARTER_EXAMPLES).toEqual([
      'Contracts expiring in the next month',
      'Leave waiting more than 3 days',
      'Claims and overtime waiting more than a week',
      "Remind me if payroll isn't paid by the 25th",
    ]);
    expect(PEOPLE_DEFAULTS).toEqual({ max_cost_cents: 50, daily_cap_cents: 200, weekly_cap_cents: 500 });
    expect(PEOPLE_MAX_FOCUS_CHARS).toBe(500);
  });
});
