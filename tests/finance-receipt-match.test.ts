import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BillListRow } from '@/lib/finance/bills';
import { TYPED_VENDOR } from '@/lib/finance/expense-form';
import { EXPENSE_MESSAGES, type ExpenseRow } from '@/lib/finance/expenses';
import { BILL_MESSAGES } from '@/lib/finance/bills';
import {
  ATTACH_LIST_MAX,
  type AttachedReceipt,
  RECEIPT_BILL_PATHS,
  RECEIPT_EXPENSE_PATHS,
  RECEIPT_MATCH_MESSAGES as M,
  RECEIPT_TIE_PATHS,
  UNTIE_NEEDS_DECIDER,
  attachCandidates,
  attachLockNote,
  attachReceipt,
  attachReceiptInput,
  billFormFromReceipt,
  detachReceipt,
  expenseFormFromReceipt,
  filterAttachCandidates,
  listAttachedReceipts,
  matchHiddenNote,
  matchNote,
  matchedDocuments,
  receiptMatchActions,
  receiptToBill,
  receiptToBillInput,
  receiptToExpense,
  receiptToExpenseInput,
  receiptsByDocument,
  sameAmount,
} from '@/lib/finance/receipt-match';
import { NOT_ALLOWED, TOO_LARGE, WRITE_FAILED } from '@/lib/finance/result';
import { type FinanceCall, fakeFinance } from './setup/fake-finance';

const RECEIPT = '44444444-4444-4444-8444-444444444444';
const EXPENSE = '55555555-5555-4555-8555-555555555555';
const BILL = '66666666-6666-4666-8666-666666666666';
const CATEGORY = '77777777-7777-4777-8777-777777777777';
const SUPPLIER = '88888888-8888-4888-8888-888888888888';

const expenseInput = { expense_date: '2026-10-03', category_id: CATEGORY, vendor_id: null, vendor_name: 'Shell Bangsar', amount: 142.5, sst_amount: 8.07, notes: '' };
const billInput = {
  supplier_id: SUPPLIER,
  supplier_ref: '',
  bill_date: '2026-10-03',
  due_date: '2026-11-02',
  purchase_order_id: '',
  category_id: '',
  notes: '',
  lines: [{ product_id: '', description: 'Receipt: Printhub', quantity: 1, uom: '', pack_size: '', unit_price: 310, sst_rate: 0 }],
};

const expense = (over: Partial<ExpenseRow>): ExpenseRow => ({
  id: EXPENSE, expense_date: '2026-10-03', category_id: CATEGORY, category_name: 'Travel', vendor_id: null, vendor_name: 'Shell',
  amount: 142.5, sst_amount: 0, notes: null, status: 'pending', display_status: 'pending', paid: 0, held: 0, method: null,
  paid_on: null, updated_at: '2026-10-03T09:00:00+00:00',
  ...over,
});
const bill = (over: Partial<BillListRow>): BillListRow => ({
  id: BILL, bill_no: null, supplier_id: SUPPLIER, supplier_name: 'Printhub', bill_date: '2026-10-01', due_date: '2026-10-31',
  total: 310, paid: 0, balance: 310, display_status: 'draft', purchase_order_id: null, purchase_order_no: null,
  category_id: CATEGORY, category_name: 'Purchases',
  ...over,
});
const attached = (over: Partial<AttachedReceipt>): AttachedReceipt => ({
  id: RECEIPT, file_name: 'resit.jpg', mime_type: 'image/jpeg', has_file: true, expense_id: null, bill_id: null, ...over,
});

