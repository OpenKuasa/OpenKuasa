import { beforeEach, describe, expect, it, vi } from 'vitest';

const BILL = '33333333-3333-4333-8333-333333333333';
const SUPPLIER = '44444444-4444-4444-8444-444444444444';
const TXN = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';

type Answer = { ok: true; data: unknown } | { ok: false; error: string };

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false } as {
    userId: string; orgId: string; role: string; isDemo: boolean;
  },
  /** Every data-layer call, in order: the function, the workspace it was given, and its input. */
  calls: [] as { fn: string; orgId: string; input: unknown }[],
  revalidated: [] as string[],
  /** What each data-layer function answers; a function with no entry succeeds. */
  answers: {} as Record<string, unknown>,
  /** What getBill returns, or an Error for it to throw. */
  bill: null as unknown,
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

vi.mock('@/lib/finance/bills', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/bills')>();
  return {
    ...actual,
    saveBill: recorder('saveBill', { id: '33333333-3333-4333-8333-333333333333' }),
    postBill: recorder('postBill', { id: '33333333-3333-4333-8333-333333333333', bill_no: 'BILL-0007' }),
    voidBill: recorder('voidBill', { id: '33333333-3333-4333-8333-333333333333' }),
    deleteBill: recorder('deleteBill', { id: '33333333-3333-4333-8333-333333333333' }),
    getBill: async (ctx: { orgId: string }, id: string) => {
      ctl.calls.push({ fn: 'getBill', orgId: ctx.orgId, input: id });
      if (ctl.bill instanceof Error) throw ctl.bill;
      return ctl.bill;
    },
  };
});

vi.mock('@/lib/finance/money', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/money')>();
  return {
    ...actual,
    recordPaymentOut: recorder('recordPaymentOut', { id: '55555555-5555-4555-8555-555555555555' }),
    markPaymentPaid: recorder('markPaymentPaid', { id: '55555555-5555-4555-8555-555555555555', number: 'PV-0003' }),
    voidPayment: recorder('voidPayment', { id: '55555555-5555-4555-8555-555555555555' }),
    deleteScheduledPayment: recorder('deleteScheduledPayment', { id: '55555555-5555-4555-8555-555555555555' }),
  };
});

const actions = await import('@/app/(app)/finance/actions');

// A payment to a supplier is a voucher: Payment Vouchers lists every movement of money out.
const PATHS = ['/finance/supplier-bills', '/finance/payments-out', '/finance/customers-suppliers', '/finance/payment-vouchers'];
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };

const bill = {
  supplier_id: SUPPLIER,
  bill_date: '2026-10-01',
  due_date: '2026-10-31',
  lines: [{ description: 'Gloves', quantity: 10, unit_price: 12.5 }],
};
const payment = {
  account_id: ACCOUNT,
  txn_date: '2026-10-05',
  method: 'fpx',
  allocations: [{ bill_id: BILL, amount: 100 }],
};

/** Every write action with an input its schema accepts, and the data-layer function it must call. */
const writes: [string, (input: unknown) => Promise<Answer>, unknown, string][] = [
  ['saveBillAction', actions.saveBillAction, bill, 'saveBill'],
  ['postBillAction', actions.postBillAction, { id: BILL }, 'postBill'],
  ['voidBillAction', actions.voidBillAction, { id: BILL }, 'voidBill'],
  ['deleteBillAction', actions.deleteBillAction, { id: BILL }, 'deleteBill'],
  ['recordPaymentOutAction', actions.recordPaymentOutAction, payment, 'recordPaymentOut'],
  ['markPaymentPaidAction', actions.markPaymentPaidAction, { id: TXN, paid_on: '2026-10-09' }, 'markPaymentPaid'],
  ['voidPaymentAction', actions.voidPaymentAction, { id: TXN }, 'voidPayment'],
  ['deleteScheduledPaymentAction', actions.deleteScheduledPaymentAction, { id: TXN }, 'deleteScheduledPayment'],
];

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
  ctl.calls = [];
  ctl.revalidated = [];
  ctl.answers = {};
  ctl.bill = null;
});

