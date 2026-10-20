import { describe, expect, it } from 'vitest';
import type { BillListRow } from '@/lib/finance/bills';
import type { PaymentVoucherRow } from '@/lib/finance/cash-book';
import type { PaymentOutRow } from '@/lib/finance/money';
import {
  BILLS_HINT,
  DRAFT_HINT,
  TYPED_PAYEE,
  type WrittenVoucher,
  chooseVoucherKind,
  chooseVoucherSupplier,
  draftVoucherForm,
  keepVoucherBills,
  newVoucherForm,
  voucherActions,
  voucherAnswerIsStale,
  voucherBillOwed,
  voucherDraftLabel,
  voucherFirstWrite,
  voucherFormError,
  voucherHiddenNote,
  voucherKindLink,
  voucherPayableBills,
  voucherQuestion,
  voucherSaveHint,
  voucherSavePayload,
  voucherSubmitLabel,
  voucherTotal,
  writtenVoucherTitle,
} from '@/lib/finance/voucher-form';
import { VOUCHER_MESSAGES as M, saveVoucherInput } from '@/lib/finance/vouchers';
import { ringgitBill } from './helpers/bill-rows';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CATEGORY = '99999999-9999-4999-8999-999999999999';
const MAJU = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JAYA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VOUCHER = '55555555-5555-4555-8555-555555555555';
const BILL_A = 'b1111111-1111-4111-8111-111111111111';
const BILL_B = 'b2222222-2222-4222-8222-222222222222';
const BILL_J = 'b3333333-3333-4333-8333-333333333333';
const TODAY = '2026-10-12';

const accounts = [{ id: ACCOUNT, name: 'Maybank Current', kind: 'bank' as const, bank_name: 'Maybank', currency: 'MYR' }];
const categories = [{ id: CATEGORY, name: 'Utilities' }];
const bill = (id: string, no: string, supplier: string, name: string, balance: number): BillListRow => ringgitBill({
  id, bill_no: no, supplier_id: supplier, supplier_name: name, bill_date: '2026-10-01', due_date: '2026-10-31', total: balance, paid: 0, balance,
  display_status: 'pending', purchase_order_id: null, purchase_order_no: null, category_id: null, category_name: null,
});
const bills = [bill(BILL_A, 'BILL-0007', MAJU, 'Syarikat Maju', 132.5), bill(BILL_B, 'BILL-0008', MAJU, 'Syarikat Maju', 500), bill(BILL_J, 'BILL-0009', JAYA, 'Jaya Enterprise', 80)];
const held = (transaction: string, billId: string, amount: number, status: PaymentOutRow['status']): PaymentOutRow => ({
  allocation_id: `${transaction}-${billId}`, transaction_id: transaction, number: null, txn_date: '2026-10-05', method: 'fpx', amount,
  transaction_amount: amount, status, reference: null, account_id: ACCOUNT, account_name: 'Maybank Current', bill_id: billId, bill_no: null, supplier_name: '',
});
/** The draft being edited holds RM 100 of bill A and RM 50 of bill B; someone else's waiting voucher holds RM 200 of bill B. */
const payments = [held(VOUCHER, BILL_A, 100, 'draft'), held(VOUCHER, BILL_B, 50, 'draft'), held('other', BILL_B, 200, 'pending_approval')];
const row = (over: Partial<PaymentVoucherRow> = {}): PaymentVoucherRow => ({
  transaction_id: VOUCHER, number: null, txn_date: '2026-10-05', method: 'cheque', amount: 150, status: 'draft', reference: null, notes: 'October',
  account_id: ACCOUNT, account_name: 'Maybank Current', account_kind: 'bank', contact_id: MAJU, party_name: 'Syarikat Maju', kind: 'bill',
  category_id: null, category_name: null, documents: 'BILL-0007, BILL-0008', approved_at: null, ...over,
});
const text = (parts: { text: string }[]) => parts.map((p) => p.text).join('');