describe('the schemas', () => {
  it('take the expense form’s and the bill form’s own payloads, beside the receipt', () => {
    expect(receiptToExpenseInput.safeParse({ receipt_id: RECEIPT, expense: expenseInput }).success).toBe(true);
    expect(receiptToBillInput.safeParse({ receipt_id: RECEIPT, bill: billInput }).success).toBe(true);
  });

  it('refuse what the expense and the bill schemas refuse, in their own sentences', () => {
    const first = (r: { success: boolean; error?: { issues: { message: string }[] } }) => r.error?.issues[0]?.message;
    expect(first(receiptToExpenseInput.safeParse({ receipt_id: RECEIPT, expense: { ...expenseInput, amount: Number.NaN } }))).toBe(EXPENSE_MESSAGES.amount);
    expect(first(receiptToExpenseInput.safeParse({ receipt_id: RECEIPT, expense: { ...expenseInput, amount: 0 } }))).toBe(EXPENSE_MESSAGES.amount);
    expect(first(receiptToExpenseInput.safeParse({ receipt_id: RECEIPT, expense: { ...expenseInput, sst_amount: 200 } }))).toBe(EXPENSE_MESSAGES.sstTooMuch);
    expect(first(receiptToExpenseInput.safeParse({ receipt_id: RECEIPT, expense: { ...expenseInput, category_id: '' } }))).toBe(EXPENSE_MESSAGES.category);
    expect(first(receiptToBillInput.safeParse({ receipt_id: RECEIPT, bill: { ...billInput, lines: [] } }))).toBe(BILL_MESSAGES.lines);
    expect(first(receiptToBillInput.safeParse({ receipt_id: RECEIPT, bill: { ...billInput, supplier_id: '' } }))).toBe(BILL_MESSAGES.supplier);
    expect(first(receiptToExpenseInput.safeParse({ receipt_id: 'x', expense: expenseInput }))).toBe(M.gone);
    expect(first(receiptToExpenseInput.safeParse({ receipt_id: RECEIPT }))).toBeTruthy();
  });

  it('attach needs a kind and a document', () => {
    expect(attachReceiptInput.safeParse({ receipt_id: RECEIPT, kind: 'expense', document_id: EXPENSE }).success).toBe(true);
    for (const bad of [{ receipt_id: RECEIPT }, { receipt_id: RECEIPT, kind: 'invoice', document_id: EXPENSE }, { receipt_id: RECEIPT, kind: 'bill', document_id: '' }, null]) {
      const parsed = attachReceiptInput.safeParse(bad);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe(M.choose);
    }
  });
});

