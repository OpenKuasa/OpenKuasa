import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ringgitFields } from '@/lib/finance/document-currency';
import type { PaymentVoucherRow } from '@/lib/finance/cash-book';
import { orderNotesForBills, type OrderBilling } from '@/lib/finance/purchase-views';
import {
  TYPED_PAYEE,
  type VoucherForm,
  type WrittenVoucher,
  hasBillVoucherWaiting,
  newVoucherForm,
  orderNotesByVoucher,
  voucherAccess,
  voucherActions,
  voucherAnswerIsStale,
  voucherCategoryChoices,
  voucherControls,
  voucherDecisionPayload,
  voucherFormError,
  voucherKindLink,
  voucherHiddenNote,
  voucherDetailsLine,
  voucherName,
  voucherPayload,
  voucherQuestion,
  voucherSaveHint,
  voucherSubmitLabel,
  writtenVoucherTitle,
} from '@/lib/finance/voucher-form';
import { VOUCHER_MESSAGES, recordVoucherInput, voucherDecisionInput } from '@/lib/finance/vouchers';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CASH = '22222222-2222-4222-8222-222222222222';
const CATEGORY = '99999999-9999-4999-8999-999999999999';
const CONTACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VOUCHER = '55555555-5555-4555-8555-555555555555';
const TODAY = '2026-10-12';

const accounts = [
  { id: CASH, name: 'Cash in hand', kind: 'cash' as const, bank_name: null, currency: 'MYR' },
  { id: ACCOUNT, name: 'Maybank Current', kind: 'bank' as const, bank_name: 'Maybank', currency: 'MYR' },
];
const categories = [{ id: CATEGORY, name: 'Utilities' }];

const filled: VoucherForm = {
  id: null,
  kind: 'category',
  supplierId: '',
  amounts: {},
  payee: TYPED_PAYEE,
  payeeName: ' Tenaga Nasional ',
  categoryId: CATEGORY,
  amount: '300.50',
  accountId: ACCOUNT,
  date: '2026-10-05',
  method: 'fpx',
  reference: 'ACC 1',
  notes: '',
};

const row = (over: Partial<PaymentVoucherRow> = {}): PaymentVoucherRow => ({
  transaction_id: VOUCHER,
  number: null,
  txn_date: '2026-10-05',
  method: 'fpx',
  amount: 300,
  status: 'pending_approval',
  reference: 'ACC 1',
  notes: null,
  account_id: ACCOUNT,
  account_name: 'Maybank Current',
  account_kind: 'bank',
  contact_id: null,
  party_name: 'Tenaga Nasional',
  kind: 'other',
  category_id: CATEGORY,
  category_name: 'Utilities',
  documents: null,
  approved_at: null,
  ...over,
});

const text = (parts: { text: string }[]) => parts.map((p) => p.text).join('');