describe('the bills a voucher can pay', () => {
  it('are what is owed less what payments, drafts and waiting vouchers hold, and the draft being edited takes its own part again', () => {
    const forNew = voucherPayableBills(bills, payments, null);
    expect(forNew.map((b) => [b.bill_no, b.payable])).toEqual([['BILL-0009', 80], ['BILL-0007', 32.5], ['BILL-0008', 250]]);
    const forDraft = voucherPayableBills(bills, payments, VOUCHER);
    expect(forDraft.map((b) => [b.bill_no, b.payable])).toEqual([['BILL-0009', 80], ['BILL-0007', 132.5], ['BILL-0008', 300]]);
    expect(voucherBillOwed(forDraft[2])).toBe('RM 300.00 to pay · RM 200.00 of RM 500.00 held by payments and vouchers not yet paid');
    expect(voucherBillOwed(forDraft[1])).toBe('RM 132.50 to pay');
  });
});

describe('the form, for a supplier’s bills', () => {
  const payable = voucherPayableBills(bills, payments, null);
  const fresh = chooseVoucherKind(newVoucherForm(accounts, categories, TODAY), 'bills');
  const ticked = { ...chooseVoucherSupplier(fresh, MAJU), amounts: { [BILL_A]: '32.50', [BILL_B]: '100' } };
  it('starts as a new voucher for a category, and keeps the rest when the kind is changed', () => {
    expect(newVoucherForm(accounts, categories, TODAY)).toMatchObject({ id: null, kind: 'category', supplierId: '', amounts: {} });
    expect(fresh).toMatchObject({ kind: 'bills', accountId: ACCOUNT, date: TODAY });
    expect(chooseVoucherKind(fresh, 'bills')).toBe(fresh);
  });
  it('keeps the category side as it was typed when the kind goes to bills and back (the payee and the Name box stay usable)', () => {
    const typed = { ...newVoucherForm(accounts, categories, TODAY), payee: TYPED_PAYEE, payeeName: 'Tenaga Nasional', categoryId: CATEGORY, amount: '40' };
    const back = chooseVoucherKind(chooseVoucherKind(typed, 'bills'), 'category');
    expect(back).toEqual(typed);
    expect(back.payee).toBe(TYPED_PAYEE);
    expect(back.payeeName).toBe('Tenaga Nasional');
    // A contact chosen as the payee survives the same way.
    const contact = { ...typed, payee: MAJU, payeeName: '' };
    expect(chooseVoucherKind(chooseVoucherKind(contact, 'bills'), 'category').payee).toBe(MAJU);
    // And an edited bills draft switched to a category lands with the typed-name choice and an empty box, not a blank select.
    expect(chooseVoucherKind(draftVoucherForm(row(), payments, bills, accounts), 'category')).toMatchObject({ kind: 'category', payee: TYPED_PAYEE });
  });
  it('starts the ticks again for another supplier, and drops a ticked bill that is no longer offered', () => {
    expect(chooseVoucherSupplier(ticked, JAYA).amounts).toEqual({});
    expect(chooseVoucherSupplier(ticked, MAJU)).toBe(ticked);
    expect(keepVoucherBills(ticked, payable.filter((b) => b.id !== BILL_B)).amounts).toEqual({ [BILL_A]: '32.50' });
    expect(keepVoucherBills(ticked, payable)).toBe(ticked);
  });
  it('adds the ticked amounts up, and sends them as the split with every field, to save or to send', () => {
    expect(voucherTotal(ticked)).toBe(132.5);
    const sent = voucherSavePayload({ ...ticked, reference: '', notes: '' }, true);
    expect(sent).toEqual({
      kind: 'bills', account_id: ACCOUNT, txn_date: TODAY, method: 'bank_transfer', reference: '', notes: '', send: true,
      allocations: [{ bill_id: BILL_A, amount: 32.5 }, { bill_id: BILL_B, amount: 100 }],
    });
    expect(saveVoucherInput.safeParse(sent).success).toBe(true);
    expect(voucherSavePayload({ ...ticked, id: VOUCHER }, false)).toMatchObject({ id: VOUCHER, send: false });
  });
  it('names the first thing wrong, in the order of the form', () => {
    expect(voucherFormError(fresh, payable)).toBe(M.supplier);
    expect(voucherFormError(chooseVoucherSupplier(fresh, MAJU), payable)).toBe(M.bills);
    expect(voucherFormError({ ...ticked, amounts: { [BILL_A]: '' } }, payable)).toBe(M.amount);
    expect(voucherFormError({ ...ticked, amounts: { [BILL_A]: '32.51' } }, payable)).toBe(M.tooMuch);
    // A ticked bill that is no longer offered was paid or taken up since the form opened.
    expect(voucherFormError(ticked, payable.filter((b) => b.id !== BILL_A))).toBe(M.tooMuch);
    expect(voucherFormError({ ...ticked, accountId: '' }, payable)).toBe(M.account);
    expect(voucherFormError({ ...ticked, date: '' }, payable)).toBe(M.date);
    expect(voucherFormError(ticked, payable)).toBeNull();
  });
  it('says what its buttons do, the same for everyone', () => {
    for (const canDecide of [true, false]) {
      expect(voucherSaveHint(canDecide, ticked)).toEqual([BILLS_HINT, DRAFT_HINT]);
      expect(voucherSubmitLabel(canDecide, ticked)).toBe('Send for approval');
    }
    expect(BILLS_HINT).toContain('record it on Payments Out instead');
    expect(voucherFirstWrite(ticked)).toBe('send');
    expect(voucherDraftLabel(ticked)).toBe('Save as draft');
  });
});

