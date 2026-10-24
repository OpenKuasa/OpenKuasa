import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/people/waiting-counts', () => ({
  readWaitingCounts: vi.fn(async () => ({ leave: 2, time_off: 1, claims: 0, overtime: 0, swaps: 1, swap_replies: 3 })),
  waitingTotal: (c: { leave: number; time_off: number; claims: number; overtime: number; swaps: number }) =>
    c.leave + c.time_off + c.claims + c.overtime + c.swaps,
}));

import { readAllCounts, readProductCounts, withTimeout, type CountsCtx } from '@/lib/greeting/counts';

type Result = { count?: number | null; error?: unknown };

/** A chainable, thenable query stub: every filter returns itself; awaiting yields the table's result. */
function fakeClient(results: Record<string, Result | 'throw'>): SupabaseClient {
  const from = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'is', 'gte', 'lt', 'lte']) q[m] = () => q;
    q.then = (resolve: (v: Result) => void, reject: (e: unknown) => void) => {
      const r = results[table];
      if (r === 'throw') return reject(new Error('boom'));
      return resolve(r ?? { count: 0, error: null });
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const ctx = (results: Record<string, Result | 'throw'>): CountsCtx => ({
  client: fakeClient(results),
  orgId: 'org',
  userId: 'user',
  now: new Date('2026-10-24T02:00:00Z'),
});

describe('readProductCounts', () => {
  it('maps people waiting counts', async () => {
    expect(await readProductCounts(ctx({}), 'people')).toEqual({ hrApprovals: 4, swapReplies: 3 });
  });

  it('sums the two pending approvals and reads both overdue views', async () => {
    const out = await readProductCounts(
      ctx({
        finance_transactions: { count: 2, error: null },
        finance_purchase_orders: { count: 3, error: null },
        finance_invoice_totals: { count: 4, error: null },
        supplier_bill_totals: { count: 1, error: null },
      }),
      'finance',
    );
    expect(out).toEqual({ financeApprovals: 5, overdueInvoices: 4, overdueBills: 1 });
  });

  it('omits a field whose query errors or throws', async () => {
    const out = await readProductCounts(
      ctx({
        finance_transactions: { count: null, error: { code: 'x' } },
        finance_invoice_totals: 'throw',
        supplier_bill_totals: { count: 7, error: null },
      }),
      'finance',
    );
    expect(out).toEqual({ overdueBills: 7 });
  });

  it('reads hire, crm and reach', async () => {
    const c = ctx({
      hire_interviews: { count: 2, error: null },
      hire_applications: { count: 5, error: null },
      crm_activities: { count: 3, error: null },
      appointments: { count: 1, error: null },
      leads: { count: 6, error: null },
    });
    expect(await readProductCounts(c, 'hire')).toEqual({ interviewsToday: 2, applicationsWaiting: 5 });
    expect(await readProductCounts(c, 'crm')).toEqual({ followUpsDue: 3, appointmentsToday: 1 });
    expect(await readProductCounts(c, 'reach')).toEqual({ newLeads: 6, appointmentsToday: 1 });
  });
});

describe('readAllCounts', () => {
  it('merges every product and survives a rejecting one', async () => {
    const out = await readAllCounts(
      ctx({
        finance_transactions: 'throw',
        hire_interviews: { count: 2, error: null },
        leads: { count: 6, error: null },
      }),
    );
    expect(out.hrApprovals).toBe(4);
    expect(out.interviewsToday).toBe(2);
    expect(out.newLeads).toBe(6);
    expect(out.financeApprovals).toBeUndefined();
  });
});

describe('withTimeout', () => {
  it('resolves to the fallback for a hung promise', async () => {
    expect(await withTimeout(new Promise<object>(() => {}), 10, {})).toEqual({});
  });
  it('passes through a fast value and falls back on rejection', async () => {
    expect(await withTimeout(Promise.resolve(1), 50, 0)).toBe(1);
    expect(await withTimeout(Promise.reject(new Error('x')), 50, 9)).toBe(9);
  });
});
