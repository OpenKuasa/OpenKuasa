import { describe, expect, it } from 'vitest';
import { CRM_FOCUS_MENU, CRM_STARTER_EXAMPLES } from '@/lib/crm/agent/checks';

describe('CRM_FOCUS_MENU', () => {
  it('lists the five checks', () => {
    expect(CRM_FOCUS_MENU.product).toBe('crm');
    expect(CRM_FOCUS_MENU.checks.map((c) => c.key)).toEqual([
      'deal_quiet',
      'deal_closing_soon',
      'follow_up_overdue',
      'contact_idle',
      'contact_new_no_follow_up',
    ]);
  });

  it('has defaults inside ranges and a summary each', () => {
    for (const c of CRM_FOCUS_MENU.checks) {
      expect(c.summary.length).toBeGreaterThan(0);
      for (const p of Object.values(c.params)) {
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
      }
    }
  });

  it('has starter examples', () => {
    expect(CRM_STARTER_EXAMPLES).toEqual([
      'Deals quiet for 7+ days',
      'Contacts with no activity in 14 days',
      'Overdue follow-ups',
      'Big deals closing this week',
    ]);
  });
});