describe('a draft being edited', () => {
  it('opens with its bills ticked for what it holds, its supplier chosen and its fields', () => {
    expect(draftVoucherForm(row(), payments, bills, accounts)).toEqual({
      id: VOUCHER, kind: 'bills', supplierId: MAJU, amounts: { [BILL_A]: '100.00', [BILL_B]: '50.00' }, payee: TYPED_PAYEE, payeeName: '',
      categoryId: '', amount: '', accountId: ACCOUNT, date: '2026-10-05', method: 'cheque', reference: '', notes: 'October',
    });
  });
  it('opens a category draft with its payee, category and amount, and asks for another account when its own was archived', () => {
    const typed = row({ kind: 'other', contact_id: null, party_name: 'Tenaga Nasional', category_id: CATEGORY, amount: 300.5, documents: null });
    expect(draftVoucherForm(typed, payments, bills, [])).toMatchObject({
      kind: 'category', payee: TYPED_PAYEE, payeeName: 'Tenaga Nasional', categoryId: CATEGORY, amount: '300.50', accountId: '', amounts: {},
    });
    expect(draftVoucherForm({ ...typed, contact_id: MAJU, party_name: 'Syarikat Maju' }, [], bills, accounts)).toMatchObject({ payee: MAJU, payeeName: '' });
  });
  it('is sent for approval by the first button whoever presses it, and saved by the second', () => {
    const editing = draftVoucherForm(row({ kind: 'other', contact_id: null, party_name: 'TNB', category_id: CATEGORY }), [], bills, accounts);
    expect(voucherFirstWrite(editing)).toBe('send');
    expect(voucherSubmitLabel(true, editing)).toBe('Send for approval');
    expect(voucherSaveHint(true, editing)).toEqual([DRAFT_HINT]);
    expect(voucherDraftLabel(editing)).toBe('Save draft');
    expect(voucherSavePayload(editing, true)).toMatchObject({ kind: 'category', id: VOUCHER, category_id: CATEGORY, party_name: 'TNB', contact_id: null, send: true });
    // A new category voucher keeps the one-step record: approved at once for an owner or admin.
    const fresh = newVoucherForm(accounts, categories, TODAY);
    expect(voucherFirstWrite(fresh)).toBe('record');
    expect(voucherSubmitLabel(true, fresh)).toBe('Save voucher');
    expect(voucherSubmitLabel(false, fresh)).toBe('Send for approval');
    expect(voucherSaveHint(false, fresh)[1]).toBe(DRAFT_HINT);
  });
});

