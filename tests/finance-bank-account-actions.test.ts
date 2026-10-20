import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '66666666-6666-4666-8666-666666666666';

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

function recorder(fn: string) {
  return async (ctx: { orgId: string }, input: unknown) => {
    ctl.calls.push({ fn, orgId: ctx.orgId, input });
    return ctl.answers[fn] ?? { ok: true, data: { id: '66666666-6666-4666-8666-666666666666', name: 'Savings', active: true } };
  };
}

vi.mock('@/lib/finance/bank-accounts', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/bank-accounts')>();
  return {
    ...actual,
    createBankAccount: recorder('createBankAccount'),
    updateBankAccount: recorder('updateBankAccount'),
    setBankAccountActive: recorder('setBankAccountActive'),
  };
});

const actions = await import('@/app/(app)/finance/actions');

// Banking, every screen whose forms offer an account or whose rows name one, and the three ledger screens.
const PATHS = [
  '/finance/banking',
  '/finance/supplier-bills',
  '/finance/payments-out',
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/credit-notes',
  '/finance/refunds',
  '/finance/cash-receipts',
  '/finance/payment-vouchers',
  '/finance/chart-of-accounts',
  '/finance/journals',
  '/finance/reports',
];
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const NEEDS = { ok: false, error: 'Only an owner or admin can set or change an opening balance. If you are one, sign in again with your second step.' };
const SAVED = { ok: true, data: { id: ACCOUNT, name: 'Savings', active: true } };

const as = (role: string, isDemo = false) => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role, isDemo };
};

beforeEach(() => {
  ctl.calls.length = 0;
  ctl.revalidated.length = 0;
  ctl.answers = {};
  as('admin');
});

describe('who may use the account actions', () => {
  const each = [
    ['createBankAccountAction', { name: 'Savings', kind: 'bank' }],
    ['updateBankAccountAction', { id: ACCOUNT, name: 'Savings' }],
    ['setBankAccountActiveAction', { id: ACCOUNT, active: false }],
  ] as const;

  it.each(each)('%s refuses a viewer and the demo workspace before anything is read', async (name, input) => {
    as('viewer');
    expect(await actions[name](input)).toEqual(FORBIDDEN);
    as('owner', true);
    expect(await actions[name](input)).toEqual(FORBIDDEN);
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it.each(each)('%s runs for a member, an admin and an owner, in the workspace of the person signed in', async (name, input) => {
    for (const role of ['member', 'admin', 'owner']) {
      as(role);
      expect(await actions[name]({ ...input, org_id: 'someone-else' })).toEqual(SAVED);
    }
    expect(ctl.calls).toHaveLength(3);
    expect(ctl.calls.every((c) => c.orgId === 'org1')).toBe(true);
    expect(JSON.stringify(ctl.calls)).not.toContain('someone-else');
  });
});

describe('an opening balance', () => {
  it('on a new account is refused from a member before anything is written, and taken from an admin and an owner', async () => {
    const input = { name: 'Savings', kind: 'bank', opening_balance: 1500, opening_date: '2026-09-30' };
    as('member');
    expect(await actions.createBankAccountAction(input)).toEqual(NEEDS);
    expect(await actions.createBankAccountAction({ ...input, opening_balance: -1 })).toEqual(NEEDS);
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
    for (const role of ['admin', 'owner']) {
      as(role);
      expect(await actions.createBankAccountAction(input)).toEqual(SAVED);
    }
    expect(ctl.calls.map((c) => c.input)).toEqual([
      { name: 'Savings', kind: 'bank', bank_name: null, account_no: null, opening_balance: 1500, opening_date: '2026-09-30', currency: 'MYR' },
      { name: 'Savings', kind: 'bank', bank_name: null, account_no: null, opening_balance: 1500, opening_date: '2026-09-30', currency: 'MYR' },
    ]);
  });

  it('of nothing is anyone’s who may write', async () => {
    as('member');
    expect(await actions.createBankAccountAction({ name: 'Till', kind: 'cash', opening_balance: 0 })).toEqual(SAVED);
  });

  it('on a change is refused from a member whenever the balance or its date is sent at all', async () => {
    as('member');
    expect(await actions.updateBankAccountAction({ id: ACCOUNT, name: 'Savings', opening_balance: 0 })).toEqual(NEEDS);
    expect(await actions.updateBankAccountAction({ id: ACCOUNT, name: 'Savings', opening_date: '2026-01-01' })).toEqual(NEEDS);
    expect(ctl.calls).toEqual([]);
    as('owner');
    expect(await actions.updateBankAccountAction({ id: ACCOUNT, name: 'Savings', opening_balance: 20, opening_date: '2026-01-01' })).toEqual(SAVED);
    expect(ctl.calls[0].input).toMatchObject({ opening_balance: 20, opening_date: '2026-01-01' });
  });
});

describe('what the account actions do', () => {
  it('answer a rejected input with the schema’s sentence, without writing or refreshing', async () => {
    expect(await actions.createBankAccountAction({ name: ' ', kind: 'bank' })).toEqual({ ok: false, error: 'Enter a name for the bank or cash account.' });
    expect(await actions.updateBankAccountAction({ id: 'nope', name: 'A' })).toEqual({ ok: false, error: 'That bank or cash account no longer exists.' });
    expect(await actions.setBankAccountActiveAction({ id: ACCOUNT })).toEqual({ ok: false, error: 'That bank or cash account no longer exists.' });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('refresh Banking and every screen with an account picker, after a refusal too', async () => {
    await actions.createBankAccountAction({ name: 'Savings', kind: 'bank' });
    expect(ctl.revalidated).toEqual(PATHS);
    ctl.revalidated.length = 0;
    await actions.updateBankAccountAction({ id: ACCOUNT, name: 'Savings' });
    expect(ctl.revalidated).toEqual(PATHS);
    ctl.revalidated.length = 0;
    const refusal = { ok: false, error: 'This account has payments that are still to be paid or waiting for approval. Pay, reject or delete them, then archive it.' };
    ctl.answers.setBankAccountActive = refusal;
    expect(await actions.setBankAccountActiveAction({ id: ACCOUNT, active: false })).toEqual(refusal);
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('pass on only what the schema keeps', async () => {
    await actions.updateBankAccountAction({ id: ACCOUNT, name: ' Savings ', kind: 'cash', active: false, bank_name: '' });
    expect(ctl.calls[0]).toEqual({ fn: 'updateBankAccount', orgId: 'org1', input: { id: ACCOUNT, name: 'Savings', bank_name: null, account_no: null } });
    await actions.setBankAccountActiveAction({ id: ACCOUNT, active: false, name: 'x' });
    expect(ctl.calls[1]).toEqual({ fn: 'setBankAccountActive', orgId: 'org1', input: { id: ACCOUNT, active: false } });
  });
});
