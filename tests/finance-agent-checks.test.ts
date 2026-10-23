import { describe, expect, it } from 'vitest';
import { readBack, validatePlan } from '@/lib/agents/focus/plan';
import {
  FINANCE_DEFAULTS,
  FINANCE_FOCUS_MENU,
  FINANCE_MAX_FOCUS_CHARS,
  FINANCE_STARTER_EXAMPLES,
} from '@/lib/finance/agent/checks';

describe('FINANCE_FOCUS_MENU', () => {
  it('has the seven checks of spec §4.1 with their ranges and defaults', () => {
    expect(FINANCE_FOCUS_MENU.product).toBe('finance');
    const shape = Object.fromEntries(FINANCE_FOCUS_MENU.checks.map((c) => [c.key, c.params]));
    expect(shape).toEqual({
      invoice_overdue: { days: { min: 1, max: 180, default: 14 }, min_amount: { min: 0, max: 10000000, default: 0 } },
      bill_due_soon: { days: { min: 1, max: 60, default: 7 } },
      expense_waiting: { days: { min: 1, max: 60, default: 7 } },
      quotation_expiring: { days: { min: 1, max: 30, default: 7 } },
      draft_stale: { days: { min: 3, max: 90, default: 14 } },
      bank_unmatched: { days: { min: 3, max: 90, default: 14 } },
      sst_period_closing: { days: { min: 1, max: 30, default: 10 } },
    });
  });

  it('reads every check back in plain words', () => {
    const plan = validatePlan(FINANCE_FOCUS_MENU, {
      checks: FINANCE_FOCUS_MENU.checks.map((c) => ({ key: c.key, params: {} })),
    }).plan;
    expect(readBack(FINANCE_FOCUS_MENU, plan)).toEqual([
      'Flag invoices more than 14 days overdue',
      'Warn about supplier bills due within 7 days',
      'Flag expense claims waiting more than 7 days for approval',
      'Warn about sent quotations expiring within 7 days',
      'Flag draft invoices and bills untouched for 14+ days',
      'Flag bank statement lines older than 14 days with nothing matched',
      "Warn 10 days before the SST period ends if its return isn't marked filed",
    ]);
    expect(
      readBack(FINANCE_FOCUS_MENU, { checks: [{ key: 'invoice_overdue', params: { days: 30, min_amount: 5000 } }] }),
    ).toEqual(['Flag invoices more than 30 days overdue with RM 5,000.00 or more unpaid']);
  });

  it('says "1 day", not "1 days"', () => {
    const plan = {
      checks: ['invoice_overdue', 'bill_due_soon', 'expense_waiting', 'quotation_expiring', 'sst_period_closing'].map(
        (key) => ({ key, params: { days: 1, min_amount: 0 } }),
      ),
    };
    expect(readBack(FINANCE_FOCUS_MENU, plan)).toEqual([
      'Flag invoices more than 1 day overdue',
      'Warn about supplier bills due within 1 day',
      'Flag expense claims waiting more than 1 day for approval',
      'Warn about sent quotations expiring within 1 day',
      "Warn 1 day before the SST period ends if its return isn't marked filed",
    ]);
  });

  it('drops keys off the menu and clamps params', () => {
    const { plan } = validatePlan(FINANCE_FOCUS_MENU, {
      checks: [
        { key: 'pay_bill', params: {} },
        { key: 'draft_stale', params: { days: 1 } },
        { key: 'bank_unmatched', params: { days: 500 } },
      ],
    });
    expect(plan.checks).toEqual([
      { key: 'draft_stale', params: { days: 3 } },
      { key: 'bank_unmatched', params: { days: 90 } },
    ]);
  });
});

describe('finance agent constants', () => {
  it('starter examples, defaults and the focus limit', () => {
    expect(FINANCE_STARTER_EXAMPLES).toEqual([
      'Invoices overdue more than 14 days',
      'Bills due this week',
      'Expense claims waiting more than a week',
      'Warn me before the SST period closes',
    ]);
    expect(FINANCE_DEFAULTS).toEqual({ max_cost_cents: 50, daily_cap_cents: 200, weekly_cap_cents: 500 });
    expect(FINANCE_MAX_FOCUS_CHARS).toBe(500);
  });
});
