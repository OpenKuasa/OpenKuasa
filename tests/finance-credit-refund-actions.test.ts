import { beforeEach, describe, expect, it, vi } from 'vitest';

const NOTE = '33333333-3333-4333-8333-333333333333';
const INVOICE = '55555555-5555-4555-8555-555555555555';
const TXN = '66666666-6666-4666-8666-666666666666';
const ACCOUNT = '77777777-7777-4777-8777-777777777777';

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

vi.mock('@/lib/finance/credit-notes', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/credit-notes')>();
  return {
    ...actual,
    saveCreditNote: recorder('saveCreditNote', { id: '33333333-3333-4333-8333-333333333333' }),
    issueCreditNote: recorder('issueCreditNote', { id: '33333333-3333-4333-8333-333333333333', credit_note_no: 'CN-0007' }),
    voidCreditNote: recorder('voidCreditNote', { id: '33333333-3333-4333-8333-333333333333' }),
    deleteCreditNote: recorder('deleteCreditNote', { id: '33333333-3333-4333-8333-333333333333' }),
  };
});

vi.mock('@/lib/finance/refunds', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/refunds')>();
  return {
    ...actual,
    recordRefund: recorder('recordRefund', { id: '66666666-6666-4666-8666-666666666666' }),
    markRefundPaid: recorder('markRefundPaid', { id: '66666666-6666-4666-8666-666666666666', number: 'PV-0004' }),
    voidRefund: recorder('voidRefund', { id: '66666666-6666-4666-8666-666666666666' }),
    deleteRefund: recorder('deleteRefund', { id: '66666666-6666-4666-8666-666666666666' }),
  };
});

const actions = await import('@/app/(app)/finance/actions');

/** Credit Notes alone: a draft credit note takes nothing off its invoice. */
const DRAFTS = ['/finance/credit-notes'];
/**
 * The five screens where a figure moves when an invoice's balance or a customer's credit does, and Payment
 * Vouchers, which lists every refund as the money out it is.
 */
const CREDIT = [
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/customers-suppliers',
  '/finance/credit-notes',
  '/finance/refunds',
  '/finance/payment-vouchers',
];
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const NOTE_LOCKED =
  'That cannot be done to this credit note as it now stands. It may have been issued or voided since this page was loaded.';
const REFUND_LOCKED =
  'That cannot be done to this refund as it now stands. It may have been paid out or voided since this page was loaded.';

const note = { invoice_id: INVOICE, credit_date: '2026-10-06', reason: 'returns', amount: 30 };
const refund = {
  invoice_id: INVOICE,
  account_id: ACCOUNT,
  txn_date: '2026-10-07',
  method: 'bank_transfer',
  reason: 'overpayment',
  amount: 30,
};

/** Every write action with an input its schema accepts, the data-layer function it must call, and the screens it refreshes. */
const writes: [string, (input: unknown) => Promise<Answer>, unknown, string, string[]][] = [
  ['saveCreditNoteAction', actions.saveCreditNoteAction, note, 'saveCreditNote', DRAFTS],
  ['issueCreditNoteAction', actions.issueCreditNoteAction, { id: NOTE }, 'issueCreditNote', CREDIT],
  ['voidCreditNoteAction', actions.voidCreditNoteAction, { id: NOTE }, 'voidCreditNote', CREDIT],
  ['deleteCreditNoteAction', actions.deleteCreditNoteAction, { id: NOTE }, 'deleteCreditNote', DRAFTS],
  ['recordRefundAction', actions.recordRefundAction, refund, 'recordRefund', CREDIT],
  ['markRefundPaidAction', actions.markRefundPaidAction, { id: TXN, paid_on: '2026-10-09' }, 'markRefundPaid', CREDIT],
  ['voidRefundAction', actions.voidRefundAction, { id: TXN }, 'voidRefund', CREDIT],
  ['deleteRefundAction', actions.deleteRefundAction, { id: TXN }, 'deleteRefund', CREDIT],
];

beforeEach(() => {
  // An admin: posting, paying and voiding need an owner or admin. What a member may do is at the end.
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'admin', isDemo: false };
  ctl.calls = [];
  ctl.revalidated = [];
  ctl.answers = {};
});

