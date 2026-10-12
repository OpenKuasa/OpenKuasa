import { beforeEach, describe, expect, it, vi } from 'vitest';

const INVOICE = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const TXN = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';

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
  /** What getInvoice returns, or an Error for it to throw. */
  invoice: null as unknown,
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

vi.mock('@/lib/finance/invoices', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/invoices')>();
  return {
    ...actual,
    saveInvoice: recorder('saveInvoice', { id: '33333333-3333-4333-8333-333333333333' }),
    postInvoice: recorder('postInvoice', { id: '33333333-3333-4333-8333-333333333333', invoice_no: 'INV-0007' }),
    voidInvoice: recorder('voidInvoice', { id: '33333333-3333-4333-8333-333333333333' }),
    deleteInvoice: recorder('deleteInvoice', { id: '33333333-3333-4333-8333-333333333333' }),
    setEInvoice: recorder('setEInvoice', { id: '33333333-3333-4333-8333-333333333333' }),
    getInvoice: async (ctx: { orgId: string }, id: string) => {
      ctl.calls.push({ fn: 'getInvoice', orgId: ctx.orgId, input: id });
      if (ctl.invoice instanceof Error) throw ctl.invoice;
      return ctl.invoice;
    },
  };
});

vi.mock('@/lib/finance/money', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/money')>();
  return {
    ...actual,
    recordPaymentIn: recorder('recordPaymentIn', { id: '55555555-5555-4555-8555-555555555555' }),
    voidPaymentIn: recorder('voidPaymentIn', { id: '55555555-5555-4555-8555-555555555555' }),
    voidPayment: recorder('voidPayment', { id: '55555555-5555-4555-8555-555555555555' }),
  };
});

const actions = await import('@/app/(app)/finance/actions');

// A change to an invoice or a payment in shows on the three follow-on screens too.
const PATHS = [
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/customers-suppliers',
  '/finance/quotations',
  '/finance/credit-notes',
  '/finance/refunds',
  // A payment in is a receipt: Cash Receipts lists every movement of money in.
  '/finance/cash-receipts',
  '/finance/banking',
];
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };

const invoice = {
  customer_id: CUSTOMER,
  invoice_date: '2026-10-01',
  due_date: '2026-10-31',
  lines: [{ description: 'Design work', quantity: 10, unit_price: 12.5 }],
};
const payment = {
  account_id: ACCOUNT,
  txn_date: '2026-10-05',
  method: 'fpx',
  allocations: [{ invoice_id: INVOICE, amount: 100 }],
};
const einvoice = { id: INVOICE, einvoice_status: 'validated', einvoice_uuid: 'F9D425P6DS7D8IU' };

/** Every write action with an input its schema accepts, and the data-layer function it must call. */
const writes: [string, (input: unknown) => Promise<Answer>, unknown, string][] = [
  ['saveInvoiceAction', actions.saveInvoiceAction, invoice, 'saveInvoice'],
  ['postInvoiceAction', actions.postInvoiceAction, { id: INVOICE }, 'postInvoice'],
  ['voidInvoiceAction', actions.voidInvoiceAction, { id: INVOICE }, 'voidInvoice'],
  ['deleteInvoiceAction', actions.deleteInvoiceAction, { id: INVOICE }, 'deleteInvoice'],
  ['setEInvoiceAction', actions.setEInvoiceAction, einvoice, 'setEInvoice'],
  ['recordPaymentInAction', actions.recordPaymentInAction, payment, 'recordPaymentIn'],
  ['voidPaymentInAction', actions.voidPaymentInAction, { id: TXN }, 'voidPaymentIn'],
];

beforeEach(() => {
  // An admin: posting, paying and voiding need an owner or admin. What a member may do is at the end.
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'admin', isDemo: false };
  ctl.calls = [];
  ctl.revalidated = [];
  ctl.answers = {};
  ctl.invoice = null;
});

