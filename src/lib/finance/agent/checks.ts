import type { FocusMenu } from '@/lib/agents/focus/plan';
import { rm } from '@/lib/finance/format';

/** "1 day", "14 days". */
const daysText = (n: number): string => (n === 1 ? '1 day' : `${n} days`);

/** Bendahara's own spend defaults: RM 0.50 a run, RM 2 a day, RM 5 a week. */
export const FINANCE_DEFAULTS = { max_cost_cents: 50, daily_cap_cents: 200, weekly_cap_cents: 500 } as const;

/** The longest focus the workspace may write. */
export const FINANCE_MAX_FOCUS_CHARS = 500;

/** The fixed menu of checks Bendahara's agent can run. The focus text can only pick from this. */
export const FINANCE_FOCUS_MENU: FocusMenu = {
  product: 'finance',
  checks: [
    {
      key: 'invoice_overdue',
      params: {
        days: { min: 1, max: 180, default: 14 },
        min_amount: { min: 0, max: 10000000, default: 0 },
      },
      summary: 'Posted invoices more than N days past their due date with money still owed, optionally only above an amount in RM',
      describe: (p) =>
        `Flag invoices more than ${daysText(p.days)} overdue` + (p.min_amount > 0 ? ` with ${rm(p.min_amount)} or more unpaid` : ''),
    },
    {
      key: 'bill_due_soon',
      params: { days: { min: 1, max: 60, default: 7 } },
      summary: 'Supplier bills due within N days (or already overdue) with money still to pay',
      describe: (p) => `Warn about supplier bills due within ${daysText(p.days)}`,
    },
    {
      key: 'expense_waiting',
      params: { days: { min: 1, max: 60, default: 7 } },
      summary: 'Expense claims waiting for approval for more than N days',
      describe: (p) => `Flag expense claims waiting more than ${daysText(p.days)} for approval`,
    },
    {
      key: 'quotation_expiring',
      params: { days: { min: 1, max: 30, default: 7 } },
      summary: 'Sent quotations with no answer that expire within N days',
      describe: (p) => `Warn about sent quotations expiring within ${daysText(p.days)}`,
    },
    {
      key: 'draft_stale',
      params: { days: { min: 3, max: 90, default: 14 } },
      summary: 'Draft invoices and supplier bills not touched for N days',
      describe: (p) => `Flag draft invoices and bills untouched for ${p.days}+ days`,
    },
    {
      key: 'bank_unmatched',
      params: { days: { min: 3, max: 90, default: 14 } },
      summary: 'Imported bank statement lines older than N days with nothing matched',
      describe: (p) => `Flag bank statement lines older than ${daysText(p.days)} with nothing matched`,
    },
    {
      key: 'sst_period_closing',
      params: { days: { min: 1, max: 30, default: 10 } },
      summary: "The current SST period ends within N days and its return isn't marked filed",
      describe: (p) => `Warn ${daysText(p.days)} before the SST period ends if its return isn't marked filed`,
    },
  ],
};

export const FINANCE_STARTER_EXAMPLES: readonly string[] = [
  'Invoices overdue more than 14 days',
  'Bills due this week',
  'Expense claims waiting more than a week',
  'Warn me before the SST period closes',
];