describe('the voucher form', () => {
  it('starts from the first bank account, today, with the only category chosen and a typed payee', () => {
    expect(newVoucherForm(accounts, categories, TODAY)).toEqual({
      id: null, kind: 'category', supplierId: '', amounts: {},
      payee: TYPED_PAYEE, payeeName: '', categoryId: CATEGORY, amount: '', accountId: ACCOUNT, date: TODAY,
      method: 'bank_transfer', reference: '', notes: '',
      // Stage 5b: a ringgit account, with no rate.
      fx: ringgitFields(),
    });
    expect(newVoucherForm([], [...categories, { id: CONTACT, name: 'Rent' }], TODAY)).toMatchObject({ categoryId: '', accountId: '' });
  });
  it('sends a typed name or a contact, never both, an amount as a number, and no status', () => {
    expect(voucherPayload(filled)).toEqual({
      account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx', category_id: CATEGORY, amount: 300.5,
      contact_id: null, party_name: ' Tenaga Nasional ', reference: 'ACC 1', notes: '',
    });
    expect(voucherPayload({ ...filled, payee: CONTACT, payeeName: 'left over' })).toMatchObject({ contact_id: CONTACT, party_name: null });
    expect(Number.isNaN(voucherPayload({ ...filled, amount: '1,200.50' }).amount)).toBe(true);
    // What the form sends is what the schema takes.
    expect(recordVoucherInput.parse(voucherPayload(filled))).toMatchObject({ party_name: 'Tenaga Nasional', notes: null, amount: 300.5 });
  });
  it('names the first thing wrong, in the order of the form', () => {
    const M = VOUCHER_MESSAGES;
    expect(voucherFormError(filled)).toBeNull();
    expect(voucherFormError({ ...filled, payee: CONTACT, payeeName: '' })).toBeNull();
    expect(voucherFormError({ ...filled, payeeName: '  ', categoryId: '', amount: '' })).toBe(M.payeeMissing);
    expect(voucherFormError({ ...filled, categoryId: '', amount: '' })).toBe(M.category);
    expect(voucherFormError({ ...filled, amount: '1,200.50' })).toBe(M.amountFormat);
    expect(voucherFormError({ ...filled, amount: 'RM 12' })).toBe(M.amountFormat);
    expect(voucherFormError({ ...filled, amount: '12.345' })).toBe(M.amountDecimals);
    expect(voucherFormError({ ...filled, amount: '' })).toBe(M.amount);
    expect(voucherFormError({ ...filled, amount: '0' })).toBe(M.amount);
    expect(voucherFormError({ ...filled, amount: 'abc' })).toBe(M.amount);
    expect(voucherFormError({ ...filled, accountId: '' })).toBe(M.account);
    expect(voucherFormError({ ...filled, date: '' })).toBe(M.date);
    expect(voucherFormError({ ...filled, notes: 'x'.repeat(201) })).toBe(M.tooLong);
  });
  it('says before the save what saving does for this person', () => {
    expect(voucherSaveHint(true)[0]).toBe(
      'A voucher you save is approved at once and reads To be paid: you are an owner or admin. Nothing is paid until it is marked paid.',
    );
    expect(voucherSaveHint(false)[0]).toBe(
      'This voucher waits as Pending approval until an owner or admin approves or rejects it. Until then it cannot be changed, only deleted.',
    );
    expect(voucherSubmitLabel(true)).toBe('Save voucher');
    expect(voucherSubmitLabel(false)).toBe('Send for approval');
  });
});

describe('what a row offers', () => {
  it('gives approve and reject to an owner or admin on any voucher that waits, and delete on what belongs here and is not paid', () => {
    expect(voucherActions(row(), true)).toEqual(['approve', 'reject', 'delete']);
    expect(voucherActions(row(), false)).toEqual(['delete']);
    expect(voucherActions(row({ kind: 'expense' }), false)).toEqual(['delete']);
    // A draft has Edit and Send for approval too: see finance-voucher-bills-form.test.ts.
    expect(voucherActions(row({ status: 'rejected' }), true)).toEqual(['delete']);
    for (const status of ['scheduled', 'rejected'] as const) {
      expect(voucherActions(row({ status }), false), status).toEqual(['delete']);
    }
    // Mark as paid on one that is To be paid, and Void on a paid one, are an owner's or admin's: see finance-voucher-pay-void-form.test.ts.
    expect(voucherActions(row({ status: 'scheduled' }), true)).toEqual(['markPaid', 'delete']);
    expect(voucherActions(row({ status: 'posted' }), true)).toEqual(['void']);
    expect(voucherActions(row({ status: 'posted' }), false)).toEqual([]);
    expect(voucherActions(row({ status: 'void' }), true)).toEqual([]);
  });
  it('leaves a supplier payment and a refund to their own screens from To be paid onward, and has them before that, where those screens offer nothing', () => {
    for (const kind of ['bill', 'refund'] as const) {
      expect(voucherActions(row({ kind }), true), kind).toEqual(['approve', 'reject', 'delete']);
      expect(voucherActions(row({ kind }), false), kind).toEqual(['delete']);
      expect(voucherActions(row({ kind, status: 'draft' }), true), kind).toEqual(kind === 'bill' ? ['edit', 'submit', 'delete'] : ['delete']);
      expect(voucherActions(row({ kind, status: 'rejected' }), false), kind).toEqual(['delete']);
      for (const status of ['scheduled', 'posted', 'void'] as const) {
        expect(voucherActions(row({ kind, status }), true), `${kind} ${status}`).toEqual([]);
      }
    }
  });
  it('draws one more column for someone who may write', () => {
    expect(voucherControls(true)).toEqual({ newButton: true, actionsColumn: true, columns: 9 });
    expect(voucherControls(false)).toEqual({ newButton: false, actionsColumn: false, columns: 8 });
  });
});

