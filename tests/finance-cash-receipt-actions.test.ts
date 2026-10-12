import { beforeEach, describe, expect, it, vi } from 'vitest';

const TXN = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';
const INVOICE = '33333333-3333-4333-8333-333333333333';
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

vi.mock('@/lib/finance/cash-receipts', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/cash-receipts')>();
  return {
    ...actual,
    saveCashReceipt: recorder('saveCashReceipt', { id: '55555555-5555-4555-8555-555555555555' }),
    postCashReceipt: recorder('postCashReceipt', { id: '55555555-5555-4555-8555-555555555555', number: 'RC-0007' }),
    voidCashReceipt: recorder('voidCashReceipt', { id: '55555555-5555-4555-8555-555555555555' }),
    deleteCashReceipt: recorder('deleteCashReceipt', { id: '55555555-5555-4555-8555-555555555555' }),
  };
});

const actions = await import('@/app/(app)/finance/actions');

// A receipt can be for invoices, so every receipt action refreshes what an invoice or a payment in refreshes.
const PATHS = [
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/customers-suppliers',
  '/finance/quotations',
  '/finance/credit-notes',
  '/finance/refunds',
  '/finance/cash-receipts',
  '/finance/banking',
];
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const NEEDS = { ok: false, error: 'Only an owner or admin can post, pay or void. Ask one of them to do this.' };

const income = {
  kind: 'income',
  account_id: ACCOUNT,
  txn_date: '2026-10-05',
  method: 'cash',
  category_id: CATEGORY,
  amount: 50,
  party_name: 'Walk-in',
};
const forInvoices = {
  kind: 'invoice',
  account_id: ACCOUNT,
  txn_date: '2026-10-05',
  method: 'fpx',
  allocations: [{ invoice_id: INVOICE, amount: 100 }],
};

/** Every write action with an input its schema accepts, and the data-layer function it must call. */
const writes: [string, (input: unknown) => Promise<Answer>, unknown, string][] = [
  ['saveCashReceiptAction (income)', actions.saveCashReceiptAction, income, 'saveCashReceipt'],
  ['saveCashReceiptAction (invoices)', actions.saveCashReceiptAction, forInvoices, 'saveCashReceipt'],
  ['postCashReceiptAction', actions.postCashReceiptAction, { id: TXN }, 'postCashReceipt'],
  ['voidCashReceiptAction', actions.voidCashReceiptAction, { id: TXN }, 'voidCashReceipt'],
  ['deleteCashReceiptAction', actions.deleteCashReceiptAction, { id: TXN }, 'deleteCashReceipt'],
];

beforeEach(() => {
  // An admin: posting and voiding need an owner or admin. What a member may do is at the end.
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
      expect(await actions.saveAndPostCashReceiptAction(income)).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('tells a viewer they may not, not that the receipt is gone', async () => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false };
    // The database would answer a viewer's void or delete with "no row", which reads as "no longer exists".
    ctl.answers.voidCashReceipt = { ok: false, error: 'That receipt no longer exists.' };
    ctl.answers.deleteCashReceipt = { ok: false, error: 'That receipt no longer exists.' };
    expect(await actions.voidCashReceiptAction({ id: TXN })).toEqual(FORBIDDEN);
    expect(await actions.deleteCashReceiptAction({ id: TXN })).toEqual(FORBIDDEN);
    expect(ctl.calls).toEqual([]);
  });
});