describe('who may write', () => {
  it('refuses a viewer and the demo workspace on every action, before anything is read or written', async () => {
    for (const viewer of [
      { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false },
      { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      for (const [name, action, input] of writes) expect(await action(input), name).toEqual(FORBIDDEN);
      expect(await actions.saveAndPostInvoiceAction(invoice)).toEqual(FORBIDDEN);
      expect(await actions.getInvoiceAction({ id: INVOICE })).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('tells a viewer they may not, not that the invoice is gone', async () => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false };
    // The database would refuse a viewer's void as "no row", which reads as "no longer exists".
    ctl.answers.voidInvoice = { ok: false, error: 'That invoice no longer exists.' };
    ctl.answers.deleteInvoice = { ok: false, error: 'That invoice no longer exists.' };
    expect(await actions.voidInvoiceAction({ id: INVOICE })).toEqual(FORBIDDEN);
    expect(await actions.deleteInvoiceAction({ id: INVOICE })).toEqual(FORBIDDEN);
    expect(await actions.voidPaymentInAction({ id: TXN })).toEqual(FORBIDDEN);
    expect(ctl.calls).toEqual([]);
  });
});

describe('each write action', () => {
  it('calls its own data-layer function in the viewer’s workspace and refreshes the three sales screens', async () => {
    for (const [name, action, input, fn] of writes) {
      ctl.calls = [];
      ctl.revalidated = [];
      expect((await action(input)).ok, name).toBe(true);
      expect(ctl.calls.map((c) => [c.fn, c.orgId]), name).toEqual([[fn, 'org1']]);
      expect(ctl.revalidated, name).toEqual(PATHS);
    }
  });

  it('voids a payment in through the money-in function, never the money-out one', async () => {
    await actions.voidPaymentInAction({ id: TXN });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['voidPaymentIn']);
    expect(ctl.revalidated).toContain('/finance/invoices');
    expect(ctl.revalidated).toContain('/finance/payments-in');
    expect(ctl.revalidated).not.toContain('/finance/supplier-bills');
  });

  it('leaves voiding a payment out refreshing the purchase screens', async () => {
    await actions.voidPaymentAction({ id: TXN });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['voidPayment']);
    expect(ctl.revalidated).toEqual([
      '/finance/supplier-bills', '/finance/payments-out', '/finance/customers-suppliers', '/finance/payment-vouchers',
      '/finance/banking',
    ]);
    expect(ctl.revalidated).not.toContain('/finance/cash-receipts');
  });

  it('never takes the workspace from the input', async () => {
    await actions.saveInvoiceAction({ ...invoice, org_id: 'someone-else' });
    await actions.recordPaymentInAction({ ...payment, org_id: 'someone-else' });
    await actions.setEInvoiceAction({ ...einvoice, org_id: 'someone-else' });
    expect(ctl.calls.map((c) => c.orgId)).toEqual(['org1', 'org1', 'org1']);
    expect(JSON.stringify(ctl.calls)).not.toContain('someone-else');
  });

  it('answers with the schema’s sentence, touching nothing, when the input is refused', async () => {
    expect(await actions.saveInvoiceAction({ ...invoice, lines: [] })).toEqual({ ok: false, error: 'Add at least one line.' });
    expect(await actions.postInvoiceAction({ id: 'nope' })).toEqual({ ok: false, error: 'That invoice no longer exists.' });
    expect(await actions.recordPaymentInAction({ ...payment, allocations: [] })).toEqual({
      ok: false,
      error: 'Choose at least one invoice this payment is for.',
    });
    expect(
      await actions.recordPaymentInAction({
        ...payment,
        // The same invoice twice, its id once in capitals.
        allocations: [
          { invoice_id: 'abcdefab-cdef-4abc-8def-abcdefabcdef', amount: 1 },
          { invoice_id: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF', amount: 1 },
        ],
      }),
    ).toEqual({ ok: false, error: 'Each invoice can appear once on a payment.' });
    expect(await actions.setEInvoiceAction({ id: INVOICE, einvoice_status: 'sent' })).toEqual({ ok: false, error: 'Choose an e-Invois status.' });
    expect(await actions.voidPaymentInAction(null)).toMatchObject({ ok: false });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('hands the data layer the parsed input: text trimmed, empties as null', async () => {
    await actions.setEInvoiceAction({ id: INVOICE, einvoice_status: 'pending', einvoice_uuid: '  ' });
    expect(ctl.calls[0].input).toEqual({ id: INVOICE, einvoice_status: 'pending', einvoice_uuid: null });
  });

  it('refreshes the screens after a refusal too, so a record someone else changed shows as it now is', async () => {
    // The invoice was posted in another tab while this one still had its draft open.
    ctl.answers.saveInvoice = { ok: false, error: 'This invoice has been posted or voided, so that can no longer be done.' };
    expect(await actions.saveInvoiceAction({ ...invoice, id: INVOICE })).toEqual(ctl.answers.saveInvoice);
    expect(ctl.revalidated).toEqual(PATHS);

    ctl.revalidated = [];
    ctl.answers.voidInvoice = { ok: false, error: 'This invoice has payments. Void them on Payments In before voiding it.' };
    expect(await actions.voidInvoiceAction({ id: INVOICE })).toEqual(ctl.answers.voidInvoice);
    expect(ctl.revalidated).toEqual(PATHS);
  });
});

describe('saveAndPostInvoiceAction', () => {
  it('saves, then posts what it saved, and answers with the number', async () => {
    expect(await actions.saveAndPostInvoiceAction(invoice)).toEqual({ ok: true, data: { id: INVOICE, invoice_no: 'INV-0007' } });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveInvoice', 'postInvoice']);
    expect(ctl.calls[1].input).toEqual({ id: INVOICE });
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('does not post when the save is refused', async () => {
    ctl.answers.saveInvoice = { ok: false, error: 'The customer or a product on this invoice no longer exists.' };
    expect(await actions.saveAndPostInvoiceAction(invoice)).toEqual(ctl.answers.saveInvoice);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveInvoice']);
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('keeps the draft when the post is refused, and says which draft it is', async () => {
    ctl.answers.postInvoice = { ok: false, error: 'An invoice needs at least one line with an amount.' };
    expect(await actions.saveAndPostInvoiceAction(invoice)).toEqual({
      ok: false,
      error: 'An invoice needs at least one line with an amount.',
      draftId: INVOICE,
    });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveInvoice', 'postInvoice']);
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('answers with the schema’s sentence and saves nothing when the form is refused', async () => {
    expect(await actions.saveAndPostInvoiceAction({ ...invoice, customer_id: '' })).toEqual({ ok: false, error: 'Choose a customer.' });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('getInvoiceAction', () => {
  const draft = { id: INVOICE, display_status: 'draft', lines: [] };

  it('returns a draft with its lines, without refreshing anything', async () => {
    ctl.invoice = draft;
    expect(await actions.getInvoiceAction({ id: INVOICE })).toEqual({ ok: true, data: draft });
    expect(ctl.calls).toEqual([{ fn: 'getInvoice', orgId: 'org1', input: INVOICE }]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('says the invoice is gone, and refreshes the list, when it was deleted meanwhile', async () => {
    expect(await actions.getInvoiceAction({ id: INVOICE })).toEqual({ ok: false, error: 'That invoice no longer exists.' });
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('says the invoice was posted, and refreshes the list, when it was posted meanwhile', async () => {
    ctl.invoice = { ...draft, display_status: 'sent' };
    expect(await actions.getInvoiceAction({ id: INVOICE })).toEqual({
      ok: false,
      error: 'This invoice has been posted or voided, so that can no longer be done.',
    });
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('says the invoice is gone for an id that is not an id, without reading', async () => {
    expect(await actions.getInvoiceAction({ id: 'nope' })).toEqual({ ok: false, error: 'That invoice no longer exists.' });
    expect(await actions.getInvoiceAction(undefined)).toEqual({ ok: false, error: 'That invoice no longer exists.' });
    expect(ctl.calls).toEqual([]);
  });

  it('answers with a sentence when the read fails, and logs the cause', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.invoice = new Error('connection reset');
    expect(await actions.getInvoiceAction({ id: INVOICE })).toEqual({ ok: false, error: 'That could not be loaded. Please try again.' });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('a member, who may write but not sign off', () => {
  const NEEDS = { ok: false, error: 'Only an owner or admin can post, pay or void. Ask one of them to do this.' };
  beforeEach(() => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
  });

  it('saves and deletes a draft invoice and records an e-Invois status', async () => {
    expect((await actions.saveInvoiceAction(invoice)).ok).toBe(true);
    expect((await actions.deleteInvoiceAction({ id: INVOICE })).ok).toBe(true);
    expect((await actions.setEInvoiceAction(einvoice)).ok).toBe(true);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveInvoice', 'deleteInvoice', 'setEInvoice']);
  });

  it('is told who can post or void an invoice, or record or void money in, before anything is read or written', async () => {
    expect(await actions.postInvoiceAction({ id: INVOICE })).toEqual(NEEDS);
    expect(await actions.voidInvoiceAction({ id: INVOICE })).toEqual(NEEDS);
    // Money in is posted the moment it is recorded.
    expect(await actions.recordPaymentInAction(payment)).toEqual(NEEDS);
    expect(await actions.voidPaymentInAction({ id: TXN })).toEqual(NEEDS);
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('keeps the draft from "save and post", without trying the post', async () => {
    expect(await actions.saveAndPostInvoiceAction(invoice)).toEqual({
      ok: false,
      error: 'Saved as a draft. Only an owner or admin can post or issue it.',
      draftId: INVOICE,
    });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveInvoice']);
    expect(ctl.revalidated).toEqual(PATHS);
  });
});