describe('a decision', () => {
  it('sends the row as shown, in the shape the schema takes', () => {
    const payload = voucherDecisionPayload(row());
    expect(payload).toEqual({
      id: VOUCHER, amount: 300, txn_date: '2026-10-05', method: 'fpx', account_id: ACCOUNT, contact_id: null,
      party_name: 'Tenaga Nasional', category_id: CATEGORY, reference: 'ACC 1', notes: null,
    });
    expect(voucherDecisionInput.parse(payload)).toEqual(payload);
  });
  it('sends no typed name for a contact: the row shows the contact’s name, the table holds none', () => {
    const payload = voucherDecisionPayload(row({ kind: 'bill', contact_id: CONTACT, party_name: 'Syarikat Maju', category_id: null }));
    expect(payload).toMatchObject({ contact_id: CONTACT, party_name: null, category_id: null });
    expect(voucherDecisionInput.safeParse(payload).success).toBe(true);
  });
  it('knows which answers mean the row is out of date', () => {
    const M = VOUCHER_MESSAGES;
    for (const stale of [M.changed, M.alreadyApproved, M.alreadyRejected, M.movedOn, M.gone]) expect(voucherAnswerIsStale(stale)).toBe(true);
    for (const kept of [M.needsDecider, M.accountArchivedSince, M.cannotDelete, 'That change could not be saved. Please try again.']) {
      expect(voucherAnswerIsStale(kept)).toBe(false);
    }
  });
});

describe('what the loader reads and gives, by role', () => {
  const waitingBill = [{ kind: 'bill' as const, status: 'pending_approval' as const }];
  const waitingOther = [{ kind: 'other' as const, status: 'pending_approval' as const }];
  const paidBill = [{ kind: 'bill' as const, status: 'posted' as const }];

  it('gives an owner and an admin the form and the decisions, and the orders only while a supplier payment waits', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(voucherAccess({ isDemo: false, role }, waitingBill)).toEqual({ writer: true, canDecide: true, readsForm: true, readsOrders: true });
      expect(voucherAccess({ isDemo: false, role }, waitingOther)).toEqual({ writer: true, canDecide: true, readsForm: true, readsOrders: false });
      expect(voucherAccess({ isDemo: false, role }, paidBill).readsOrders).toBe(false);
    }
  });

  it('gives a member the form but no decision and never reads the orders', () => {
    expect(voucherAccess({ isDemo: false, role: 'member' }, waitingBill)).toEqual({ writer: true, canDecide: false, readsForm: true, readsOrders: false });
  });

  it('gives a viewer nothing', () => {
    expect(voucherAccess({ isDemo: false, role: 'viewer' }, waitingBill)).toEqual({ writer: false, canDecide: false, readsForm: false, readsOrders: false });
  });

  it('gives the demo workspace nothing, whatever its role', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(voucherAccess({ isDemo: true, role }, waitingBill)).toEqual({ writer: false, canDecide: false, readsForm: false, readsOrders: false });
    }
  });
});

describe('the line under an Approve or Reject question', () => {
  it('names the category, the method, the reference and the notes', () => {
    expect(voucherDetailsLine(row({ notes: 'January bill, as agreed' }))).toBe(
      'Category: Utilities · Method: FPX · Reference: ACC 1 · Notes: January bill, as agreed',
    );
  });

  it('leaves out a reference and notes that hold nothing, or only spaces', () => {
    expect(voucherDetailsLine(row({ reference: null, notes: null }))).toBe('Category: Utilities · Method: FPX');
    expect(voucherDetailsLine(row({ reference: '  ', notes: '' }))).toBe('Category: Utilities · Method: FPX');
  });

  it('leaves out the category of a voucher for bills, which has none', () => {
    expect(voucherDetailsLine(row({ kind: 'bill', category_id: null, category_name: null, reference: null }))).toBe('Method: FPX');
  });
});