describe('who may write', () => {
  it('refuses a viewer and the demo workspace on every action, before anything is parsed, read or written', async () => {
    for (const viewer of [
      { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false },
      { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      for (const [name, action, input] of writes) expect(await action(input), name).toEqual(FORBIDDEN);
      expect(await actions.saveAndIssueCreditNoteAction(note)).toEqual(FORBIDDEN);
      // Not even a malformed input gets a schema's sentence: the refusal comes first.
      expect(await actions.saveCreditNoteAction({ amount: 'lots' })).toEqual(FORBIDDEN);
      expect(await actions.recordRefundAction(null)).toEqual(FORBIDDEN);
      expect(await actions.markRefundPaidAction({ id: 'nope' })).toEqual(FORBIDDEN);
      expect(await actions.saveAndIssueCreditNoteAction({ amount: 'lots' })).toEqual(FORBIDDEN);
      expect(await actions.issueCreditNoteAction({ id: 'nope' })).toEqual(FORBIDDEN);
      expect(await actions.voidCreditNoteAction(null)).toEqual(FORBIDDEN);
      expect(await actions.deleteCreditNoteAction({ id: 'nope' })).toEqual(FORBIDDEN);
      expect(await actions.voidRefundAction({ id: 'nope' })).toEqual(FORBIDDEN);
      expect(await actions.deleteRefundAction(null)).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('tells a viewer they may not, not that the credit note or the refund is gone', async () => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false };
    // The database would answer a viewer's update or delete with no row, and the issue function with FIN11;
    // the refund writes read a view first. All of it would read "no longer exists".
    for (const fn of ['issueCreditNote', 'voidCreditNote', 'deleteCreditNote']) {
      ctl.answers[fn] = { ok: false, error: 'That credit note no longer exists.' };
    }
    for (const fn of ['markRefundPaid', 'voidRefund', 'deleteRefund']) {
      ctl.answers[fn] = { ok: false, error: 'That refund no longer exists.' };
    }
    expect(await actions.issueCreditNoteAction({ id: NOTE })).toEqual(FORBIDDEN);
    expect(await actions.voidCreditNoteAction({ id: NOTE })).toEqual(FORBIDDEN);
    expect(await actions.deleteCreditNoteAction({ id: NOTE })).toEqual(FORBIDDEN);
    expect(await actions.markRefundPaidAction({ id: TXN, paid_on: '2026-10-09' })).toEqual(FORBIDDEN);
    expect(await actions.voidRefundAction({ id: TXN })).toEqual(FORBIDDEN);
    expect(await actions.deleteRefundAction({ id: TXN })).toEqual(FORBIDDEN);
    expect(ctl.calls).toEqual([]);
  });
});

describe('each write action', () => {
  it('calls its own data-layer function in the viewer’s workspace and refreshes the screens it moves', async () => {
    for (const [name, action, input, fn, paths] of writes) {
      ctl.calls = [];
      ctl.revalidated = [];
      expect((await action(input)).ok, name).toBe(true);
      expect(ctl.calls.map((c) => [c.fn, c.orgId]), name).toEqual([[fn, 'org1']]);
      expect(ctl.revalidated, name).toEqual(paths);
    }
  });

  it('never refreshes Payments Out or Quotations: a refund is not on the first, and neither names a credit note', async () => {
    for (const [name, action, input] of writes) {
      ctl.revalidated = [];
      await action(input);
      expect(ctl.revalidated, name).not.toContain('/finance/payments-out');
      expect(ctl.revalidated, name).not.toContain('/finance/supplier-bills');
      expect(ctl.revalidated, name).not.toContain('/finance/quotations');
    }
  });

  it('refreshes Credit Notes alone for a draft, and the five screens once an invoice’s balance can move', async () => {
    for (const [name, action, input, fn] of writes) {
      ctl.revalidated = [];
      await action(input);
      const draftOnly = fn === 'saveCreditNote' || fn === 'deleteCreditNote';
      expect(ctl.revalidated.includes('/finance/invoices'), name).toBe(!draftOnly);
      expect(ctl.revalidated, name).toContain('/finance/credit-notes');
    }
  });

  it('never takes the workspace from the input', async () => {
    await actions.saveCreditNoteAction({ ...note, org_id: 'someone-else' });
    await actions.recordRefundAction({ ...refund, org_id: 'someone-else', target_org: 'someone-else' });
    await actions.voidRefundAction({ id: TXN, org_id: 'someone-else' });
    expect(ctl.calls.map((c) => c.orgId)).toEqual(['org1', 'org1', 'org1']);
    expect(JSON.stringify(ctl.calls)).not.toContain('someone-else');
  });

  it('answers with the schema’s sentence, touching nothing, when the input is refused', async () => {
    expect(await actions.saveCreditNoteAction({ ...note, invoice_id: '' })).toEqual({
      ok: false,
      error: 'Choose the invoice this credit note is against.',
    });
    expect(await actions.saveCreditNoteAction({ ...note, reason: '' })).toEqual({ ok: false, error: 'Choose a reason.' });
    expect(await actions.saveCreditNoteAction({ ...note, amount: Number.NaN })).toEqual({ ok: false, error: 'Enter an amount above 0.' });
    expect(await actions.recordRefundAction({ ...refund, invoice_id: null })).toEqual({
      ok: false,
      error: 'Choose the invoice or the credit note this refund is for.',
    });
    expect(await actions.recordRefundAction({ ...refund, credit_note_id: NOTE })).toEqual({
      ok: false,
      error: 'Choose the invoice or the credit note this refund is for.',
    });
    expect(await actions.recordRefundAction({ ...refund, account_id: '' })).toEqual({
      ok: false,
      error: 'Choose the account the money leaves.',
    });
    expect(await actions.markRefundPaidAction({ id: TXN, paid_on: '2026-02-30' })).toEqual({ ok: false, error: 'Enter a valid date.' });
    for (const action of [actions.issueCreditNoteAction, actions.voidCreditNoteAction, actions.deleteCreditNoteAction]) {
      expect(await action({ id: 'nope' })).toEqual({ ok: false, error: 'That credit note no longer exists.' });
      expect(await action(null)).toMatchObject({ ok: false });
    }
    for (const action of [actions.voidRefundAction, actions.deleteRefundAction]) {
      expect(await action({ id: 'nope' })).toEqual({ ok: false, error: 'That payment no longer exists.' });
      expect(await action(null)).toMatchObject({ ok: false });
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('hands the data layer the parsed input: text trimmed, empties as null, amounts to the sen', async () => {
    await actions.saveCreditNoteAction({ ...note, amount: 30.005, notes: '  ' });
    expect(ctl.calls[0].input).toEqual({ ...note, amount: 30.01, notes: null });
    await actions.recordRefundAction({ ...refund, invoice_id: '', credit_note_id: NOTE, reference: ' TT 88 ', scheduled: true });
    expect(ctl.calls[1].input).toEqual({
      ...refund,
      invoice_id: null,
      credit_note_id: NOTE,
      reference: 'TT 88',
      notes: null,
      scheduled: true,
    });
  });

  it('refreshes the screens after a refusal too, so what someone else changed shows as it now is', async () => {
    // Issued in another tab while this one still offered Issue.
    ctl.answers.issueCreditNote = { ok: false, error: NOTE_LOCKED };
    expect(await actions.issueCreditNoteAction({ id: NOTE })).toEqual(ctl.answers.issueCreditNote);
    expect(ctl.revalidated).toEqual(CREDIT);

    // A refund was recorded against it in another tab: voiding it here is refused, and the screens show the refund.
    ctl.revalidated = [];
    ctl.answers.voidCreditNote = {
      ok: false,
      error: 'A refund depends on this credit note. Void or delete that refund on Refunds before voiding it.',
    };
    expect(await actions.voidCreditNoteAction({ id: NOTE })).toEqual(ctl.answers.voidCreditNote);
    expect(ctl.revalidated).toEqual(CREDIT);

    // Paid out in another tab while this one still offered Delete.
    ctl.revalidated = [];
    ctl.answers.deleteRefund = { ok: false, error: REFUND_LOCKED };
    expect(await actions.deleteRefundAction({ id: TXN })).toEqual(ctl.answers.deleteRefund);
    expect(ctl.revalidated).toEqual(CREDIT);

    // The credit went while the form was open.
    ctl.revalidated = [];
    ctl.answers.recordRefund = {
      ok: false,
      error: 'That is more than the customer is in credit, or more than is left of the credit note.',
    };
    expect(await actions.recordRefundAction(refund)).toEqual(ctl.answers.recordRefund);
    expect(ctl.revalidated).toEqual(CREDIT);
  });
});

describe('saveAndIssueCreditNoteAction', () => {
  it('saves, then issues what it saved, answers with the number, and refreshes the five screens', async () => {
    expect(await actions.saveAndIssueCreditNoteAction(note)).toEqual({ ok: true, data: { id: NOTE, credit_note_no: 'CN-0007' } });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveCreditNote', 'issueCreditNote']);
    expect(ctl.calls[1].input).toEqual({ id: NOTE });
    expect(ctl.revalidated).toEqual(CREDIT);
  });

  it('does not issue when the save is refused', async () => {
    ctl.answers.saveCreditNote = { ok: false, error: 'That is more than this invoice has left to credit.' };
    expect(await actions.saveAndIssueCreditNoteAction(note)).toEqual(ctl.answers.saveCreditNote);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveCreditNote']);
    expect(ctl.revalidated).toEqual(CREDIT);
  });

  it('keeps the draft when issuing is refused, and says which draft it is', async () => {
    // Another credit note for the same invoice was issued between the save and the issue.
    ctl.answers.issueCreditNote = { ok: false, error: 'That is more than this invoice has left to credit.' };
    expect(await actions.saveAndIssueCreditNoteAction(note)).toEqual({
      ok: false,
      error: 'That is more than this invoice has left to credit.',
      draftId: NOTE,
    });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveCreditNote', 'issueCreditNote']);
    expect(ctl.revalidated).toEqual(CREDIT);
  });

  it('answers with the schema’s sentence and saves nothing when the form is refused', async () => {
    expect(await actions.saveAndIssueCreditNoteAction({ ...note, reason: 'because' })).toEqual({ ok: false, error: 'Choose a reason.' });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('a member, who may write but not sign off', () => {
  const NEEDS = { ok: false, error: 'Only an owner or admin can post, pay or void. Ask one of them to do this.' };
  beforeEach(() => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
  });

  it('saves and deletes a draft credit note, and records or deletes a pending refund', async () => {
    expect((await actions.saveCreditNoteAction(note)).ok).toBe(true);
    expect((await actions.deleteCreditNoteAction({ id: NOTE })).ok).toBe(true);
    expect((await actions.recordRefundAction({ ...refund, scheduled: true })).ok).toBe(true);
    expect((await actions.deleteRefundAction({ id: TXN })).ok).toBe(true);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveCreditNote', 'deleteCreditNote', 'recordRefund', 'deleteRefund']);
  });

  it('is told who can issue, pay out or void, before anything is read or written', async () => {
    expect(await actions.issueCreditNoteAction({ id: NOTE })).toEqual(NEEDS);
    expect(await actions.voidCreditNoteAction({ id: NOTE })).toEqual(NEEDS);
    expect(await actions.markRefundPaidAction({ id: TXN, paid_on: '2026-10-09' })).toEqual(NEEDS);
    expect(await actions.voidRefundAction({ id: TXN })).toEqual(NEEDS);
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('cannot record a refund as paid now, and is told to leave it pending', async () => {
    expect(await actions.recordRefundAction(refund)).toEqual({
      ok: false,
      error: 'Only an owner or admin can record this as paid. Save it as scheduled or pending instead.',
    });
    expect(ctl.calls).toEqual([]);
  });

  it('keeps the draft from "save and issue", without trying to issue it', async () => {
    expect(await actions.saveAndIssueCreditNoteAction(note)).toEqual({
      ok: false,
      error: 'Saved as a draft. Only an owner or admin can post or issue it.',
      draftId: NOTE,
    });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveCreditNote']);
    expect(ctl.revalidated).toEqual(CREDIT);
  });
});
