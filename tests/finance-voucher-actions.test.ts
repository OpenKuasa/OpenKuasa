import { beforeEach, describe, expect, it, vi } from 'vitest';

const VOUCHER = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
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

vi.mock('@/lib/finance/vouchers', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/vouchers')>();
  return {
    ...actual,
    recordVoucher: recorder('recordVoucher', { id: '55555555-5555-4555-8555-555555555555', status: 'scheduled' }),
    approveVoucher: recorder('approveVoucher', { id: '55555555-5555-4555-8555-555555555555' }),
    rejectVoucher: recorder('rejectVoucher', { id: '55555555-5555-4555-8555-555555555555' }),
    deleteVoucher: recorder('deleteVoucher', { id: '55555555-5555-4555-8555-555555555555' }),
  };
});

const actions = await import('@/app/(app)/finance/actions');

/**
 * Pinned: the screens a voucher shows on, and the ones that count a draft or waiting refund as credit held (Invoices,
 * Credit Notes, Payments In, Customers & Suppliers), then the three ledger screens: a voucher recorded as paid, marked
 * paid or voided moves the books, and every voucher action refreshes the one list.
 */
const PATHS = [
  '/finance/payment-vouchers',
  '/finance/banking',
  '/finance/expenses',
  '/finance/supplier-bills',
  '/finance/payments-out',
  '/finance/refunds',
  '/finance/invoices',
  '/finance/credit-notes',
  '/finance/payments-in',
  '/finance/customers-suppliers',
  '/finance/chart-of-accounts',
  '/finance/journals',
  '/finance/reports',
];
/** What the row showed when the owner pressed Approve or Reject. */
const DECIDE = {
  id: VOUCHER,
  amount: 300,
  txn_date: '2026-10-05',
  method: 'fpx',
  account_id: ACCOUNT,
  contact_id: null,
  party_name: 'Tenaga Nasional',
  category_id: CATEGORY,
  reference: null,
  notes: null,
};
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const NEEDS = { ok: false, error: 'Only an owner or admin can approve or reject a voucher. Ask one of them to do this.' };

const voucher = {
  account_id: ACCOUNT,
  txn_date: '2026-10-05',
  method: 'fpx',
  category_id: CATEGORY,
  amount: 300,
  party_name: 'Tenaga Nasional',
};
const REMOVE = { id: VOUCHER, status: 'pending_approval' };

/** Every voucher action with an input its schema accepts, and the data-layer function it must call. */
const writes: [string, (input: unknown) => Promise<Answer>, unknown, string][] = [
  ['recordVoucherAction', actions.recordVoucherAction, voucher, 'recordVoucher'],
  ['approveVoucherAction', actions.approveVoucherAction, DECIDE, 'approveVoucher'],
  ['rejectVoucherAction', actions.rejectVoucherAction, DECIDE, 'rejectVoucher'],
  ['deleteVoucherAction', actions.deleteVoucherAction, REMOVE, 'deleteVoucher'],
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

  it('lets a member record and delete, and tells them who approves and rejects before anything is read or written', async () => {
    ctl.viewer = { userId: 'u2', orgId: 'org1', role: 'member', isDemo: false };
    expect((await actions.recordVoucherAction(voucher)).ok).toBe(true);
    expect((await actions.deleteVoucherAction(REMOVE)).ok).toBe(true);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['recordVoucher', 'deleteVoucher']);
    ctl.calls = [];
    ctl.revalidated = [];
    expect(await actions.approveVoucherAction(DECIDE)).toEqual(NEEDS);
    expect(await actions.rejectVoucherAction(DECIDE)).toEqual(NEEDS);
    // Not even with an input the schema would refuse: the role is asked first.
    expect(await actions.approveVoucherAction({ id: 'nope' })).toEqual(NEEDS);
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('what is sent and what is refreshed', () => {
  it('answers a rejected input with the schema\'s sentence, without a write or a refresh', async () => {
    expect(await actions.recordVoucherAction({ ...voucher, amount: Number.NaN })).toEqual({ ok: false, error: 'Enter an amount above 0.' });
    expect(await actions.recordVoucherAction({ ...voucher, party_name: '' })).toEqual({
      ok: false,
      error: 'Say who is paid: choose a contact or type a name.',
    });
    expect(await actions.approveVoucherAction({ ...DECIDE, id: 'nope' })).toEqual({ ok: false, error: 'That voucher no longer exists.' });
    expect(await actions.rejectVoucherAction({ id: VOUCHER })).toEqual({
      ok: false,
      error: 'This voucher is not as it was shown to you. Check it again before you decide.',
    });
    expect(await actions.deleteVoucherAction(null)).toEqual({ ok: false, error: 'That voucher no longer exists.' });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('hands the data layer the parsed input, never a status or a workspace from the caller', async () => {
    await actions.recordVoucherAction({ ...voucher, status: 'posted', org_id: 'other', approved_by: 'me', created_by: 'me', number: 'PV-1' });
    expect(ctl.calls).toEqual([
      { fn: 'recordVoucher', orgId: 'org1', input: { ...voucher, contact_id: null, reference: null, notes: null } },
    ]);
  });

  it('refreshes the screens a voucher shows on after every action, refused or not', async () => {
    for (const [name, action, input, fn] of writes) {
      ctl.revalidated = [];
      expect((await action(input)).ok, name).toBe(true);
      expect(ctl.revalidated, name).toEqual(PATHS);
      ctl.revalidated = [];
      ctl.answers[fn] = { ok: false, error: 'That voucher no longer exists.' };
      expect(await action(input), name).toEqual({ ok: false, error: 'That voucher no longer exists.' });
      expect(ctl.revalidated, name).toEqual(PATHS);
    }
  });

  it('answers a record with the voucher and how the database left it', async () => {
    ctl.answers.recordVoucher = { ok: true, data: { id: VOUCHER, status: 'pending_approval' } };
    expect(await actions.recordVoucherAction(voucher)).toEqual({ ok: true, data: { id: VOUCHER, status: 'pending_approval' } });
  });
});