describe('who may write', () => {
  it('refuses a viewer and the demo workspace on every action, before anything is read or written', async () => {
    for (const viewer of [
      { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false },
      { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      for (const [name, action, input] of writes) expect(await action(input), name).toEqual(FORBIDDEN);
      expect(await actions.saveAndPostBillAction(bill)).toEqual(FORBIDDEN);
      expect(await actions.getBillAction({ id: BILL })).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('each write action', () => {
  it('calls its own data-layer function in the viewer’s workspace and refreshes the three screens', async () => {
    for (const [name, action, input, fn] of writes) {
      ctl.calls = [];
      ctl.revalidated = [];
      expect((await action(input)).ok, name).toBe(true);
      expect(ctl.calls.map((c) => [c.fn, c.orgId]), name).toEqual([[fn, 'org1']]);
      expect(ctl.revalidated, name).toEqual(PATHS);
    }
  });

  it('never takes the workspace from the input', async () => {
    await actions.saveBillAction({ ...bill, org_id: 'someone-else' });
    await actions.recordPaymentOutAction({ ...payment, org_id: 'someone-else' });
    expect(ctl.calls.map((c) => c.orgId)).toEqual(['org1', 'org1']);
    expect(JSON.stringify(ctl.calls)).not.toContain('someone-else');
  });

  it('answers with the schema’s sentence, touching nothing, when the input is refused', async () => {
    expect(await actions.saveBillAction({ ...bill, lines: [] })).toEqual({ ok: false, error: 'Add at least one line.' });
    expect(await actions.postBillAction({ id: 'nope' })).toEqual({ ok: false, error: 'That bill no longer exists.' });
    expect(await actions.recordPaymentOutAction({ ...payment, allocations: [] })).toEqual({
      ok: false,
      error: 'Choose at least one bill to pay.',
    });
    expect(await actions.markPaymentPaidAction({ id: TXN, paid_on: 'today' })).toEqual({ ok: false, error: 'Enter a valid date.' });
    expect(await actions.voidPaymentAction(null)).toMatchObject({ ok: false });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('refreshes the screens after a refusal too, so a record someone else changed shows as it now is', async () => {
    // The bill was posted in another tab while this one still had its draft open.
    ctl.answers.saveBill = { ok: false, error: 'This bill is posted and can no longer be changed. Void it instead.' };
    expect(await actions.saveBillAction({ ...bill, id: BILL })).toEqual(ctl.answers.saveBill);
    expect(ctl.revalidated).toEqual(PATHS);

    ctl.revalidated = [];
    ctl.answers.voidPayment = { ok: false, error: 'That payment no longer exists.' };
    expect(await actions.voidPaymentAction({ id: TXN })).toEqual(ctl.answers.voidPayment);
    expect(ctl.revalidated).toEqual(PATHS);
  });
});

describe('saveAndPostBillAction', () => {
  it('saves, then posts what it saved, and answers with the number', async () => {
    expect(await actions.saveAndPostBillAction(bill)).toEqual({ ok: true, data: { id: BILL, bill_no: 'BILL-0007' } });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveBill', 'postBill']);
    expect(ctl.calls[1].input).toEqual({ id: BILL });
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('does not post when the save is refused', async () => {
    ctl.answers.saveBill = { ok: false, error: 'The supplier or a product on this bill no longer exists.' };
    expect(await actions.saveAndPostBillAction(bill)).toEqual(ctl.answers.saveBill);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveBill']);
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('keeps the draft when the post is refused, and says which draft it is', async () => {
    ctl.answers.postBill = { ok: false, error: 'A bill needs at least one line with an amount.' };
    expect(await actions.saveAndPostBillAction(bill)).toEqual({
      ok: false,
      error: 'A bill needs at least one line with an amount.',
      draftId: BILL,
    });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveBill', 'postBill']);
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('answers with the schema’s sentence and saves nothing when the form is refused', async () => {
    expect(await actions.saveAndPostBillAction({ ...bill, supplier_id: '' })).toEqual({ ok: false, error: 'Choose a supplier.' });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('getBillAction', () => {
  const draft = { id: BILL, display_status: 'draft', lines: [] };

  it('returns a draft with its lines, without refreshing anything', async () => {
    ctl.bill = draft;
    expect(await actions.getBillAction({ id: BILL })).toEqual({ ok: true, data: draft });
    expect(ctl.calls).toEqual([{ fn: 'getBill', orgId: 'org1', input: BILL }]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('says the bill is gone, and refreshes the list, when it was deleted meanwhile', async () => {
    expect(await actions.getBillAction({ id: BILL })).toEqual({ ok: false, error: 'That bill no longer exists.' });
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('says the bill is locked, and refreshes the list, when it was posted meanwhile', async () => {
    ctl.bill = { ...draft, display_status: 'pending' };
    expect(await actions.getBillAction({ id: BILL })).toEqual({
      ok: false,
      error: 'This bill is posted and can no longer be changed. Void it instead.',
    });
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('says the bill is gone for an id that is not an id, without reading', async () => {
    expect(await actions.getBillAction({ id: 'nope' })).toEqual({ ok: false, error: 'That bill no longer exists.' });
    expect(await actions.getBillAction(undefined)).toEqual({ ok: false, error: 'That bill no longer exists.' });
    expect(ctl.calls).toEqual([]);
  });

  it('answers with a sentence when the read fails, and logs the cause', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.bill = new Error('connection reset');
    expect(await actions.getBillAction({ id: BILL })).toEqual({ ok: false, error: 'That could not be loaded. Please try again.' });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
