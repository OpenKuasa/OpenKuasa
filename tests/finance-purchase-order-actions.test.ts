import { beforeEach, describe, expect, it, vi } from 'vitest';

const PO = '33333333-3333-4333-8333-333333333333';
const SUPPLIER = '44444444-4444-4444-8444-444444444444';
const LINE = '66666666-6666-4666-8666-666666666666';
const BILL = '77777777-7777-4777-8777-777777777777';

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
  /** What getPurchaseOrder returns, or an Error for it to throw. */
  order: null as unknown,
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

vi.mock('@/lib/finance/purchase-orders', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/purchase-orders')>();
  const id = { id: '33333333-3333-4333-8333-333333333333' };
  return {
    ...actual,
    savePurchaseOrder: recorder('savePurchaseOrder', id),
    submitPurchaseOrder: recorder('submitPurchaseOrder', { ...id, po_no: 'PO-0007' }),
    decidePurchaseOrder: recorder('decidePurchaseOrder', id),
    withdrawPurchaseOrder: recorder('withdrawPurchaseOrder', id),
    receivePurchaseOrder: recorder('receivePurchaseOrder', id),
    closePurchaseOrder: recorder('closePurchaseOrder', id),
    cancelPurchaseOrder: recorder('cancelPurchaseOrder', id),
    deletePurchaseOrder: recorder('deletePurchaseOrder', id),
    billFromPurchaseOrder: recorder('billFromPurchaseOrder', { ...id, bill_id: '77777777-7777-4777-8777-777777777777' }),
    getPurchaseOrder: async (ctx: { orgId: string }, orderId: string) => {
      ctl.calls.push({ fn: 'getPurchaseOrder', orgId: ctx.orgId, input: orderId });
      if (ctl.order instanceof Error) throw ctl.order;
      return ctl.order;
    },
    getPrintablePurchaseOrder: async (ctx: { orgId: string }, orderId: string) => {
      ctl.calls.push({ fn: 'getPrintablePurchaseOrder', orgId: ctx.orgId, input: orderId });
      if (ctl.order instanceof Error) throw ctl.order;
      return ctl.order;
    },
  };
});

const actions = await import('@/app/(app)/finance/actions');

const POS = ['/finance/purchase-orders', '/finance/rfqs', '/finance/supplier-bills'];
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const GONE = { ok: false, error: 'That purchase order no longer exists.' };
const NEEDS = { ok: false, error: 'Only an owner or admin can do that to a purchase order.' };
const LOCKED =
  'That cannot be done to this purchase order as it now stands. It may have been submitted, approved, closed or cancelled since this page was loaded.';

const order = {
  supplier_id: SUPPLIER,
  po_date: '2026-10-01',
  expected_date: '2026-10-31',
  payment_terms_days: 30,
  delivery_address: 'Lot 3, Shah Alam',
  lines: [{ description: 'Printer paper', quantity: 10, unit_price: 12.5 }],
};
const receive = { id: PO, receipts: [{ line_id: LINE, received_quantity: 4 }] };
const decide = { id: PO, approve: true };

/** Every write action with an input its schema accepts, the data-layer function it must call, and the screens it refreshes. */
const writes: [string, (input: unknown) => Promise<Answer>, unknown, string][] = [
  ['savePurchaseOrderAction', actions.savePurchaseOrderAction, order, 'savePurchaseOrder'],
  ['submitPurchaseOrderAction', actions.submitPurchaseOrderAction, { id: PO }, 'submitPurchaseOrder'],
  ['decidePurchaseOrderAction', actions.decidePurchaseOrderAction, decide, 'decidePurchaseOrder'],
  ['withdrawPurchaseOrderAction', actions.withdrawPurchaseOrderAction, { id: PO }, 'withdrawPurchaseOrder'],
  ['receivePurchaseOrderAction', actions.receivePurchaseOrderAction, receive, 'receivePurchaseOrder'],
  ['closePurchaseOrderAction', actions.closePurchaseOrderAction, { id: PO }, 'closePurchaseOrder'],
  ['cancelPurchaseOrderAction', actions.cancelPurchaseOrderAction, { id: PO }, 'cancelPurchaseOrder'],
  ['deletePurchaseOrderAction', actions.deletePurchaseOrderAction, { id: PO }, 'deletePurchaseOrder'],
];

beforeEach(() => {
  // An admin: approving, rejecting and closing need an owner or admin. What a member may do is below.
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'admin', isDemo: false };
  ctl.calls = [];
  ctl.revalidated = [];
  ctl.answers = {};
  ctl.order = null;
});