describe('the writes', () => {
  it('makes an expense through the one function, never with an id, and reads back how the database left it', async () => {
    const { ctx, calls } = fakeFinance((call: FinanceCall) =>
      call.kind === 'rpc' ? { data: EXPENSE, error: null } : { data: { status: 'approved' }, error: null },
    );
    const result = await receiptToExpense(ctx, { receipt_id: RECEIPT, expense: { ...expenseInput, id: EXPENSE } });
    expect(result).toEqual({ ok: true, data: { id: EXPENSE, status: 'approved' } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_receipt_to_expense' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      target_receipt: RECEIPT,
      expense: { expense_date: '2026-10-03', category_id: CATEGORY, vendor_id: null, vendor_name: 'Shell Bangsar', amount: 142.5, sst_amount: 8.07, notes: null },
    });
    expect(calls[1]).toMatchObject({ kind: 'table', name: 'finance_expenses', filters: { id: EXPENSE, org_id: 'org-1' } });
  });

  it('answers a saved expense whose status could not be read back with status null', async () => {
    const { ctx } = fakeFinance((call: FinanceCall) => (call.kind === 'rpc' ? { data: EXPENSE, error: null } : { data: null, error: { code: 'XX000' } }));
    expect(await receiptToExpense(ctx, { receipt_id: RECEIPT, expense: expenseInput })).toEqual({ ok: true, data: { id: EXPENSE, status: null } });
  });

  it('makes a draft bill through the one function: the lines beside the bill, no id, and nothing that posts', async () => {
    const { ctx, calls } = fakeFinance({ data: BILL, error: null });
    const result = await receiptToBill(ctx, { receipt_id: RECEIPT, bill: { ...billInput, id: BILL } });
    expect(result).toEqual({ ok: true, data: { id: BILL } });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('finance_receipt_to_bill');
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      target_receipt: RECEIPT,
      bill: { supplier_id: SUPPLIER, supplier_ref: null, bill_date: '2026-10-03', due_date: '2026-11-02', purchase_order_id: null, category_id: null, notes: null },
      lines: [{ product_id: null, description: 'Receipt: Printhub', quantity: 1, uom: null, pack_size: null, unit_price: 310, sst_rate: 0 }],
    });
  });

  it('attaches to exactly one document and unties by the receipt alone', async () => {
    const a = fakeFinance({ data: null, error: null });
    expect(await attachReceipt(a.ctx, { receipt_id: RECEIPT, kind: 'expense', document_id: EXPENSE })).toEqual({ ok: true, data: { id: RECEIPT } });
    expect(a.calls[0].args).toEqual({ target_org: 'org-1', target_receipt: RECEIPT, target_expense: EXPENSE, target_bill: null });
    const b = fakeFinance({ data: null, error: null });
    await attachReceipt(b.ctx, { receipt_id: RECEIPT, kind: 'bill', document_id: BILL });
    expect(b.calls[0].args).toEqual({ target_org: 'org-1', target_receipt: RECEIPT, target_expense: null, target_bill: BILL });
    const d = fakeFinance({ data: null, error: null });
    expect(await detachReceipt(d.ctx, { id: RECEIPT })).toEqual({ ok: true, data: { id: RECEIPT } });
    expect(d.calls[0]).toMatchObject({ name: 'finance_detach_receipt', args: { target_org: 'org-1', target_receipt: RECEIPT } });
  });

  const refused = (code: string) => fakeFinance({ data: null, error: { code, message: 'secret vendor name' } }).ctx;

  it.each([
    ['FIN11', M.gone],
    ['FIN23', M.alreadyMatched],
    ['FIN15', EXPENSE_MESSAGES.categoryGone],
    ['23503', EXPENSE_MESSAGES.missing],
    ['23514', EXPENSE_MESSAGES.invalid],
    ['42501', NOT_ALLOWED],
    ['22003', TOO_LARGE],
    ['XX000', WRITE_FAILED],
  ])('an expense from a receipt refused with %s says so', async (code, sentence) => {
    expect(await receiptToExpense(refused(code), { receipt_id: RECEIPT, expense: expenseInput })).toEqual({ ok: false, error: sentence });
  });

  it.each([
    ['FIN11', M.gone],
    ['FIN23', M.alreadyMatched],
    ['FIN10', BILL_MESSAGES.lines],
    ['FIN21', BILL_MESSAGES.order],
    ['FIN26', BILL_MESSAGES.category],
    ['23503', BILL_MESSAGES.missing],
    ['42501', NOT_ALLOWED],
    ['22003', TOO_LARGE],
    ['XX000', WRITE_FAILED],
  ])('a bill from a receipt refused with %s says so', async (code, sentence) => {
    expect(await receiptToBill(refused(code), { receipt_id: RECEIPT, bill: billInput })).toEqual({ ok: false, error: sentence });
  });

  it.each([
    ['FIN11', M.gone],
    ['FIN23', M.alreadyMatched],
    ['FIN25', M.voidBill],
    ['23503', M.documentGone],
    ['22023', M.choose],
    ['42501', NOT_ALLOWED],
    ['XX000', WRITE_FAILED],
  ])('an attach refused with %s says so', async (code, sentence) => {
    expect(await attachReceipt(refused(code), { receipt_id: RECEIPT, kind: 'bill', document_id: BILL })).toEqual({ ok: false, error: sentence });
  });

  it.each([
    ['FIN11', M.gone],
    ['FIN14', M.needsDecider],
    ['42501', NOT_ALLOWED],
    ['XX000', WRITE_FAILED],
  ])('an untie refused with %s says so', async (code, sentence) => {
    expect(await detachReceipt(refused(code), { id: RECEIPT })).toEqual({ ok: false, error: sentence });
  });
});

