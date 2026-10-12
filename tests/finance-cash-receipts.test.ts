import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cashReceiptIdInput,
  deleteCashReceipt,
  listIncomeCategories,
  postCashReceipt,
  saveCashReceipt,
  saveCashReceiptInput,
  voidCashReceipt,
} from '@/lib/finance/cash-receipts';
import { type FinanceAnswer, type FinanceCall, fakeFinance } from './setup/fake-finance';

const TXN = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';
const INVOICE_1 = '77777777-7777-4777-8777-777777777777';
const INVOICE_2 = '88888888-8888-4888-8888-888888888888';
const CATEGORY = '99999999-9999-4999-8999-999999999999';
const CONTACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const income = {
  kind: 'income' as const,
  account_id: ACCOUNT,
  txn_date: '2026-10-05',
  method: 'cash' as const,
  category_id: CATEGORY,
  amount: 50,
  party_name: 'Walk-in',
};
const forInvoices = {
  kind: 'invoice' as const,
  account_id: ACCOUNT,
  txn_date: '2026-10-05',
  method: 'fpx' as const,
  allocations: [{ invoice_id: INVOICE_1, amount: 100 }],
};

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => saveCashReceiptInput.safeParse(value).error?.issues[0]?.message;
/** The same object with one field left out. */
const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

