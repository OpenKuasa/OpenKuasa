/**
 * The server actions that pay and void a voucher: who may, what reaches the data layer, and which screens are
 * refreshed. The data layer is replaced by recorders; nothing here touches a database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const VOUCHER = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CATEGORY = '99999999-9999-4999-8999-999999999999';

type Answer = { ok: true; data: unknown } | { ok: false; error: string };

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'admin', isDemo: false } as {
    userId: string; orgId: string; role: string; isDemo: boolean;
  },
  calls: [] as { fn: string; orgId: string; input: unknown }[],
  revalidated: [] as string[],
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
    recordVoucher: recorder('recordVoucher', { id: '55555555-5555-4555-8555-555555555555', status: 'posted' }),
    markVoucherPaid: recorder('markVoucherPaid', { id: '55555555-5555-4555-8555-555555555555', number: 'PV-0007' }),
    voidVoucher: recorder('voidVoucher', { id: '55555555-5555-4555-8555-555555555555' }),
  };
});

const actions = await import('@/app/(app)/finance/actions');

/**
 * Pinned: the ten screens a voucher shows on or is counted on, then the three ledger screens. A voucher recorded as
 * paid, marked paid or voided moves the books.
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
const PAID_NOW = {
  account_id: ACCOUNT,
  txn_date: '2026-10-05',
  method: 'fpx',
  category_id: CATEGORY,
  amount: 300,
  party_name: 'Tenaga Nasional',
  paid_now: true,
};
const PAY = { id: VOUCHER, paid_on: '2026-10-09' };
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const NEEDS = { ok: false, error: 'Only an owner or admin can post, pay or void. Ask one of them to do this.' };

/** The three writes that move money, with an input each schema accepts and the data-layer function it must call. */
const writes: [string, (input: unknown) => Promise<Answer>, unknown, string][] = [
  ['recordVoucherAction (paid now)', actions.recordVoucherAction, PAID_NOW, 'recordVoucher'],
  ['markVoucherPaidAction', actions.markVoucherPaidAction, PAY, 'markVoucherPaid'],
  ['voidVoucherAction', actions.voidVoucherAction, { id: VOUCHER }, 'voidVoucher'],
];

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'admin', isDemo: false };
  ctl.calls = [];
  ctl.revalidated = [];
  ctl.answers = {};
});

describe('who may pay and void', () => {
  it('refuses a viewer and the demo workspace, before anything is read or written', async () => {
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
  it('refuses a member all three before anything is read or written, each in a sentence that is true of it', async () => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
    // The database would not refuse a member's "paid now": it would quietly make the voucher wait. So the action must.
    expect(await actions.recordVoucherAction(PAID_NOW)).toEqual({
      ok: false,
      error: 'Only an owner or admin can record a voucher as paid.',
    });
    expect(await actions.markVoucherPaidAction(PAY)).toEqual(NEEDS);
    expect(await actions.voidVoucherAction({ id: VOUCHER })).toEqual(NEEDS);
    // Asked before the input is looked at.
    expect(await actions.markVoucherPaidAction(null)).toEqual(NEEDS);
    expect(await actions.voidVoucherAction(null)).toEqual(NEEDS);
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
  it('still lets a member record a voucher that is not paid now', async () => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
    for (const input of [{ ...PAID_NOW, paid_now: false }, { ...PAID_NOW, paid_now: undefined }]) {
      expect((await actions.recordVoucherAction(input)).ok).toBe(true);
    }
    expect(ctl.calls).toHaveLength(2);
  });
  it('lets an owner and an admin do all three, in their own workspace', async () => {
    for (const role of ['owner', 'admin']) {
      ctl.viewer = { userId: 'u1', orgId: 'org1', role, isDemo: false };
      ctl.calls = [];
      for (const [name, action, input, fn] of writes) {
        expect((await action(input)).ok, `${role} ${name}`).toBe(true);
        expect(ctl.calls.at(-1)).toMatchObject({ fn, orgId: 'org1' });
      }
      expect(ctl.calls).toHaveLength(3);
    }
  });
});

describe('what is sent and what is refreshed', () => {
  it('refuses input the schemas refuse, in their own sentence, and writes and refreshes nothing', async () => {
    expect(await actions.markVoucherPaidAction({ id: VOUCHER, paid_on: '' })).toEqual({ ok: false, error: 'Enter the date it was paid.' });
    expect(await actions.markVoucherPaidAction({ id: 'nope', paid_on: '2026-10-09' })).toEqual({ ok: false, error: 'That voucher no longer exists.' });
    expect(await actions.voidVoucherAction({})).toEqual({ ok: false, error: 'That voucher no longer exists.' });
    expect(await actions.recordVoucherAction({ ...PAID_NOW, paid_now: 'yes' })).toEqual({
      ok: false,
      error: 'Check who is paid, the amount and the method, then try again.',
    });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
  it('hands the data layer the parsed input, never a status or a workspace from the caller', async () => {
    await actions.markVoucherPaidAction({ ...PAY, org_id: 'other', status: 'posted', number: 'PV-1' });
    await actions.voidVoucherAction({ id: VOUCHER, org_id: 'other', status: 'draft' });
    await actions.recordVoucherAction({ ...PAID_NOW, status: 'void', org_id: 'other' });
    expect(ctl.calls).toEqual([
      { fn: 'markVoucherPaid', orgId: 'org1', input: PAY },
      { fn: 'voidVoucher', orgId: 'org1', input: { id: VOUCHER } },
      { fn: 'recordVoucher', orgId: 'org1', input: { ...PAID_NOW, contact_id: null, reference: null, notes: null } },
    ]);
  });
  it('refreshes the voucher screens and the ledger screens after every attempt that reached the database, refused or not', async () => {
    for (const [name, action, input, fn] of writes) {
      ctl.revalidated = [];
      expect((await action(input)).ok, name).toBe(true);
      expect(ctl.revalidated, name).toEqual(PATHS);
      ctl.revalidated = [];
      ctl.answers[fn] = { ok: false, error: 'This voucher has already been voided.' };
      expect(await action(input), name).toEqual({ ok: false, error: 'This voucher has already been voided.' });
      expect(ctl.revalidated, name).toEqual(PATHS);
    }
  });
  it('answers a payment with the voucher and its number', async () => {
    expect(await actions.markVoucherPaidAction(PAY)).toEqual({ ok: true, data: { id: VOUCHER, number: 'PV-0007' } });
  });
});