describe('the read', () => {
  it('reads matched receipts of the workspace, never a path, a page at a time, with no filter on a nullable column', async () => {
    const { ctx, calls } = fakeFinance({ data: [attached({ expense_id: EXPENSE })], error: null });
    const rows = await listAttachedReceipts(ctx);
    expect(rows).toEqual([attached({ expense_id: EXPENSE })]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'finance_receipt_inbox', filters: { org_id: 'org-1', status: 'matched' }, range: [0, 999] });
    expect(calls[0].columns).toBe('id,file_name,mime_type,has_file,expense_id,bill_id');
    expect(calls[0].columns).not.toContain('file_path');
    expect(Object.keys(calls[0].filters).sort()).toEqual(['org_id', 'status']);
  });

  it('groups receipts under their document', () => {
    const second = attached({ id: 'r2', expense_id: EXPENSE });
    expect(receiptsByDocument([attached({ expense_id: EXPENSE }), attached({ id: 'r3', bill_id: BILL }), second, attached({ id: 'r4' })])).toEqual({
      [EXPENSE]: [attached({ expense_id: EXPENSE }), second],
      [BILL]: [attached({ id: 'r3', bill_id: BILL })],
    });
  });
});

describe('how a matched receipt’s document stands', () => {
  it('labels each state, and locks an approved expense and a posted bill', () => {
    const docs = (e: Partial<ExpenseRow> | null, b: Partial<BillListRow> | null) =>
      matchedDocuments(
        [attached({ id: 'on-expense', expense_id: EXPENSE }), attached({ id: 'on-bill', bill_id: BILL })],
        e ? [expense(e)] : [],
        b ? [bill(b)] : [],
      );
    expect(docs({}, {})).toEqual({
      'on-expense': { kind: 'expense', id: EXPENSE, label: 'Pending approval', locked: false },
      'on-bill': { kind: 'bill', id: BILL, label: 'Draft', locked: false },
    });
    expect(docs({ status: 'approved', display_status: 'approved' }, { display_status: 'pending' })).toMatchObject({
      'on-expense': { label: 'Approved', locked: true },
      'on-bill': { label: 'Posted', locked: true },
    });
    expect(docs({ status: 'approved', display_status: 'paid' }, { display_status: 'overdue' })).toMatchObject({
      'on-expense': { label: 'Paid', locked: true },
      'on-bill': { label: 'Posted, overdue', locked: true },
    });
    expect(docs({ status: 'rejected', display_status: 'rejected' }, { display_status: 'void' })).toMatchObject({
      'on-expense': { label: 'Rejected', locked: false },
      'on-bill': { label: 'Void', locked: false },
    });
    expect(docs(null, { display_status: 'paid' })).toMatchObject({
      // A document that was not read is treated as locked, and says nothing.
      'on-expense': { label: '', locked: true },
      'on-bill': { label: 'Paid', locked: true },
    });
  });

  it('offers what the database allows', () => {
    const open = { kind: 'expense' as const, id: EXPENSE, label: 'Pending approval', locked: false };
    const locked = { ...open, label: 'Approved', locked: true };
    for (const status of ['review', 'unmatched'] as const) {
      expect(receiptMatchActions({ status }, undefined, false)).toEqual(['expense', 'bill', 'attach']);
      expect(receiptMatchActions({ status }, undefined, true)).toEqual(['expense', 'bill', 'attach']);
    }
    expect(receiptMatchActions({ status: 'matched' }, open, false)).toEqual(['untie']);
    expect(receiptMatchActions({ status: 'matched' }, open, true)).toEqual(['untie']);
    expect(receiptMatchActions({ status: 'matched' }, locked, true)).toEqual(['untie']);
    expect(receiptMatchActions({ status: 'matched' }, locked, false)).toEqual([]);
    expect(receiptMatchActions({ status: 'matched' }, undefined, false)).toEqual([]);
    expect(receiptMatchActions({ status: 'matched' }, undefined, true)).toEqual(['untie']);
    expect(UNTIE_NEEDS_DECIDER).toBe('Only an owner or admin can untie a receipt from an approved expense or a posted bill.');
  });
});

