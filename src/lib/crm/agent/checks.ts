import type { FocusMenu } from '@/lib/agents/focus/plan';
import { formatRM } from '@/lib/crm/deal-stats';

/** The fixed menu of checks Kasturi's agent can run. The focus text can only pick from this. */
export const CRM_FOCUS_MENU: FocusMenu = {
  product: 'crm',
  checks: [
    {
      key: 'deal_quiet',
      params: { days: { min: 3, max: 60, default: 7 } },
      summary: 'Open deals with no activity for N days',
      describe: (p) => `Look for open deals with no activity in ${p.days}+ days`,
    },
    {
      key: 'deal_closing_soon',
      params: {
        days: { min: 1, max: 30, default: 7 },
        min_value: { min: 0, max: 10000000, default: 0 },
      },
      summary: 'Open deals whose expected close date is within N days, optionally only above a value in RM',
      describe: (p) =>
        `Flag open deals closing within ${p.days} days` +
        (p.min_value > 0 ? ` worth ${formatRM(p.min_value)} or more` : ''),
    },
    {
      key: 'follow_up_overdue',
      params: {},
      summary: 'Follow-ups that are past their due date',
      describe: () => 'Flag follow-ups that are past their due date',
    },
    {
      key: 'contact_idle',
      params: { days: { min: 7, max: 180, default: 14 } },
      summary: 'Contacts with no activity for N days',
      describe: (p) => `Look for contacts with no activity in ${p.days}+ days`,
    },
    {
      key: 'contact_new_no_follow_up',
      params: { days: { min: 1, max: 30, default: 3 } },
      summary: 'Contacts added in the last N days that have no follow-up yet',
      describe: (p) => `Look for contacts added in the last ${p.days} days with no follow-up yet`,
    },
  ],
};

export const CRM_STARTER_EXAMPLES: readonly string[] = [
  'Keep an eye on deals that have gone quiet for a week.',
  'Tell me about deals worth RM 10,000 or more that are closing soon.',
  'Make sure no follow-up is overdue and new contacts get followed up.',
];
