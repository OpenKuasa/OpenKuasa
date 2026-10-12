import { beforeEach, describe, expect, it, vi } from 'vitest';

const EXPENSE = '55555555-5555-4555-8555-555555555555';
const CATEGORY = '99999999-9999-4999-8999-999999999999';

type Answer = { ok: true; data: unknown } | { ok: false; error: string };

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'admin', isDemo: false } as {
    userId: string; orgId: string; role: string; isDemo: boolean;
  },
  /** Every data-layer call, in order: the function, the workspace it was given, and its input. */
  calls: [] as { fn: string; orgId: string; input: unknown }[],
  revalidated: [] as string[],
  /** What each data-layer function answers; a function with no entry succeeds. */
  answers: {} as Record<string, unknown>,
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    ctl.revalidated.push(path);
  },
}));

function recorder(fn: string, ok: unknown) {
  return async (ctx: { orgId: string }, input: unknown) => {
    ctl.calls.push({ fn, orgId: ctx.orgId, input });
    return ctl.answers[fn] ?? { ok: true, data: ok };
  };
}

vi.mock('@/lib/finance/expenses', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/expenses')>();
  return {
    ...actual,
    saveExpense: recorder('saveExpense', { id: '55555555-5555-4555-8555-555555555555', status: 'approved' }),
    approveExpense: recorder('approveExpense', { id: '55555555-5555-4555-8555-555555555555' }),
    rejectExpense: recorder('rejectExpense', { id: '55555555-5555-4555-8555-555555555555' }),
    deleteExpense: recorder('deleteExpense', { id: '55555555-5555-4555-8555-555555555555' }),
  };
});

const actions = await import('@/app/(app)/finance/actions');

const PATHS = [
  '/finance/expenses',
  '/finance/receipts-inbox',
  '/finance/payment-vouchers',
  '/finance/banking',
  '/finance/chart-of-accounts',
  '/finance/journals',
  '/finance/reports',
];
const SEEN = '2026-10-12T09:15:22.123456+00:00';
/** What the row showed when the owner pressed Approve or Reject. */
const DECIDE = {
  id: EXPENSE,
  updated_at: SEEN,
  status: 'pending',
  amount: 120,
  sst_amount: 6,
  expense_date: '2026-10-05',
  category_id: CATEGORY,
  vendor_id: null,
  vendor_name: 'Kedai Ali',
  notes: null,
};
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const NEEDS = { ok: false, error: 'Only an owner or admin can approve or reject an expense. Ask one of them to do this.' };

const expense = {
  expense_date: '2026-10-05',
  category_id: CATEGORY,
  vendor_name: 'Kedai Ali',
  amount: 120,
  sst_amount: 6,
};

/** Every expense action with an input its schema accepts, and the data-layer function it must call. */
const writes: [string, (input: unknown) => Promise<Answer>, unknown, string][] = [
  ['saveExpenseAction', actions.saveExpenseAction, expense, 'saveExpense'],
  ['approveExpenseAction', actions.approveExpenseAction, DECIDE, 'approveExpense'],
  ['rejectExpenseAction', actions.rejectExpenseAction, DECIDE, 'rejectExpense'],
  ['deleteExpenseAction', actions.deleteExpenseAction, { id: EXPENSE }, 'deleteExpense'],
];

beforeEach(() => {
  // An admin: approving and rejecting need an owner or admin. What a member may do is at the end.
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'admin', isDemo: false };
  ctl.calls = [];
  ctl.revalidated = [];
  ctl.answers = {};
});

describe('who may write', () => {
  it('refuses a viewer and the demo workspace on every action, before anything is read or written', async () => {
    for (const viewer of [
      { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false },
      { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      for (const [name, action, input] of writes) expect(await action(input), name).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('lets an owner and an admin do all four, in their own workspace', async () => {
    for (const role of ['owner', 'admin']) {
      ctl.viewer = { userId: 'u1', orgId: 'org1', role, isDemo: false };
      ctl.calls = [];
      for (const [name, action, input, fn] of writes) {
        expect((await action(input)).ok, `${role} ${name}`).toBe(true);
        expect(ctl.calls.at(-1)).toMatchObject({ fn, orgId: 'org1' });
      }
      expect(ctl.calls).toHaveLength(4);
    }
  });

  it('lets a member save and delete, and tells them who approves and rejects before anything is read or written', async () => {
    ctl.viewer = { userId: 'u2', orgId: 'org1', role: 'member', isDemo: false };
    expect((await actions.saveExpenseAction(expense)).ok).toBe(true);
    expect((await actions.deleteExpenseAction({ id: EXPENSE })).ok).toBe(true);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveExpense', 'deleteExpense']);
    ctl.calls = [];
    ctl.revalidated = [];
    expect(await actions.approveExpenseAction(DECIDE)).toEqual(NEEDS);
    expect(await actions.rejectExpenseAction(DECIDE)).toEqual(NEEDS);
    // Not even with an input the schema would refuse: the role is asked first.
    expect(await actions.approveExpenseAction({ id: 'nope' })).toEqual(NEEDS);
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('what is sent and what is refreshed', () => {
  it('answers a rejected input with the schema\'s sentence, without a write or a refresh', async () => {
    expect(await actions.saveExpenseAction({ ...expense, amount: Number.NaN })).toEqual({ ok: false, error: 'Enter an amount above 0.' });
    expect(await actions.saveExpenseAction({ ...expense, vendor_name: '' })).toEqual({
      ok: false,
      error: 'Say who was paid: choose a contact or type a name.',
    });
    expect(await actions.approveExpenseAction({ ...DECIDE, id: 'nope' })).toEqual({ ok: false, error: 'That expense no longer exists.' });
    expect(await actions.rejectExpenseAction({ id: EXPENSE })).toEqual({
      ok: false,
      error: 'This expense was changed after you opened it. Check it again, then approve or reject it.',
    });
    expect(await actions.deleteExpenseAction(null)).toEqual({ ok: false, error: 'That expense no longer exists.' });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('hands the data layer the parsed input, never a status or a workspace from the caller', async () => {
    await actions.saveExpenseAction({ ...expense, status: 'approved', org_id: 'other', approved_by: 'me', created_by: 'me' });
    expect(ctl.calls).toEqual([
      {
        fn: 'saveExpense',
        orgId: 'org1',
        input: { ...expense, vendor_id: null, notes: null },
      },
    ]);
  });

  it('refreshes the screens an expense shows on, the ledger screens included, after every action, refused or not', async () => {
    for (const [name, action, input, fn] of writes) {
      ctl.revalidated = [];
      expect((await action(input)).ok, name).toBe(true);
      expect(ctl.revalidated, name).toEqual(PATHS);
      ctl.revalidated = [];
      ctl.answers[fn] = { ok: false, error: 'That expense no longer exists.' };
      expect(await action(input), name).toEqual({ ok: false, error: 'That expense no longer exists.' });
      expect(ctl.revalidated, name).toEqual(PATHS);
    }
  });

  it('answers a save with the expense and how the database left it', async () => {
    ctl.answers.saveExpense = { ok: true, data: { id: EXPENSE, status: 'pending' } };
    expect(await actions.saveExpenseAction(expense)).toEqual({ ok: true, data: { id: EXPENSE, status: 'pending' } });
  });
});