describe('the sentences a person reads when a match is refused', () => {
  // By their words, once: the other tests compare against these constants, which would follow a reworded sentence.
  it('FIN23: someone matched the receipt meanwhile', () => {
    expect(M.alreadyMatched).toBe('This receipt is already matched. Untie it first.');
  });
  it('FIN14: a member untying from an approved expense or a posted bill', () => {
    expect(M.needsDecider).toBe(
      'Only an owner or admin can untie a receipt from an approved expense or a posted bill. Ask one of them to do this.',
    );
  });
});

describe('the forms, pre-filled from a receipt', () => {
  const contacts = [
    { id: 'c1', name: 'Shell Bangsar', payment_terms_days: 14 },
    { id: 'c2', name: 'Printhub', payment_terms_days: 30 },
    { id: 'c3', name: 'printhub', payment_terms_days: 7 },
  ];

  it('starts the expense form with the receipt’s details, and the contact only when exactly one has that name', () => {
    expect(expenseFormFromReceipt({ vendor: ' shell bangsar ', receipt_date: '2026-10-03', amount: 142.5, sst_amount: 8.07 }, contacts, '2026-10-12')).toEqual({
      date: '2026-10-03', vendor: 'c1', vendorName: '', amount: '142.50', sst: '8.07',
    });
    // Two contacts with the name: the name is typed, and the person chooses.
    expect(expenseFormFromReceipt({ vendor: 'Printhub', receipt_date: null, amount: 310, sst_amount: 0 }, contacts, '2026-10-12')).toEqual({
      date: '2026-10-12', vendor: TYPED_VENDOR, vendorName: 'Printhub', amount: '310.00', sst: '',
    });
    expect(expenseFormFromReceipt({ vendor: null, receipt_date: null, amount: null, sst_amount: null }, contacts, '2026-10-12')).toEqual({
      date: '2026-10-12', vendor: TYPED_VENDOR, vendorName: '', amount: '', sst: '',
    });
  });

  it('shows money to the sen in the boxes, typed or read: 21.2 as 21.20, 1.2 as 1.20, 5 as 5.00, none as empty', () => {
    const form = expenseFormFromReceipt({ vendor: null, receipt_date: null, amount: 21.2, sst_amount: 1.2 }, contacts, '2026-10-12');
    expect([form.amount, form.sst]).toEqual(['21.20', '1.20']);
    expect(expenseFormFromReceipt({ vendor: null, receipt_date: null, amount: 5, sst_amount: null }, contacts, '2026-10-12')).toMatchObject({ amount: '5.00', sst: '' });
    expect(expenseFormFromReceipt({ vendor: null, receipt_date: null, amount: null, sst_amount: null }, contacts, '2026-10-12')).toMatchObject({ amount: '', sst: '' });
    for (const [amount, text] of [[21.2, '21.20'], [5, '5.00'], [null, '']] as const) {
      expect(billFormFromReceipt({ vendor: null, receipt_date: null, amount, sst_amount: null }, contacts, '2026-10-12').lines[0].unit_price).toBe(text);
    }
  });

  it('starts the bill form with one line for the receipt’s amount, SST rate 0, and never an id', () => {
    const form = billFormFromReceipt({ vendor: 'Shell Bangsar', receipt_date: '2026-10-03', amount: 142.5, sst_amount: 8.07 }, contacts, '2026-10-12', 'cat-default');
    expect(form.id).toBeUndefined();
    expect(form).toMatchObject({ supplier_id: 'c1', bill_date: '2026-10-03', due_date: '2026-10-17', dueEdited: false, purchase_order_id: '', category_id: 'cat-default' });
    expect(form.lines).toEqual([
      { key: 'receipt-0', product_id: '', description: 'Receipt: Shell Bangsar', quantity: '1', uom: '', pack_size: '', unit_price: '142.50', sst_rate: '0' },
    ]);
    const bare = billFormFromReceipt({ vendor: null, receipt_date: null, amount: null, sst_amount: null }, contacts, '2026-10-12');
    expect(bare).toMatchObject({ supplier_id: '', bill_date: '2026-10-12', due_date: '2026-10-12', category_id: '' });
    expect(bare.lines[0]).toMatchObject({ description: 'Receipt', unit_price: '' });
    // Two suppliers of the name: none is chosen. A vendor of 200 characters still fits a line.
    expect(billFormFromReceipt({ vendor: 'Printhub', receipt_date: null, amount: 1, sst_amount: null }, contacts, '2026-10-12').supplier_id).toBe('');
    expect(billFormFromReceipt({ vendor: 'x'.repeat(200), receipt_date: null, amount: 1, sst_amount: null }, [], '2026-10-12').lines[0].description).toHaveLength(200);
  });
});