describe('the link in the Kind cell', () => {
  it('says the voucher is managed on its own screen only from To be paid on', () => {
    for (const status of ['scheduled', 'posted', 'void'] as const) {
      expect(voucherKindLink({ kind: 'bill', status })).toEqual({ label: 'Payments Out', href: '/finance/payments-out', title: 'Managed on Payments Out' });
      expect(voucherKindLink({ kind: 'refund', status })?.title).toBe('Managed on Refunds');
    }
  });

  it('has no such tooltip on a draft, waiting or rejected voucher, whose own menu acts here', () => {
    for (const status of ['draft', 'pending_approval', 'rejected'] as const) {
      expect(voucherKindLink({ kind: 'bill', status })).toEqual({ label: 'Payments Out', href: '/finance/payments-out', title: null });
      expect(voucherKindLink({ kind: 'refund', status })?.title).toBeNull();
    }
  });

  it('is nothing for the kinds that belong on this screen', () => {
    expect(voucherKindLink({ kind: 'expense', status: 'scheduled' })).toBeNull();
    expect(voucherKindLink({ kind: 'other', status: 'pending_approval' })).toBeNull();
  });
});

describe('the questions', () => {
  it('ask before approving, naming the amount, the payee, the date and the account', () => {
    expect(text(voucherQuestion('approve', row()))).toBe(
      'Approve the payment of RM 300.00 to Tenaga Nasional, dated 05 Oct 2026, from Maybank Current? It is then To be paid, exactly as it stands: it cannot be changed after this, only paid or deleted.',
    );
    expect(voucherQuestion('approve', row()).filter((p) => p.strong).map((p) => p.text)).toEqual(['RM 300.00', 'Tenaga Nasional', 'Maybank Current']);
  });
  it('name the documents a voucher pays', () => {
    expect(text(voucherQuestion('approve', row({ kind: 'bill', documents: 'BILL-0007, BILL-0008', party_name: 'Syarikat Maju' })))).toContain(
      'the payment of RM 300.00 to Syarikat Maju for BILL-0007, BILL-0008, dated 05 Oct 2026',
    );
  });
  it('ask before rejecting, and say it is final', () => {
    expect(text(voucherQuestion('reject', row()))).toBe(
      'Reject the payment of RM 300.00 to Tenaga Nasional? It stays in the list as Rejected and cannot be brought back: to pay it after all, record it again.',
    );
  });
  it('ask before deleting, by what the voucher is now', () => {
    expect(text(voucherQuestion('delete', row()))).toBe(
      'Delete the payment of RM 300.00 to Tenaga Nasional that is waiting for approval? Nothing has been paid. This cannot be undone.',
    );
    expect(text(voucherQuestion('delete', row({ status: 'scheduled' })))).toContain('that is still to be paid? Nothing has been paid.');
    expect(text(voucherQuestion('delete', row({ status: 'rejected' })))).toContain('that was rejected?');
    expect(text(voucherQuestion('delete', row({ status: 'draft' })))).toContain('that is a draft?');
    expect(text(voucherQuestion('delete', row({ kind: 'expense', status: 'scheduled' })))).toContain(
      'Nothing has been paid. What it held of its expenses is freed. This cannot be undone.',
    );
    expect(text(voucherQuestion('delete', row({ kind: 'bill', documents: 'BILL-0007' })))).toContain(
      'that is waiting for approval? Nothing has been paid. What it held of its bills is freed. This cannot be undone.',
    );
    // A rejected voucher holds nothing, so nothing is said to be freed.
    expect(text(voucherQuestion('delete', row({ kind: 'bill', status: 'rejected' })))).toContain('that was rejected? Nothing has been paid. This cannot be undone.');
  });
  it('name nobody when the voucher names nobody', () => {
    expect(voucherName(row({ party_name: null }))).toBe('the payment of RM 300.00');
    expect(voucherName(row())).toBe('the payment of RM 300.00 to Tenaga Nasional');
    expect(text(voucherQuestion('reject', row({ party_name: null })))).toMatch(/^Reject the payment of RM 300\.00\? /);
  });
});