describe('a draft’s row', () => {
  it('offers Edit, Send for approval and Delete to anyone who may write, when it pays bills or carries a category', () => {
    for (const canDecide of [true, false]) {
      expect(voucherActions(row(), canDecide)).toEqual(['edit', 'submit', 'delete']);
      expect(voucherActions(row({ kind: 'other' }), canDecide)).toEqual(['edit', 'submit', 'delete']);
      expect(voucherActions(row({ kind: 'expense' }), canDecide)).toEqual(['delete']);
      expect(voucherActions(row({ kind: 'refund' }), canDecide)).toEqual(['delete']);
    }
  });
  it('links a supplier payment to Payments Out at every status, and says it is managed there only from To be paid on', () => {
    for (const status of ['draft', 'pending_approval', 'rejected'] as const) {
      expect(voucherKindLink(row({ status })), status).toEqual({ label: 'Payments Out', href: '/finance/payments-out', title: null });
    }
    for (const status of ['scheduled', 'posted', 'void'] as const) {
      expect(voucherKindLink(row({ status }))?.title, status).toBe('Managed on Payments Out');
    }
    expect(voucherKindLink(row({ kind: 'other', status: 'draft' }))).toBeNull();
  });
  it('asks before sending, naming the amount, the supplier, the bills, the date and the account', () => {
    expect(text(voucherQuestion('submit', row()))).toBe(
      'Send the payment of RM 150.00 to Syarikat Maju for BILL-0007, BILL-0008, dated 05 Oct 2026, from Maybank Current, for approval? It then waits as Pending approval and cannot be changed, only approved, rejected or deleted.',
    );
    expect(voucherAnswerIsStale(M.draftChanged)).toBe(true);
    expect(voucherAnswerIsStale(M.notDraftSend)).toBe(true);
    expect(voucherAnswerIsStale(M.accountArchivedDraft)).toBe(false);
  });
  it('says what hides a draft just saved: the status filter or the search (a draft is listed in every period)', () => {
    const saved: WrittenVoucher = { id: VOUCHER, status: 'draft', recorded: true, payee: 'Syarikat Maju', amount: 150, date: '2026-10-05' };
    const what = 'The payment of RM 150.00 to Syarikat Maju, dated 05 Oct 2026, was saved as a draft.';
    expect(writtenVoucherTitle(saved)).toBe('Draft saved');
    expect(voucherHiddenNote(saved, TODAY, 'month', 'open', true, true)).toBeNull();
    expect(voucherHiddenNote(saved, TODAY, 'month', 'open', true, false)).toBe(`${what} Choose View all to see it.`);
    expect(voucherHiddenNote(saved, TODAY, 'month', 'waiting', false, false)).toBe(`${what} Choose All but void and rejected in the status filter to see it.`);
    const old = { ...saved, date: '2025-01-05' };
    const oldWhat = 'The payment of RM 150.00 to Syarikat Maju, dated 05 Jan 2025, was saved as a draft.';
    expect(voucherHiddenNote(old, TODAY, 'month', 'posted', false, false)).toBe(`${oldWhat} Choose All but void and rejected in the status filter to see it.`);
    expect(voucherHiddenNote(old, TODAY, 'month', 'open', false, false)).toBe(`${oldWhat} Clear the search and the Kind filter to see it.`);
    expect(voucherHiddenNote(old, TODAY, 'month', 'open', false, false)).not.toContain('longer period');
    expect(voucherHiddenNote(saved, TODAY, 'month', 'open', false, false)).toBe(`${what} Clear the search and the Kind filter to see it.`);
  });
});