describe('the attach picker', () => {
  const expenses = [
    expense({ id: 'e-pending', expense_date: '2026-10-03' }),
    expense({ id: 'e-approved', status: 'approved', display_status: 'approved', expense_date: '2026-10-05', amount: 50 }),
    expense({ id: 'e-paid', status: 'approved', display_status: 'paid', expense_date: '2026-10-01', amount: 20 }),
    expense({ id: 'e-rejected', status: 'rejected', display_status: 'rejected' }),
  ];
  const bills = [
    bill({ id: 'b-draft' }),
    bill({ id: 'b-posted', bill_no: 'BILL-0007', display_status: 'overdue', bill_date: '2026-10-04', total: 142.5 }),
    bill({ id: 'b-void', bill_no: 'BILL-0006', display_status: 'void' }),
  ];
  const all = attachCandidates(expenses, bills);

  it('offers pending and approved expenses and bills that are not void, newest first', () => {
    expect(all.map((c) => c.id)).toEqual(['e-approved', 'b-posted', 'e-pending', 'b-draft', 'e-paid']);
    expect(all.find((c) => c.id === 'e-pending')).toEqual({
      kind: 'expense', id: 'e-pending', title: 'Expense · Travel', detail: 'Shell · 03 Oct 2026 · Pending approval', amount: 142.5, date: '2026-10-03', locked: false,
    });
    expect(all.find((c) => c.id === 'b-posted')).toMatchObject({ title: 'Bill BILL-0007', detail: 'Printhub · 04 Oct 2026 · Posted, overdue', locked: true });
    expect(all.find((c) => c.id === 'b-draft')).toMatchObject({ title: 'Draft bill', locked: false });
    expect(all.filter((c) => c.locked).map((c) => c.id).sort()).toEqual(['b-posted', 'e-approved', 'e-paid']);
  });

  it('lists one kind, the receipt’s own amount first, and searches title, detail and amount', () => {
    expect(filterAttachCandidates(all, 'expense', '', 20).map((c) => c.id)).toEqual(['e-paid', 'e-approved', 'e-pending']);
    expect(filterAttachCandidates(all, 'expense', '', null).map((c) => c.id)).toEqual(['e-approved', 'e-pending', 'e-paid']);
    expect(filterAttachCandidates(all, 'bill', 'bill-0007', null).map((c) => c.id)).toEqual(['b-posted']);
    expect(filterAttachCandidates(all, 'bill', '142.50', null).map((c) => c.id)).toEqual(['b-posted']);
    expect(filterAttachCandidates(all, 'expense', 'printhub', null)).toEqual([]);
    expect(sameAmount(all[0], 50)).toBe(true);
    expect(sameAmount(all[0], 50.004)).toBe(true);
    expect(sameAmount(all[0], null)).toBe(false);
    expect(ATTACH_LIST_MAX).toBe(8);
  });

  it('warns someone who could not untie afterwards, and only them', () => {
    const lockedExpense = all.find((c) => c.id === 'e-approved');
    const lockedBill = all.find((c) => c.id === 'b-posted');
    expect(attachLockNote(lockedExpense, false)).toBe(
      'This expense is approved: once the receipt is attached, only an owner or admin can untie it.',
    );
    expect(attachLockNote(lockedBill, false)).toBe(
      'This bill is posted: once the receipt is attached, only an owner or admin can untie it.',
    );
    expect(attachLockNote(lockedExpense, true)).toBeNull();
    expect(attachLockNote(all.find((c) => c.id === 'e-pending'), false)).toBeNull();
    expect(attachLockNote(undefined, false)).toBeNull();
  });
});

