import { describe, expect, it } from 'vitest';
import { pickProductNudge, pickTopNudge } from '@/lib/greeting/nudge';

describe('pickProductNudge', () => {
  it('people: approvals with plural and singular', () => {
    const n = pickProductNudge('people', { hrApprovals: 3 }, 'member');
    expect(n?.text).toContain('3');
    expect(n?.text).toContain('waiting');
    expect(pickProductNudge('people', { hrApprovals: 1 }, 'member')?.text).toBe(
      '1 approval is waiting for you.',
    );
    expect(pickProductNudge('people', { hrApprovals: 2 }, 'member')?.text).toBe(
      '2 approvals are waiting for you.',
    );
  });

  it('people: swap replies when no approvals', () => {
    expect(pickProductNudge('people', { swapReplies: 2 }, 'member')).not.toBeNull();
  });

  it('finance: approvals gated by sign-off', () => {
    expect(pickProductNudge('finance', { financeApprovals: 2 }, 'member')).toBeNull();
    expect(pickProductNudge('finance', { financeApprovals: 2 }, 'admin')).not.toBeNull();
  });

  it('finance: falls through the gated approval to overdue', () => {
    const n = pickProductNudge('finance', { financeApprovals: 2, overdueInvoices: 5 }, 'member');
    expect(n?.text).toContain('overdue');
    expect(n?.text).toBe('5 invoices are overdue.');
    expect(pickProductNudge('finance', { overdueBills: 1 }, 'member')?.text).toContain('overdue');
  });

  it('hire, crm, reach wording and order', () => {
    expect(pickProductNudge('hire', { interviewsToday: 1, applicationsWaiting: 4 }, 'member')?.text).toBe(
      '1 interview today.',
    );
    expect(pickProductNudge('hire', { applicationsWaiting: 4 }, 'member')).not.toBeNull();
    expect(pickProductNudge('crm', { followUpsDue: 2, appointmentsToday: 1 }, 'member')?.text).toBe(
      '2 follow-ups due.',
    );
    expect(pickProductNudge('crm', { appointmentsToday: 1 }, 'member')).not.toBeNull();
    expect(pickProductNudge('reach', { newLeads: 4, appointmentsToday: 1 }, 'member')?.text).toBe(
      '4 new leads since this week.',
    );
    expect(pickProductNudge('reach', { appointmentsToday: 1 }, 'member')).not.toBeNull();
  });

  it('returns null when nothing qualifies', () => {
    expect(pickProductNudge('crm', {}, 'member')).toBeNull();
    expect(pickProductNudge('crm', { followUpsDue: 0 }, 'member')).toBeNull();
  });

  it('every nudge has a non-empty question', () => {
    const n = pickProductNudge('finance', { overdueInvoices: 1 }, 'owner');
    expect(n?.question.length).toBeGreaterThan(0);
  });
});

describe('pickTopNudge', () => {
  it('approvals outrank leads', () => {
    const n = pickTopNudge({ newLeads: 4, hrApprovals: 1 }, 'owner');
    expect(n?.text).toContain('waiting');
    expect(n?.question.length).toBeGreaterThan(0);
  });

  it('skips gated finance approvals for members', () => {
    expect(pickTopNudge({ financeApprovals: 2, newLeads: 1 }, 'member')?.text).toContain('lead');
    expect(pickTopNudge({ financeApprovals: 2 }, 'member')).toBeNull();
  });

  it('follows the global order', () => {
    expect(pickTopNudge({ overdueInvoices: 1, interviewsToday: 1 }, 'member')?.text).toContain('interview');
    expect(pickTopNudge({}, 'owner')).toBeNull();
  });
});