describe('who may write', () => {
  it('refuses a viewer and the demo workspace on every action, before anything is parsed, read or written', async () => {
    for (const viewer of [
      { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false },
      { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      for (const [name, action, input] of writes) {
        expect(await action(input), name).toEqual(FORBIDDEN);
        expect(await action(null), name).toEqual(FORBIDDEN);
      }
      expect(await actions.saveAndSubmitPurchaseOrderAction(order)).toEqual(FORBIDDEN);
      expect(await actions.saveAndSubmitPurchaseOrderAction({ lines: [] })).toEqual(FORBIDDEN);
      expect(await actions.billFromPurchaseOrderAction({ id: PO, bill_date: '2026-10-12' })).toEqual(FORBIDDEN);
      expect(await actions.getPurchaseOrderAction({ id: PO })).toEqual(FORBIDDEN);
      expect(await actions.getApprovedPurchaseOrderAction({ id: PO })).toEqual(FORBIDDEN);
      expect(await actions.getApprovedPurchaseOrderAction({ id: 'nope' })).toEqual(FORBIDDEN);
      expect(await actions.getPendingPurchaseOrderAction({ id: PO })).toEqual(FORBIDDEN);
      expect(await actions.getPrintablePurchaseOrderAction({ id: PO })).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('each write action', () => {
  it('calls its own data-layer function in the viewer’s workspace and refreshes Purchase Orders only', async () => {
    for (const [name, action, input, fn] of writes) {
      ctl.calls = [];
      ctl.revalidated = [];
      expect((await action(input)).ok, name).toBe(true);
      expect(ctl.calls.map((c) => [c.fn, c.orgId]), name).toEqual([[fn, 'org1']]);
      expect(ctl.revalidated, name).toEqual(POS);
    }
  });

  it('never takes the workspace from the input', async () => {
    await actions.savePurchaseOrderAction({ ...order, org_id: 'someone-else' });
    await actions.receivePurchaseOrderAction({ ...receive, org_id: 'someone-else', target_org: 'someone-else' });
    expect(ctl.calls.map((c) => c.orgId)).toEqual(['org1', 'org1']);
    expect(JSON.stringify(ctl.calls)).not.toContain('someone-else');
  });

  it('answers with the schema’s sentence, touching nothing, when the input is refused', async () => {
    expect(await actions.savePurchaseOrderAction({ ...order, lines: [] })).toEqual({ ok: false, error: 'Add at least one line.' });
    expect(await actions.savePurchaseOrderAction({ ...order, supplier_id: '' })).toEqual({ ok: false, error: 'Choose a supplier.' });
    expect(await actions.savePurchaseOrderAction({ ...order, expected_date: '2026-09-30' })).toEqual({
      ok: false, error: 'The expected delivery date cannot be before the order date.',
    });
    expect(await actions.savePurchaseOrderAction({ ...order, payment_terms_days: 400 })).toEqual({
      ok: false, error: 'Enter payment terms from 0 to 365 days, or leave them empty.',
    });
    expect(await actions.decidePurchaseOrderAction({ id: PO, approve: false })).toEqual({ ok: false, error: 'Say why the order is rejected.' });
    expect(await actions.receivePurchaseOrderAction({ id: PO, receipts: [] })).toEqual({
      ok: false, error: 'Enter how much has been received for each line, 0 or more.',
    });
    for (const action of [
      actions.submitPurchaseOrderAction, actions.withdrawPurchaseOrderAction, actions.closePurchaseOrderAction,
      actions.cancelPurchaseOrderAction, actions.deletePurchaseOrderAction, actions.receivePurchaseOrderAction,
      actions.decidePurchaseOrderAction,
    ]) {
      expect(await action({ id: 'nope' })).toEqual(GONE);
      expect(await action(null)).toMatchObject({ ok: false });
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('hands the data layer the parsed input: text trimmed, empties as null, terms and address kept', async () => {
    await actions.savePurchaseOrderAction({
      ...order,
      expected_date: '',
      notes: '  ',
      delivery_address: '  ',
      payment_terms_days: null,
      lines: [{ description: ' Printer paper ', quantity: 1.23456, unit_price: 2, uom: '', product_id: '' }],
    });
    expect(ctl.calls[0].input).toEqual({
      supplier_id: SUPPLIER, po_date: '2026-10-01', expected_date: null, payment_terms_days: null, delivery_address: null, notes: null,
      lines: [{ product_id: null, description: 'Printer paper', quantity: 1.235, uom: null, pack_size: null, unit_price: 2, sst_rate: 0 }],
    });
  });

  it('refreshes Purchase Orders after a refusal too, so an order someone else changed shows as it now is', async () => {
    ctl.answers.savePurchaseOrder = { ok: false, error: LOCKED };
    expect(await actions.savePurchaseOrderAction({ ...order, id: PO })).toEqual(ctl.answers.savePurchaseOrder);
    expect(ctl.revalidated).toEqual(POS);
  });
});

describe('approving, rejecting and closing', () => {
  const gated: [string, (input: unknown) => Promise<Answer>, unknown][] = [
    ['approve', actions.decidePurchaseOrderAction, decide],
    ['reject', actions.decidePurchaseOrderAction, { id: PO, approve: false, reason: 'Too dear' }],
    ['close', actions.closePurchaseOrderAction, { id: PO }],
  ];

  it('are done by an owner or an admin', async () => {
    for (const role of ['owner', 'admin']) {
      ctl.viewer = { userId: 'u1', orgId: 'org1', role, isDemo: false };
      for (const [name, action, input] of gated) expect((await action(input)).ok, `${role} ${name}`).toBe(true);
    }
  });

  it('are refused for a member in the order’s own words, before the input is read or anything is called', async () => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
    for (const [name, action, input] of gated) {
      expect(await action(input), name).toEqual(NEEDS);
      expect(await action(null), name).toEqual(NEEDS);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('passes the reason of a rejection on', async () => {
    await actions.decidePurchaseOrderAction({ id: PO, approve: false, reason: ' Too dear ' });
    expect(ctl.calls[0].input).toEqual({ id: PO, approve: false, reason: 'Too dear' });
  });

  it('leave the rest to the database for a member: submit, withdraw, cancel, receive, delete and bill', async () => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
    for (const [name, action, input] of writes.filter(([n]) => !['decidePurchaseOrderAction', 'closePurchaseOrderAction'].includes(n))) {
      expect((await action(input)).ok, name).toBe(true);
    }
    expect((await actions.saveAndSubmitPurchaseOrderAction(order)).ok).toBe(true);
    expect((await actions.billFromPurchaseOrderAction({ id: PO, bill_date: '2026-10-12' })).ok).toBe(true);
  });

  it('say who else must approve when the database refuses the person who raised it', async () => {
    ctl.answers.decidePurchaseOrder = { ok: false, error: 'You raised or submitted this purchase order, so someone else has to approve it.' };
    expect(await actions.decidePurchaseOrderAction(decide)).toEqual(ctl.answers.decidePurchaseOrder);
    expect(ctl.revalidated).toEqual(POS);
  });
});

describe('saveAndSubmitPurchaseOrderAction', () => {
  it('saves, then submits what it saved, and answers with the number', async () => {
    expect(await actions.saveAndSubmitPurchaseOrderAction(order)).toEqual({ ok: true, data: { id: PO, po_no: 'PO-0007' } });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['savePurchaseOrder', 'submitPurchaseOrder']);
    expect(ctl.calls[1].input).toEqual({ id: PO });
    expect(ctl.revalidated).toEqual(POS);
  });

  it('does not submit when the save is refused', async () => {
    ctl.answers.savePurchaseOrder = { ok: false, error: 'The supplier or a product on this purchase order no longer exists.' };
    expect(await actions.saveAndSubmitPurchaseOrderAction(order)).toEqual(ctl.answers.savePurchaseOrder);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['savePurchaseOrder']);
    expect(ctl.revalidated).toEqual(POS);
  });

  it('keeps the draft when submitting is refused, and says which draft it is', async () => {
    ctl.answers.submitPurchaseOrder = { ok: false, error: 'A purchase order needs at least one line with an amount.' };
    expect(await actions.saveAndSubmitPurchaseOrderAction(order)).toEqual({
      ok: false, error: 'A purchase order needs at least one line with an amount.', draftId: PO,
    });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['savePurchaseOrder', 'submitPurchaseOrder']);
  });

  it('answers with the schema’s sentence and saves nothing when the form is refused', async () => {
    expect(await actions.saveAndSubmitPurchaseOrderAction({ ...order, supplier_id: '' })).toEqual({ ok: false, error: 'Choose a supplier.' });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('billFromPurchaseOrderAction', () => {
  const input = { id: PO, bill_date: '2026-10-12' };

  it('raises the bill in the viewer’s workspace and refreshes Purchase Orders and Supplier Bills', async () => {
    expect(await actions.billFromPurchaseOrderAction(input)).toEqual({ ok: true, data: { id: PO, bill_id: BILL } });
    expect(ctl.calls).toEqual([{ fn: 'billFromPurchaseOrder', orgId: 'org1', input }]);
    expect(ctl.revalidated).toEqual(['/finance/purchase-orders', '/finance/supplier-bills']);
  });
  it('answers with the schema’s sentence, touching nothing, for a bad date or id', async () => {
    expect(await actions.billFromPurchaseOrderAction({ id: PO, bill_date: 'today' })).toEqual({ ok: false, error: 'Enter a valid date.' });
    expect(await actions.billFromPurchaseOrderAction({ id: 'nope', bill_date: '2026-10-12' })).toEqual(GONE);
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
  it('refreshes both screens after a refusal too', async () => {
    ctl.answers.billFromPurchaseOrder = { ok: false, error: 'A bill can only be raised against an approved purchase order.' };
    expect(await actions.billFromPurchaseOrderAction(input)).toEqual(ctl.answers.billFromPurchaseOrder);
    expect(ctl.revalidated).toEqual(['/finance/purchase-orders', '/finance/supplier-bills']);
  });
});

/** The three reads: a draft for the Edit form, an order awaiting approval for Approve and Reject, an approved order for the delivery card. */
describe.each([
  ['getPurchaseOrderAction', 'draft', ['pending_approval', 'approved', 'closed', 'cancelled']],
  ['getPendingPurchaseOrderAction', 'pending_approval', ['draft', 'approved', 'closed', 'cancelled']],
  ['getApprovedPurchaseOrderAction', 'approved', ['draft', 'pending_approval', 'closed', 'cancelled']],
] as const)('%s', (name, wanted, others) => {
  const read = (input: unknown) => actions[name](input);
  const found = { id: PO, status: wanted, lines: [] };

  it(`returns an order that is ${wanted}, without refreshing anything`, async () => {
    ctl.order = found;
    expect(await read({ id: PO })).toEqual({ ok: true, data: found });
    expect(ctl.calls).toEqual([{ fn: 'getPurchaseOrder', orgId: 'org1', input: PO }]);
    expect(ctl.revalidated).toEqual([]);
  });
  it('says the order is gone, and refreshes the list, when it was deleted meanwhile', async () => {
    expect(await read({ id: PO })).toEqual(GONE);
    expect(ctl.revalidated).toEqual(POS);
  });
  it(`says it can no longer be done, and refreshes the list, when the order is not ${wanted}`, async () => {
    for (const status of others) {
      ctl.revalidated = [];
      ctl.order = { ...found, status };
      expect(await read({ id: PO }), status).toEqual({ ok: false, error: LOCKED });
      expect(ctl.revalidated, status).toEqual(POS);
    }
  });
  it('says the order is gone for an id that is not an id, without reading', async () => {
    expect(await read({ id: 'nope' })).toEqual(GONE);
    expect(await read(undefined)).toEqual(GONE);
    expect(ctl.calls).toEqual([]);
  });
  it('answers with a sentence when the read fails, and logs the cause', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.order = new Error('connection reset');
    expect(await read({ id: PO })).toEqual({ ok: false, error: 'That could not be loaded. Please try again.' });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
  it('is open to a member who may write', async () => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
    ctl.order = found;
    expect((await read({ id: PO })).ok).toBe(true);
  });
});

/** The read for printing: an approved or a closed order, never one that was not approved or was cancelled. */
describe('getPrintablePurchaseOrderAction', () => {
  const read = (input: unknown) => actions.getPrintablePurchaseOrderAction(input);

  it('returns an approved or a closed order, without refreshing anything', async () => {
    for (const status of ['approved', 'closed']) {
      ctl.calls = [];
      ctl.order = { id: PO, status, lines: [] };
      expect(await read({ id: PO }), status).toEqual({ ok: true, data: ctl.order });
      expect(ctl.calls, status).toEqual([{ fn: 'getPrintablePurchaseOrder', orgId: 'org1', input: PO }]);
    }
    expect(ctl.revalidated).toEqual([]);
  });
  it('says it can no longer be done, and refreshes the list, for a draft, an order awaiting approval or a cancelled one', async () => {
    for (const status of ['draft', 'pending_approval', 'cancelled']) {
      ctl.revalidated = [];
      ctl.order = { id: PO, status, lines: [] };
      expect(await read({ id: PO }), status).toEqual({ ok: false, error: LOCKED });
      expect(ctl.revalidated, status).toEqual(POS);
    }
  });
  it('says the order is gone when it was deleted meanwhile, or for an id that is not an id', async () => {
    expect(await read({ id: PO })).toEqual(GONE);
    expect(await read({ id: 'nope' })).toEqual(GONE);
  });
});