describe('the over-billing note at Approve', () => {
  const order = (over: Partial<OrderBilling>): OrderBilling => ({
    id: 'po-1', po_no: 'PO-0007', total: 10000, billed_total: 12400, received_total: 10000, over_billed: true, billed_over_received: false, currency: 'MYR', ...over,
  });
  const bills = [
    { id: 'b1', bill_no: 'BILL-0007', purchase_order_id: 'po-1' },
    { id: 'b2', bill_no: 'BILL-0008', purchase_order_id: 'po-1' },
    { id: 'b3', bill_no: 'BILL-0009', purchase_order_id: null },
    { id: 'b4', bill_no: 'BILL-0010', purchase_order_id: 'po-2' },
  ];
  const orders = [order({}), order({ id: 'po-2', po_no: 'PO-0008', over_billed: false })];
  const payments = [
    { transaction_id: 'v1', bill_id: 'b1', status: 'pending_approval' as const },
    { transaction_id: 'v1', bill_id: 'b2', status: 'pending_approval' as const },
    { transaction_id: 'v2', bill_id: 'b3', status: 'pending_approval' as const },
    { transaction_id: 'v3', bill_id: 'b4', status: 'pending_approval' as const },
    // Not waiting: Payments Out advises on these when they are marked paid.
    { transaction_id: 'v4', bill_id: 'b1', status: 'scheduled' as const },
    { transaction_id: 'v5', bill_id: 'b1', status: 'posted' as const },
  ];
  it('is the very sentences Payments Out shows, for each waiting voucher whose bills are against a flagged order', () => {
    const notes = orderNotesByVoucher(payments, bills, orders);
    expect(Object.keys(notes)).toEqual(['v1']);
    expect(notes.v1).toEqual(orderNotesForBills([bills[0], bills[1]], orders));
    expect(notes.v1).toEqual(['BILL-0007 and 1 more are against PO-0007, whose bills come to RM 12,400.00, over its total of RM 10,000.00.']);
  });
  it('says nothing with no orders, no bills or no waiting voucher', () => {
    expect(orderNotesByVoucher(payments, bills, [])).toEqual({});
    expect(orderNotesByVoucher(payments, [], orders)).toEqual({});
    expect(orderNotesByVoucher([], bills, orders)).toEqual({});
  });
  it('reads bills and orders only while a supplier payment waits', () => {
    expect(hasBillVoucherWaiting([row()])).toBe(false);
    expect(hasBillVoucherWaiting([row({ kind: 'bill', status: 'scheduled' })])).toBe(false);
    expect(hasBillVoucherWaiting([row(), row({ kind: 'bill' })])).toBe(true);
  });
});

