import { beforeEach, describe, expect, it, vi } from 'vitest';

const VOUCHER = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const SUPPLIER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BILL = 'b1111111-1111-4111-8111-111111111111';

type Answer = { ok: true; data: unknown } | { ok: false; error: string };

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false } as {
    userId: string; orgId: string; role: string; isDemo: boolean;
  },
  /** Every data-layer call, in order: the function, the workspace it was given, and its input. */
  calls: [] as { fn: string; orgId: string; input: unknown }[],
  revalidated: [] as string[],
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
    return { ok: true, data: ok };
  };
}

vi.mock('@/lib/finance/vouchers', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/vouchers')>();
  return {
    ...actual,
    saveVoucher: recorder('saveVoucher', { id: '55555555-5555-4555-8555-555555555555', status: 'draft' }),
    submitVoucher: recorder('submitVoucher', { id: '55555555-5555-4555-8555-555555555555' }),
  };
});

const actions = await import('@/app/(app)/finance/actions');

/** The screens a voucher shows on: the same ten every voucher action refreshes (pinned in finance-voucher-actions.test.ts). */
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
];
const DRAFT = {
  kind: 'bills', account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx', reference: '', notes: '',
  allocations: [{ bill_id: BILL, amount: 100 }],
};
const SEEN = {
  id: VOUCHER, amount: 100, txn_date: '2026-10-05', method: 'fpx', account_id: ACCOUNT,
  contact_id: SUPPLIER, party_name: null, category_id: null, reference: null, notes: null,
};
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };

const writes: [string, (input: unknown) => Promise<Answer>, unknown, string][] = [
  ['saveVoucherAction', actions.saveVoucherAction, DRAFT, 'saveVoucher'],
  ['submitVoucherAction', actions.submitVoucherAction, SEEN, 'submitVoucher'],
];

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
  ctl.calls = [];
  ctl.revalidated = [];
});

describe('saving a draft and sending it for approval', () => {
  it('are refused to a viewer and the demo workspace, before anything is read or written', async () => {
    for (const viewer of [
      { userId: 'u3', orgId: 'org1', role: 'viewer', isDemo: false },
      { userId: 'u4', orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      for (const [name, action, input] of writes) expect(await action(input), `${name} ${viewer.role}`).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
  it('are open to a member, an admin and an owner alike: neither needs a sign-off', async () => {
    for (const role of ['member', 'admin', 'owner']) {
      ctl.viewer = { userId: 'u1', orgId: 'org1', role, isDemo: false };
      ctl.calls = [];
      for (const [name, action, input, fn] of writes) {
        expect((await action(input)).ok, `${name} ${role}`).toBe(true);
        expect(ctl.calls.at(-1)).toMatchObject({ fn, orgId: 'org1' });
      }
    }
  });
  it('answer a rejected input with the schema’s sentence, without a write or a refresh', async () => {
    expect(await actions.saveVoucherAction({ ...DRAFT, allocations: [] })).toEqual({ ok: false, error: 'Choose at least one bill this voucher pays.' });
    expect(await actions.saveVoucherAction({ ...DRAFT, kind: 'expenses' })).toEqual({
      ok: false, error: 'Choose what this voucher is for: a supplier’s bills, or an expense category.',
    });
    expect(await actions.submitVoucherAction({ ...SEEN, amount: '100' })).toEqual({
      ok: false, error: 'This voucher is not as it was shown to you. Check it again before you decide.',
    });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
  it('hand the data layer the parsed input: never a status, a payee or a workspace from the caller', async () => {
    await actions.saveVoucherAction({ ...DRAFT, send: true, status: 'scheduled', org_id: 'other', contact_id: SUPPLIER, approved_by: 'me' });
    expect(ctl.calls[0]).toEqual({
      fn: 'saveVoucher', orgId: 'org1',
      input: { kind: 'bills', account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx', reference: null, notes: null, send: true, allocations: [{ bill_id: BILL, amount: 100 }] },
    });
    await actions.submitVoucherAction({ ...SEEN, status: 'scheduled', org_id: 'other' });
    expect(ctl.calls[1]).toEqual({ fn: 'submitVoucher', orgId: 'org1', input: SEEN });
  });
  it('refresh the screens a voucher shows on, and answer a save with the voucher and how the database left it', async () => {
    expect(await actions.saveVoucherAction(DRAFT)).toEqual({ ok: true, data: { id: VOUCHER, status: 'draft' } });
    expect(ctl.revalidated).toEqual(PATHS);
    ctl.revalidated = [];
    await actions.submitVoucherAction(SEEN);
    expect(ctl.revalidated).toEqual(PATHS);
  });
});
