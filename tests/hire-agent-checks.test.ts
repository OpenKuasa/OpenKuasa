import { describe, expect, it } from 'vitest';
import { readBack, validatePlan } from '@/lib/agents/focus/plan';
import { HIRE_DEFAULTS, HIRE_FOCUS_MENU, HIRE_MAX_FOCUS_CHARS, HIRE_STARTER_EXAMPLES } from '@/lib/hire/agent/checks';

describe('HIRE_FOCUS_MENU', () => {
  it('has the ten checks of spec §4.1 with their ranges and defaults', () => {
    expect(HIRE_FOCUS_MENU.product).toBe('hire');
    const shape = Object.fromEntries(HIRE_FOCUS_MENU.checks.map((c) => [c.key, c.params]));
    expect(shape).toEqual({
      application_unscreened: { days: { min: 1, max: 60, default: 5 } },
      screening_no_interview: { days: { min: 3, max: 90, default: 14 } },
      application_quiet: { days: { min: 3, max: 90, default: 14 } },
      interview_not_updated: { days: { min: 1, max: 30, default: 1 } },
      feedback_missing: { days: { min: 1, max: 30, default: 2 } },
      offer_waiting: { days: { min: 1, max: 60, default: 7 } },
      job_open_long: { days: { min: 7, max: 365, default: 45 } },
      job_few_applicants: { days: { min: 3, max: 90, default: 14 }, min: { min: 1, max: 50, default: 1 } },
      job_closing_soon: { days: { min: 1, max: 30, default: 7 } },
      pool_idle: { days: { min: 30, max: 365, default: 90 } },
    });
  });

  it('reads every check back in plain words', () => {
    const plan = validatePlan(HIRE_FOCUS_MENU, {
      checks: HIRE_FOCUS_MENU.checks.map((c) => ({ key: c.key, params: {} })),
    }).plan;
    expect(readBack(HIRE_FOCUS_MENU, plan)).toEqual([
      'Flag applications still at Applied more than 5 days after applying',
      'Flag applications at Screening with no interview booked 14 days after applying',
      'Flag applications at Interview or Offer with no activity for 14 days',
      'Flag interviews still marked Scheduled 1 day after their time',
      'Flag completed interviews with no feedback 2 days later',
      'Flag offers with no answer after 7 days',
      'Flag open jobs not filled after 45 days',
      'Flag open jobs with fewer than 1 new application in 14 days',
      'Warn about open jobs closing within 7 days',
      'Flag talent pool candidates on file 90+ days with no current application',
    ]);
    expect(
      readBack(HIRE_FOCUS_MENU, { checks: [{ key: 'job_few_applicants', params: { days: 30, min: 5 } }] }),
    ).toEqual(['Flag open jobs with fewer than 5 new applications in 30 days']);
  });

  it('drops keys off the menu (actions included) and clamps params', () => {
    const { plan } = validatePlan(HIRE_FOCUS_MENU, {
      checks: [
        { key: 'reject_application', params: {} },
        { key: 'email_candidate', params: {} },
        { key: 'pool_idle', params: { days: 5 } },
        { key: 'job_few_applicants', params: { days: 500, min: 0 } },
      ],
    });
    expect(plan.checks).toEqual([
      { key: 'pool_idle', params: { days: 30 } },
      { key: 'job_few_applicants', params: { days: 90, min: 1 } },
    ]);
  });

  it('no summary or read-back names a field the fairness rule keeps out', () => {
    const words = HIRE_FOCUS_MENU.checks.flatMap((c) => [c.summary, c.describe(validatePlan(HIRE_FOCUS_MENU, { checks: [{ key: c.key, params: {} }] }).plan.checks[0].params)]);
    for (const w of words) expect(w).not.toMatch(/\b(email|phone|location|skills?|salary|CV|cover letter|rating|reason|age|gender)\b/i);
  });
});

describe('hire agent constants', () => {
  it('starter examples, defaults and the focus limit', () => {
    expect(HIRE_STARTER_EXAMPLES).toEqual([
      'Anyone waiting more than 5 days to be screened',
      'Interviews with no feedback',
      'Offers with no answer after a week',
      'Jobs open more than 45 days',
    ]);
    expect(HIRE_DEFAULTS).toEqual({ max_cost_cents: 50, daily_cap_cents: 200, weekly_cap_cents: 500 });
    expect(HIRE_MAX_FOCUS_CHARS).toBe(500);
  });
});