describe('what the screen says after a match', () => {
  const base = { receiptId: RECEIPT, fileName: 'resit.jpg' };

  it('says what happened, truly for each case, and never that anything was posted', () => {
    expect(matchNote({ kind: 'expense', ...base, status: 'approved' }).body).toBe(
      'The expense was saved and approved, and the receipt is matched to it. It is on Expenses.',
    );
    expect(matchNote({ kind: 'expense', ...base, status: 'pending' }).body).toContain('waits for an owner or admin to approve it');
    expect(matchNote({ kind: 'expense', ...base, status: null }).body).toBe('The expense was saved and the receipt is matched to it. It is on Expenses.');
    const billNote = matchNote({ kind: 'bill', ...base });
    expect(billNote.body).toContain('saved as a draft');
    expect(billNote.body).toContain('Nothing was posted');
    expect(billNote.body).toContain('Supplier Bills');
    // No note carries a link: the receipt components hold no href.
    expect(Object.keys(billNote).sort()).toEqual(['body', 'title']);
    expect(matchNote({ kind: 'attached', ...base, title: 'Bill BILL-0007' })).toEqual({ title: 'Receipt attached', body: 'The receipt is now matched to Bill BILL-0007.' });
    expect(matchNote({ kind: 'untied', ...base }).body).toBe('The receipt is back under Unmatched. Its expense or bill was not changed.');
  });

  it('says when the receipt is not among the rows drawn, and nothing while the list has not caught up', () => {
    const listed = [{ id: RECEIPT }, { id: 'other' }];
    expect(matchHiddenNote({ kind: 'attached', ...base, title: 'x' }, listed, listed)).toBeNull();
    expect(matchHiddenNote({ kind: 'attached', ...base, title: 'x' }, listed, [{ id: 'other' }])).toContain('choose Matched or All receipts');
    expect(matchHiddenNote({ kind: 'untied', ...base }, listed, [{ id: 'other' }])).toContain('choose Unmatched or All receipts');
    expect(matchHiddenNote({ kind: 'bill', ...base }, [{ id: 'other' }], [{ id: 'other' }])).toBeNull();
  });
});

describe('what each action refreshes', () => {
  // actions.ts is a 'use server' file and may export only async functions, so its lists are read from its text.
  const source = readFileSync('src/app/(app)/finance/actions.ts', 'utf8');
  const listOf = (name: string): string[] => {
    const block = new RegExp(`const ${name} = \\[([^\\]]*)\\];`).exec(source);
    if (!block) throw new Error(`${name} was not found in actions.ts`);
    return [...block[1].matchAll(/'([^']+)'|\.\.\.([A-Z_]+)/g)].flatMap((m) => (m[1] ? [m[1]] : listOf(m[2])));
  };

  it('an expense made from a receipt refreshes exactly what saving an expense refreshes', () => {
    expect(RECEIPT_EXPENSE_PATHS).toEqual(listOf('EXPENSE_PATHS'));
    expect(RECEIPT_EXPENSE_PATHS).toContain('/finance/receipts-inbox');
  });

  it('a draft bill made from a receipt refreshes exactly what saving a bill refreshes, the inbox included', () => {
    expect(RECEIPT_BILL_PATHS).toEqual(listOf('BILL_PATHS'));
    expect(RECEIPT_BILL_PATHS).toContain('/finance/receipts-inbox');
    expect(RECEIPT_BILL_PATHS).toContain('/finance/purchase-orders');
  });

  it('tying and untying refresh the inbox and the two document screens', () => {
    expect(RECEIPT_TIE_PATHS).toEqual(['/finance/receipts-inbox', '/finance/expenses', '/finance/supplier-bills']);
  });
});