describe('after a write', () => {
  const written = (over: Partial<WrittenVoucher> = {}): WrittenVoucher => ({
    id: VOUCHER, status: 'pending_approval', recorded: true, payee: 'Tenaga Nasional', amount: 300, date: '2026-10-05', ...over,
  });
  const WHAT = 'The payment of RM 300.00 to Tenaga Nasional, dated 05 Oct 2026,';
  it('titles the note by what happened', () => {
    expect(writtenVoucherTitle(written())).toBe('Voucher sent for approval');
    expect(writtenVoucherTitle(written({ status: 'scheduled' }))).toBe('Voucher saved');
    expect(writtenVoucherTitle(written({ status: 'scheduled', recorded: false }))).toBe('Voucher approved');
    expect(writtenVoucherTitle(written({ status: 'rejected', recorded: false }))).toBe('Voucher rejected');
    expect(writtenVoucherTitle(written({ status: null }))).toBe('Voucher saved');
  });
  it('says nothing while the voucher is on screen', () => {
    expect(voucherHiddenNote(written(), TODAY, 'month', 'open', true, true)).toBeNull();
  });
  it('points at View all when only the ten-row limit hides it', () => {
    expect(voucherHiddenNote(written(), TODAY, 'month', 'open', true, false)).toBe(`${WHAT} was sent and waits for approval. Choose View all to see it.`);
  });
  it('points at the search and the filters for a voucher that waits or is To be paid', () => {
    expect(voucherHiddenNote(written(), TODAY, 'month', 'posted', false, false)).toBe(
      `${WHAT} was sent and waits for approval. Clear the search and the filters to see it.`,
    );
    expect(voucherHiddenNote(written({ status: 'scheduled' }), TODAY, 'month', 'waiting', false, false)).toBe(
      `${WHAT} was saved and is To be paid. Clear the search and the filters to see it.`,
    );
    expect(voucherHiddenNote(written({ status: 'scheduled', recorded: false }), TODAY, 'month', 'waiting', false, false)).toBe(
      `${WHAT} was approved and is To be paid. Clear the search and the filters to see it.`,
    );
    expect(voucherHiddenNote(written({ status: null, payee: null }), TODAY, 'month', 'void', false, false)).toBe(
      'The payment of RM 300.00, dated 05 Oct 2026, was saved. Clear the search and the filters to see it.',
    );
  });
  it('says exactly what hides a rejected voucher: the status filter, the period, both, or neither', () => {
    const rejected = written({ status: 'rejected', recorded: false });
    expect(voucherHiddenNote(rejected, TODAY, 'month', 'open', false, false)).toBe(`${WHAT} was rejected. Choose Rejected in the status filter to see it.`);
    const old = { ...rejected, date: '2026-08-05' };
    const OLD = 'The payment of RM 300.00 to Tenaga Nasional, dated 05 Aug 2026,';
    expect(voucherHiddenNote(old, TODAY, 'month', 'open', false, false)).toBe(
      `${OLD} was rejected. Choose Rejected in the status filter and a longer period to see it.`,
    );
    expect(voucherHiddenNote(old, TODAY, 'month', 'rejected', false, false)).toBe(`${OLD} was rejected. Choose a longer period to see it.`);
    expect(voucherHiddenNote(old, TODAY, 'all', 'open', false, false)).toBe(`${OLD} was rejected. Choose Rejected in the status filter to see it.`);
    expect(voucherHiddenNote(rejected, TODAY, 'month', 'rejected', false, false)).toBe(`${WHAT} was rejected. Clear the search and the Kind filter to see it.`);
  });
});

describe('the expense categories a voucher form offers', () => {
  const ARCHIVED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('offers a new voucher the active categories only', () => {
    expect(voucherCategoryChoices(categories, null)).toEqual(categories);
  });

  it('keeps a draft’s own category in the box when it was archived since, marked as archived, and offers it first', () => {
    const choices = voucherCategoryChoices(categories, row({ category_id: ARCHIVED, category_name: 'Old fuel' }));
    expect(choices).toEqual([{ id: ARCHIVED, name: 'Old fuel (archived)' }, ...categories]);
  });

  it('says "Archived category" when the draft’s row has no name for it', () => {
    expect(voucherCategoryChoices(categories, row({ category_id: ARCHIVED, category_name: null }))[0]).toEqual({
      id: ARCHIVED,
      name: 'Archived category',
    });
  });

  it('is what the screen hands the form, for the draft being edited', () => {
    const view = readFileSync('src/components/finance/payment-vouchers-view.tsx', 'utf8');
    expect(view).toContain('categories={voucherCategoryChoices(writer.categories, open.draft ?? null)}');
  });

  it('adds nothing for a draft whose category is still active, or that has none (a draft for bills)', () => {
    expect(voucherCategoryChoices(categories, row())).toBe(categories);
    expect(voucherCategoryChoices(categories, row({ category_id: null, category_name: null }))).toBe(categories);
  });
});