describe('saveCashReceiptInput', () => {
  it('asks what the receipt is for', () => {
    expect(first(without(income, 'kind'))).toBe('Choose what this receipt is for: a customer’s invoices, or other income.');
    expect(first({ ...income, kind: 'expense' })).toBe('Choose what this receipt is for: a customer’s invoices, or other income.');
    expect(first(null)).toBe('Choose what this receipt is for: a customer’s invoices, or other income.');
  });
  it('asks either kind for an account, a real date and a known method', () => {
    for (const valid of [income, forInvoices]) {
      expect(first({ ...valid, account_id: '' })).toBe('Choose the account the money went into.');
      expect(first({ ...valid, txn_date: '5 Oct' })).toBe('Enter a valid date.');
      expect(first({ ...valid, txn_date: undefined })).toBe('Enter a valid date.');
      expect(first({ ...valid, method: 'barter' })).toBe('Choose how it was paid.');
      expect(first({ ...valid, reference: 'x'.repeat(201) })).toBe('That is too long. Keep it to 200 characters or fewer.');
      expect(first({ ...valid, id: 'nope' })).toBe('That receipt no longer exists.');
    }
  });
  it('asks a receipt for income for a category and an amount above 0', () => {
    expect(first({ ...income, category_id: '' })).toBe('Choose an income category.');
    expect(first({ ...income, amount: 0 })).toBe('Enter an amount above 0.');
    expect(first({ ...income, amount: 0.004 })).toBe('Enter an amount above 0.');
    expect(first({ ...income, amount: Number.NaN })).toBe('Enter an amount above 0.');
    expect(first({ ...income, amount: '50' })).toBe('Enter an amount above 0.');
    expect(first({ ...income, amount: 1_000_000_000_000 })).toBe('Enter an amount above 0.');
  });
  it('takes a contact, a typed name or nobody as the payer, and never a contact with a name', () => {
    expect(first({ ...income, contact_id: CONTACT })).toBe('Choose a contact or type a name, not both.');
    expect(first({ ...income, party_name: null, contact_id: 'someone' })).toBe('Choose a contact or type a name, not both.');
    expect(saveCashReceiptInput.parse({ ...income, party_name: ' ', contact_id: CONTACT })).toMatchObject({ contact_id: CONTACT, party_name: null });
    expect(saveCashReceiptInput.parse({ ...income, party_name: '  Walk-in ', contact_id: '' })).toMatchObject({ contact_id: null, party_name: 'Walk-in' });
    expect(saveCashReceiptInput.parse(without(income, 'party_name'))).toMatchObject({ contact_id: null, party_name: null });
  });
  it('asks a receipt for invoices for at least one invoice, each once, each above 0, and at most 50', () => {
    expect(first({ ...forInvoices, allocations: [] })).toBe('Choose at least one invoice this receipt is for.');
    expect(first({ ...forInvoices, allocations: undefined })).toBe('Choose at least one invoice this receipt is for.');
    expect(first({ ...forInvoices, allocations: [{ invoice_id: 'x', amount: 1 }] })).toBe('Choose at least one invoice this receipt is for.');
    expect(first({ ...forInvoices, allocations: [{ invoice_id: INVOICE_1, amount: 0 }] })).toBe('Enter an amount above 0.');
    expect(
      first({
        ...forInvoices,
        // The same invoice twice, its id once in capitals.
        allocations: [
          { invoice_id: 'abcdefab-cdef-4abc-8def-abcdefabcdef', amount: 1 },
          { invoice_id: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF', amount: 1 },
        ],
      }),
    ).toBe('Each invoice can appear once on a receipt.');
    const many = Array.from({ length: 51 }, (_, n) => ({
      invoice_id: `99999999-9999-4999-8999-${String(n).padStart(12, '0')}`,
      amount: 1,
    }));
    expect(first({ ...forInvoices, allocations: many })).toBe('One receipt can cover at most 50 invoices.');
  });
  it('keeps only its own kind’s fields: a receipt for invoices has no amount, payer or category of its own', () => {
    const parsed = saveCashReceiptInput.parse({ ...forInvoices, amount: 5, category_id: CATEGORY, party_name: 'X', org_id: 'someone-else', status: 'posted' });
    expect(Object.keys(parsed).sort()).toEqual(['account_id', 'allocations', 'kind', 'method', 'notes', 'reference', 'txn_date']);
    const other = saveCashReceiptInput.parse({ ...income, allocations: [{ invoice_id: INVOICE_1, amount: 1 }], org_id: 'someone-else', number: 'RC-1' });
    expect(Object.keys(other).sort()).toEqual([
      'account_id', 'amount', 'category_id', 'contact_id', 'kind', 'method', 'notes', 'party_name', 'reference', 'txn_date',
    ]);
  });
  it('rounds first, then checks, and parsing its own output changes nothing', () => {
    const once = saveCashReceiptInput.parse({ ...income, id: TXN, amount: 32.506, reference: ' ', notes: ' paid at the counter ' });
    expect(once).toMatchObject({ id: TXN, amount: 32.51, reference: null, notes: 'paid at the counter' });
    expect(saveCashReceiptInput.parse(once)).toEqual(once);
    const split = saveCashReceiptInput.parse({ ...forInvoices, allocations: [{ invoice_id: INVOICE_1, amount: 0.005 }] });
    expect(split).toMatchObject({ allocations: [{ invoice_id: INVOICE_1, amount: 0.01 }] });
    expect(saveCashReceiptInput.parse(split)).toEqual(split);
  });
  it('takes an id for the id-only actions, and says the receipt is gone for anything else', () => {
    expect(cashReceiptIdInput.parse({ id: TXN })).toEqual({ id: TXN });
    expect(cashReceiptIdInput.safeParse({ id: 'nope' }).error?.issues[0]?.message).toBe('That receipt no longer exists.');
    expect(cashReceiptIdInput.safeParse({}).error?.issues[0]?.message).toBe('That receipt no longer exists.');
    expect(cashReceiptIdInput.safeParse(null).error?.issues[0]?.message).toBe('That receipt no longer exists.');
    const malformed = saveCashReceiptInput.safeParse({ ...forInvoices, allocations: [null] });
    expect(malformed.error?.issues[0]?.message).toBe('Choose at least one invoice this receipt is for.');
  });
});

/** Answers the cash receipts check with a row (a receipt) or none (any other money in), and everything else with `other`. */
const receiptOr = (isReceipt: boolean, other: FinanceAnswer) => (call: FinanceCall) =>
  call.name === 'finance_cash_receipts' ? { data: isReceipt ? [{ transaction_id: TXN }] : [], error: null } : other;

describe('saving a draft', () => {
  it('sends a new receipt for income to the database function with no split, in the caller’s workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: TXN, error: null });
    expect(await saveCashReceipt(ctx, income)).toEqual({ ok: true, data: { id: TXN } });
    expect(calls.map((c) => c.name)).toEqual(['finance_save_cash_receipt']);
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      receipt: {
        account_id: ACCOUNT, txn_date: '2026-10-05', method: 'cash', reference: null, notes: null,
        category_id: CATEGORY, amount: 50, contact_id: null, party_name: 'Walk-in',
      },
      allocations: [],
    });
  });
  it('sends a receipt for invoices its split and no amount, payer or category', async () => {
    const { ctx, calls } = fakeFinance({ data: TXN, error: null });
    const result = await saveCashReceipt(ctx, {
      ...forInvoices,
      allocations: [{ invoice_id: INVOICE_1, amount: 100 }, { invoice_id: INVOICE_2, amount: 32.5 }],
    });
    expect(result).toEqual({ ok: true, data: { id: TXN } });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      receipt: { account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx', reference: null, notes: null },
      allocations: [{ invoice_id: INVOICE_1, amount: 100 }, { invoice_id: INVOICE_2, amount: 32.5 }],
    });
  });
  it('changes a draft by its id, once Cash Receipts shows it', async () => {
    const { ctx, calls } = fakeFinance(receiptOr(true, { data: TXN, error: null }));
    expect(await saveCashReceipt(ctx, { ...income, id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(calls.map((c) => [c.name, c.op])).toEqual([['finance_cash_receipts', 'select'], ['finance_save_cash_receipt', 'rpc']]);
    expect(calls[0]).toMatchObject({ filters: { org_id: 'org-1', transaction_id: TXN }, limit: 1 });
    expect((calls[1].args!.receipt as { id: string }).id).toBe(TXN);
  });
  it('changes a draft for invoices by sending its id and its whole split in one call', async () => {
    const { ctx, calls } = fakeFinance(receiptOr(true, { data: TXN, error: null }));
    const allocations = [{ invoice_id: INVOICE_1, amount: 60 }, { invoice_id: INVOICE_2, amount: 40 }];
    expect(await saveCashReceipt(ctx, { ...forInvoices, id: TXN, allocations })).toEqual({ ok: true, data: { id: TXN } });
    expect(calls.map((c) => c.name)).toEqual(['finance_cash_receipts', 'finance_save_cash_receipt']);
    expect(calls[1].args).toEqual({
      target_org: 'org-1',
      receipt: { id: TXN, account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx', reference: null, notes: null },
      allocations,
    });
  });
  it('refuses to change money in that is not a receipt, without writing', async () => {
    // One side of a transfer between accounts is money in too, and Cash Receipts never shows it.
    const { ctx, calls } = fakeFinance(receiptOr(false, { data: TXN, error: null }));
    expect(await saveCashReceipt(ctx, { ...income, id: TXN })).toEqual({ ok: false, error: 'That receipt no longer exists.' });
    expect(calls.map((c) => c.name)).toEqual(['finance_cash_receipts']);
  });
  it('words each database refusal for a receipt', async () => {
    const cases: [string, string][] = [
      ['FIN03', 'The amounts against the invoices add up to more than the receipt.'],
      ['FIN04', 'A receipt can only go against a posted invoice.'],
      ['FIN05', 'That is more than is still owed on an invoice, counting what other receipts not yet posted already hold.'],
      ['FIN06', 'The invoices on one receipt must all be one customer’s, and must still exist.'],
      ['FIN09', 'This receipt has been posted or voided, so that can no longer be done.'],
      ['FIN11', 'That receipt no longer exists.'],
      ['FIN14', 'Only an owner or admin can post, pay or void. Ask one of them to do this.'],
      ['FIN15', 'A receipt needs either invoices that add up to its amount, or an income category that still exists. Edit it and try again.'],
      ['23503', 'The account, the contact or an invoice on this receipt no longer exists.'],
      ['23505', 'Each invoice can appear once on a receipt.'],
      ['23502', 'Check the amount, the method and who it is from, then try again.'],
      ['23514', 'Check the amount, the method and who it is from, then try again.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
    ];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      expect(await saveCashReceipt(ctx, forInvoices), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('logs anything else and gives the general sentence', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000', message: 'boom' } });
    expect(await saveCashReceipt(ctx, income)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe('posting', () => {
  it('posts through the database function and answers with the number', async () => {
    const { ctx, calls } = fakeFinance(receiptOr(true, { data: 'RC-0007', error: null }));
    expect(await postCashReceipt(ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN, number: 'RC-0007' } });
    expect(calls.map((c) => [c.name, c.op])).toEqual([['finance_cash_receipts', 'select'], ['finance_post_cash_receipt', 'rpc']]);
    expect(calls[1].args).toEqual({ target_org: 'org-1', target_txn: TXN });
  });
  it('tells someone who is not an owner or admin who can post, and says a posted receipt is posted', async () => {
    const refused = async (code: string) => postCashReceipt(fakeFinance(receiptOr(true, { data: null, error: { code } })).ctx, { id: TXN });
    expect(await refused('FIN14')).toEqual({ ok: false, error: 'Only an owner or admin can post, pay or void. Ask one of them to do this.' });
    expect(await refused('FIN09')).toEqual({ ok: false, error: 'This receipt has been posted or voided, so that can no longer be done.' });
    expect(await refused('FIN15')).toMatchObject({ ok: false, error: expect.stringContaining('Edit it and try again.') });
    expect(await refused('42501')).toEqual({ ok: false, error: 'You do not have permission to make changes here.' });
  });
  it('does not blame a clash on posting on an invoice appearing twice', async () => {
    const { ctx } = fakeFinance(receiptOr(true, { data: null, error: { code: '23505' } }));
    expect(await postCashReceipt(ctx, { id: TXN })).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalledTimes(1);
  });
  it('refuses money in that is not a receipt, without calling the function', async () => {
    const { ctx, calls } = fakeFinance(receiptOr(false, { data: 'RC-0007', error: null }));
    expect(await postCashReceipt(ctx, { id: TXN })).toEqual({ ok: false, error: 'That receipt no longer exists.' });
    expect(calls.map((c) => c.name)).toEqual(['finance_cash_receipts']);
  });
});

describe('voiding and deleting', () => {
  it('voids by one status change, kept to money in and to the workspace, once Cash Receipts shows it', async () => {
    const { ctx, calls } = fakeFinance(receiptOr(true, { data: { id: TXN }, error: null }));
    expect(await voidCashReceipt(ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(calls.map((c) => [c.name, c.op])).toEqual([['finance_cash_receipts', 'select'], ['finance_transactions', 'update']]);
    expect(calls[1].filters).toEqual({ id: TXN, org_id: 'org-1', direction: 'in' });
    // Only these two: number, approved_by, approved_at and created_by are closed to the authenticated role.
    expect(Object.keys(calls[1].values!).sort()).toEqual(['status', 'updated_at']);
    expect(calls[1].values).toMatchObject({ status: 'void' });
  });
  it('words a void that the database refuses, and one that matched no row', async () => {
    const refused = async (answer: FinanceAnswer) => voidCashReceipt(fakeFinance(receiptOr(true, answer)).ctx, { id: TXN });
    expect(await refused({ data: null, error: { code: 'FIN14' } })).toEqual({
      ok: false, error: 'Only an owner or admin can post, pay or void. Ask one of them to do this.',
    });
    expect(await refused({ data: null, error: { code: 'FIN09' } })).toEqual({
      ok: false, error: 'This receipt cannot be voided as it now stands: it has already been voided, or it is still a draft.',
    });
    expect(await refused({ data: null, error: null })).toEqual({ ok: false, error: 'That receipt no longer exists.' });
  });
  it('deletes a draft by one delete, kept to money in and to the workspace', async () => {
    const { ctx, calls } = fakeFinance(receiptOr(true, { data: { id: TXN }, error: null }));
    expect(await deleteCashReceipt(ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(calls.map((c) => [c.name, c.op])).toEqual([['finance_cash_receipts', 'select'], ['finance_transactions', 'delete']]);
    expect(calls[1].filters).toEqual({ id: TXN, org_id: 'org-1', direction: 'in' });
  });
  it('says a posted or voided receipt cannot be deleted', async () => {
    // The database answers FIN09 for a posted receipt and for a void one alike.
    const { ctx } = fakeFinance(receiptOr(true, { data: null, error: { code: 'FIN09' } }));
    expect(await deleteCashReceipt(ctx, { id: TXN })).toEqual({
      ok: false, error: 'This receipt has been posted or voided, so it cannot be deleted.',
    });
  });
  it('answers FIN09 on a void receipt with a sentence that is true of it', async () => {
    const { ctx, calls } = fakeFinance(receiptOr(true, { data: null, error: { code: 'FIN09' } }));
    const result = await deleteCashReceipt(ctx, { id: TXN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toMatch(/Void it instead/);
    expect(calls.map((c) => c.op)).toEqual(['select', 'delete']);
  });
  it('refuses money in that is not a receipt, without writing', async () => {
    for (const write of [voidCashReceipt, deleteCashReceipt]) {
      const { ctx, calls } = fakeFinance(receiptOr(false, { data: { id: TXN }, error: null }));
      expect(await write(ctx, { id: TXN })).toEqual({ ok: false, error: 'That receipt no longer exists.' });
      expect(calls.map((c) => [c.name, c.op])).toEqual([['finance_cash_receipts', 'select']]);
    }
  });
  it('gives the general sentence when the check itself fails', async () => {
    const { ctx, calls } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await voidCashReceipt(ctx, { id: TXN })).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(calls).toHaveLength(1);
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe('listIncomeCategories', () => {
  it('reads the workspace’s active income categories by name', async () => {
    const { ctx, calls } = fakeFinance({ data: [{ id: CATEGORY, name: 'Sales' }], error: null });
    expect(await listIncomeCategories(ctx)).toEqual([{ id: CATEGORY, name: 'Sales' }]);
    expect(calls[0]).toMatchObject({
      kind: 'table', name: 'finance_categories', op: 'select', columns: 'id,name',
      filters: { org_id: 'org-1', kind: 'income', active: true }, order: ['name asc'],
    });
  });
  it('throws when the read fails', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    await expect(listIncomeCategories(ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
});