describe('each write action, for an owner or admin', () => {
  it('calls its own data-layer function in the viewer’s workspace and refreshes the sales screens, Cash Receipts and Banking', async () => {
    for (const role of ['owner', 'admin']) {
      ctl.viewer = { userId: 'u1', orgId: 'org1', role, isDemo: false };
      for (const [name, action, input, fn] of writes) {
        ctl.calls = [];
        ctl.revalidated = [];
        expect((await action(input)).ok, name).toBe(true);
        expect(ctl.calls.map((c) => [c.fn, c.orgId]), name).toEqual([[fn, 'org1']]);
        expect(ctl.revalidated, name).toEqual(PATHS);
      }
    }
  });

  it('never takes the workspace, a status or a number from the input', async () => {
    await actions.saveCashReceiptAction({ ...income, org_id: 'someone-else', status: 'posted', number: 'RC-9999' });
    await actions.postCashReceiptAction({ id: TXN, org_id: 'someone-else' });
    expect(ctl.calls.map((c) => c.orgId)).toEqual(['org1', 'org1']);
    expect(JSON.stringify(ctl.calls)).not.toContain('someone-else');
    expect(JSON.stringify(ctl.calls)).not.toContain('RC-9999');
    expect(ctl.calls[0].input).not.toHaveProperty('status');
  });

  it('hands the data layer the parsed input: text trimmed, empties as null, the amount to the sen', async () => {
    await actions.saveCashReceiptAction({ ...income, amount: 32.506, party_name: ' Walk-in ', reference: ' ' });
    expect(ctl.calls[0].input).toEqual({
      kind: 'income', account_id: ACCOUNT, txn_date: '2026-10-05', method: 'cash', reference: null, notes: null,
      category_id: CATEGORY, amount: 32.51, contact_id: null, party_name: 'Walk-in',
    });
  });

  it('answers with the schema’s sentence, touching nothing, when the input is refused', async () => {
    expect(await actions.saveCashReceiptAction({ ...income, category_id: '' })).toEqual({ ok: false, error: 'Choose an income category.' });
    expect(await actions.saveCashReceiptAction({ ...forInvoices, allocations: [] })).toEqual({
      ok: false,
      error: 'Choose at least one invoice this receipt is for.',
    });
    expect(await actions.saveCashReceiptAction({ ...income, kind: 'both' })).toEqual({
      ok: false,
      error: 'Choose what this receipt is for: a customer’s invoices, or other income.',
    });
    expect(await actions.postCashReceiptAction({ id: 'nope' })).toEqual({ ok: false, error: 'That receipt no longer exists.' });
    expect(await actions.voidCashReceiptAction(null)).toEqual({ ok: false, error: 'That receipt no longer exists.' });
    expect(await actions.deleteCashReceiptAction(undefined)).toEqual({ ok: false, error: 'That receipt no longer exists.' });
    expect(await actions.postCashReceiptAction(null)).toEqual({ ok: false, error: 'That receipt no longer exists.' });
    expect(await actions.saveCashReceiptAction({ ...forInvoices, allocations: [null] })).toEqual({
      ok: false,
      error: 'Choose at least one invoice this receipt is for.',
    });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('refreshes the screens after a refusal too, so a receipt someone else changed shows as it now is', async () => {
    // The draft was posted in another tab while this one still had it open.
    ctl.answers.saveCashReceipt = { ok: false, error: 'This receipt has been posted or voided, so that can no longer be done.' };
    expect(await actions.saveCashReceiptAction({ ...income, id: TXN })).toEqual(ctl.answers.saveCashReceipt);
    expect(ctl.revalidated).toEqual(PATHS);
  });
});

describe('saveAndPostCashReceiptAction', () => {
  it('saves, then posts what it saved, and answers with the number', async () => {
    expect(await actions.saveAndPostCashReceiptAction(income)).toEqual({ ok: true, data: { id: TXN, number: 'RC-0007' } });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveCashReceipt', 'postCashReceipt']);
    expect(ctl.calls[1].input).toEqual({ id: TXN });
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('does not post when the save is refused', async () => {
    ctl.answers.saveCashReceipt = { ok: false, error: 'A receipt can only go against a posted invoice.' };
    expect(await actions.saveAndPostCashReceiptAction(forInvoices)).toEqual(ctl.answers.saveCashReceipt);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveCashReceipt']);
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('keeps the draft when the post is refused, and says which draft it is', async () => {
    ctl.answers.postCashReceipt = { ok: false, error: 'That change could not be saved. Please try again.' };
    expect(await actions.saveAndPostCashReceiptAction(income)).toEqual({
      ok: false,
      error: 'That change could not be saved. Please try again.',
      draftId: TXN,
    });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveCashReceipt', 'postCashReceipt']);
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('answers with the schema’s sentence and saves nothing when the form is refused', async () => {
    expect(await actions.saveAndPostCashReceiptAction({ ...income, amount: 0 })).toEqual({ ok: false, error: 'Enter an amount above 0.' });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('a member, who may write but not sign off', () => {
  beforeEach(() => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
  });

  it('saves, changes and deletes a draft receipt of either kind', async () => {
    expect((await actions.saveCashReceiptAction(income)).ok).toBe(true);
    expect((await actions.saveCashReceiptAction({ ...forInvoices, id: TXN })).ok).toBe(true);
    expect((await actions.deleteCashReceiptAction({ id: TXN })).ok).toBe(true);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveCashReceipt', 'saveCashReceipt', 'deleteCashReceipt']);
  });

  it('is told who can post or void a receipt, before anything is read or written', async () => {
    expect(await actions.postCashReceiptAction({ id: TXN })).toEqual(NEEDS);
    expect(await actions.voidCashReceiptAction({ id: TXN })).toEqual(NEEDS);
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('keeps the draft from "save and post", without trying the post', async () => {
    expect(await actions.saveAndPostCashReceiptAction(income)).toEqual({
      ok: false,
      error: 'Saved as a draft. Only an owner or admin can post or issue it.',
      draftId: TXN,
    });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveCashReceipt']);
    expect(ctl.revalidated).toEqual(PATHS);
  });
});
