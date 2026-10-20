import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBendaharaTools } from '@/lib/ai/finance-tools';
import { buildBillings } from '@/lib/crm/billings';
import { receivableFor } from '@/lib/finance/cash-receipt-form';
import { CASH_RECEIPT_MESSAGES } from '@/lib/finance/cash-receipts';
import { contraParties } from '@/lib/finance/contra-form';
import { type InvoiceListRow, invoicePaidRinggit } from '@/lib/finance/invoices';
import {
  type FinanceAccount,
  type PaymentInRow,
  RECEIPT_MESSAGES,
  paymentInRinggit,
  recordPaymentIn,
  recordPaymentInInput,
  recordPaymentInRinggit,
  recordPaymentInToolInput,
} from '@/lib/finance/money';
import {
  PAYMENT_IN_KIND,
  type ReceiptForm,
  currencyListNotes,
  newReceiptForm,
  offeredInvoices,
  receiptFormError,
  receiptPayload,
  receiptPreview,
  receivableInvoices,
  toggleAllInvoices,
  toggleInvoice,
  withRinggit,
} from '@/lib/finance/receipt-form';
import { paymentsInCsv, paymentsInView } from '@/lib/finance/sales-views';
import { ringgitRow } from './helpers/invoice-rows';

/**
 * Stage 3b, payments in on invoices in another currency: the form, the data layer, the assistant, and every
 * figure that adds payments up, in ringgit. The database side is supabase/tests/bendahara_fx_payments_in_check.sql.
 */

const AISYAH = '11111111-1111-4111-8111-111111111111';
const BANK = '66666666-6666-4666-8666-666666666666';
const TODAY = '2026-10-18';
const MYR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const USD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const USD2_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003';
const SGD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004';
const JPY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000005';

const MYR_ROW: InvoiceListRow = ringgitRow({
  id: MYR_ID, invoice_no: 'INV-1', customer_id: AISYAH, customer_name: 'Aisyah Trading', invoice_date: '2026-10-05',
  due_date: '2026-10-30', total: 100, paid: 0, credited: 0, refunded: 0, balance: 100, display_status: 'sent',
  einvoice_status: 'none', einvoice_uuid: null,
});
/** Worked example B after payment 1: USD 1,080.00 at 4.2, USD 400.00 paid (carried RM 1,680.00). */
const USD_ROW: InvoiceListRow = {
  ...MYR_ROW, id: USD_ID, invoice_no: 'INV-2', total: 1080, paid: 400, balance: 680,
  currency: 'USD', fx_rate: 4.2, fx_rate_text: '4.2000000000', fx_rate_source: 'manual', fx_rate_provider: 'reuters',
  total_myr: 4536, balance_myr: 2856, sst_myr: 336, paid_myr: 1680,
};
const USD2_ROW: InvoiceListRow = { ...USD_ROW, id: USD2_ID, invoice_no: 'INV-3', paid: 0, balance: 1080, balance_myr: 4536, paid_myr: 0 };
const SGD_ROW: InvoiceListRow = {
  ...USD2_ROW, id: SGD_ID, invoice_no: 'INV-4', currency: 'SGD', fx_rate: 3.2, fx_rate_text: '3.2000000000', total_myr: 3456, balance_myr: 3456,
};
const JPY_ROW: InvoiceListRow = {
  ...USD2_ROW, id: JPY_ID, invoice_no: 'INV-5', currency: 'JPY', total: 100000, balance: 100000,
  fx_rate: 0.029, fx_rate_text: '0.0290000000', total_myr: 2900, balance_myr: 2900, sst_myr: 0,
};
const ALL = [MYR_ROW, USD_ROW, USD2_ROW, SGD_ROW, JPY_ROW];

const accounts: FinanceAccount[] = [{ id: BANK, name: 'Main Bank', kind: 'bank', bank_name: 'Maybank', currency: 'MYR' }];
const receivable = receivableInvoices(ALL, []);
const fresh = (): ReceiptForm => ({ ...newReceiptForm(receivable, accounts, TODAY), customerId: AISYAH });
const usd = receivable.find((i) => i.id === USD_ID)!;
const usd2 = receivable.find((i) => i.id === USD2_ID)!;
const sgd = receivable.find((i) => i.id === SGD_ID)!;
const myr = receivable.find((i) => i.id === MYR_ID)!;
const jpy = receivable.find((i) => i.id === JPY_ID)!;

describe('the payment form, one currency at a time', () => {
  it('offers invoices in every currency, each with its rate and the ringgit it still carries', () => {
    expect(receivable.map((i) => i.id)).toEqual([MYR_ID, USD_ID, USD2_ID, SGD_ID, JPY_ID]);
    expect(usd).toMatchObject({ currency: 'USD', fx_rate_text: '4.2000000000', payable: 680, balance_myr: 2856 });
    expect(PAYMENT_IN_KIND.owed(usd)).toBe('USD 680.00 owed (≈ RM 2,856.00 still carried)');
    expect(PAYMENT_IN_KIND.owed(myr)).toBe('RM 100.00 owed');
  });

  it('lists only the ticked currency once one is ticked, and every currency when none is', () => {
    const form = toggleInvoice(fresh(), usd, true);
    expect(offeredInvoices(form, receivable).map((i) => i.id)).toEqual([USD_ID, USD2_ID]);
    expect(PAYMENT_IN_KIND.currency?.of(form)).toBe('USD');
    const cleared = toggleInvoice(form, usd, false);
    expect(offeredInvoices(cleared, receivable)).toHaveLength(5);
    // Tick all ticks the offered currency's invoices only.
    expect(Object.keys(toggleAllInvoices(form, offeredInvoices(form, receivable), true).amounts)).toEqual([USD_ID, USD2_ID]);
  });

  it('says what Tick all does while nothing is ticked over invoices in several currencies', () => {
    expect(currencyListNotes(fresh(), receivable)).toEqual([
      'One payment settles invoices in one currency: Tick all ticks the MYR invoices, and ticking one invoice lists only those in its currency.',
    ]);
    expect(currencyListNotes(toggleInvoice(fresh(), usd, true), receivable)).toEqual([]);
    expect(currencyListNotes(fresh(), receivable.filter((i) => i.currency === 'USD'))).toEqual([]);
  });

  it('starts again when an invoice in another currency is ticked', () => {
    const form = withRinggit(toggleInvoice(fresh(), usd, true), '1658');
    const now = toggleInvoice(form, sgd, true);
    expect(Object.keys(now.amounts)).toEqual([SGD_ID]);
    expect(now).toMatchObject({ currency: 'SGD', ringgit: '' });
  });

  it('asks for the ringgit received for a foreign invoice, and not for a ringgit one', () => {
    const form = toggleInvoice(fresh(), usd, true);
    expect(PAYMENT_IN_KIND.currency?.ringgit.needed(form)).toBe(true);
    expect(receiptFormError(form, receivable)).toBe(RECEIPT_MESSAGES.ringgitReceived);
    expect(receiptFormError(withRinggit(form, '0.00'), receivable)).toBe(RECEIPT_MESSAGES.ringgitReceived);
    expect(receiptFormError(withRinggit(form, '1,658.00'), receivable)).toBeNull();
    const ringgit = toggleInvoice(fresh(), myr, true);
    expect(PAYMENT_IN_KIND.currency?.ringgit.needed(ringgit)).toBe(false);
    expect(receiptFormError(ringgit, receivable)).toBeNull();
    expect(receiptPayload(ringgit)).not.toHaveProperty('amount_myr');
  });

  it('sends the ringgit as the text typed, commas dropped, and the amounts in the invoice’s currency', () => {
    const form = withRinggit({ ...toggleInvoice(fresh(), usd, true), amounts: { [USD_ID]: '400' } }, '1,658.00');
    expect(receiptPayload(form)).toMatchObject({ amount_myr: '1658.00', allocations: [{ invoice_id: USD_ID, amount: 400 }] });
    expect(recordPaymentInInput.parse(receiptPayload(form)).amount_myr).toBe('1658.00');
  });

  it('previews example B’s payments: a loss of 22.00, then the closing gain of 27.50', () => {
    const first = withRinggit({ ...toggleInvoice(fresh(), usd2, true), amounts: { [USD2_ID]: '400' } }, '1658');
    expect(receiptPreview(first, receivable)).toEqual([
      'The invoice carries about RM 1,680.00 for what is paid.',
      'Realised exchange loss of about RM 22.00.',
    ]);
    const closing = withRinggit(toggleInvoice(fresh(), usd, true), '2883.50');
    expect(receiptPreview(closing, receivable)).toEqual([
      'The invoice carries about RM 2,856.00 for what is paid.',
      'Realised exchange gain of about RM 27.50.',
    ]);
    expect(receiptPreview(toggleInvoice(fresh(), myr, true), receivable)).toEqual([]);
  });

  it('asks for whole yen', () => {
    const form = withRinggit({ ...toggleInvoice(fresh(), jpy, true), amounts: { [JPY_ID]: '100.5' } }, '2900');
    expect(receiptFormError(form, receivable)).toBe('JPY has no cents: enter whole amounts.');
  });
});

describe('the forms that do not take a foreign invoice in 3b', () => {
  it('Cash Receipts offers ringgit invoices only (FIN45)', () => {
    expect(receivableFor(ALL, []).map((i) => i.id)).toEqual([MYR_ID]);
    expect(CASH_RECEIPT_MESSAGES.foreignInvoice).toBe('A receipt for an invoice in another currency is recorded with Record payment on Invoices.');
  });
  it('a contra entry sets off ringgit invoices only (FIN42)', () => {
    const parties = contraParties(
      [{ id: AISYAH, name: 'Aisyah Trading', is_customer: true, is_supplier: true, active: true }],
      receivable,
      [{ id: 'b1', bill_no: 'BILL-1', supplier_id: AISYAH, supplier_name: 'Aisyah Trading', purchase_order_id: null, currency: 'MYR', due_date: '2026-10-30', overdue: false, balance: 50, scheduled: 0, payable: 50 }],
    );
    expect(parties[0].invoices.map((i) => i.id)).toEqual([MYR_ID]);
  });
});

/* ---- the data layer and the assistant ------------------------------------------ */

function fakeClient(currencies: Record<string, string>, accounts: Record<string, string> = {}) {
  const calls: { kind: string; payload: unknown }[] = [];
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ kind: `rpc:${name}`, payload: args });
      return { data: 'txn-1', error: null };
    },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let ids: string[] = [];
      let id = '';
      q.select = () => q;
      q.eq = (column: string, value: string) => {
        if (column === 'id') id = value;
        return q;
      };
      q.maybeSingle = () => {
        // Stage 5a: the assistant reads the account's currency first.
        calls.push({ kind: `read:${table}`, payload: id });
        return Promise.resolve({ data: { id, currency: accounts[id] ?? 'MYR' }, error: null });
      };
      q.in = (_col: string, values: string[]) => {
        ids = values;
        calls.push({ kind: `read:${table}`, payload: values });
        return Promise.resolve({ data: ids.map((id) => ({ id, currency: currencies[id] })), error: null });
      };
      return q;
    },
  };
  return { client: client as never, calls };
}

const payment = { account_id: BANK, txn_date: TODAY, method: 'fpx' as const };

describe('recording a payment in', () => {
  it('sends the ringgit received only when there is one, and maps FIN44 and FIN46 to their sentences', async () => {
    const { client, calls } = fakeClient({});
    await recordPaymentIn({ client, orgId: 'org1' }, { ...payment, amount_myr: '1658', allocations: [{ invoice_id: USD_ID, amount: 400 }] });
    await recordPaymentIn({ client, orgId: 'org1' }, { ...payment, allocations: [{ invoice_id: MYR_ID, amount: 100 }] });
    const sent = calls.map((c) => (c.payload as { payment: object }).payment);
    expect(sent[0]).toMatchObject({ amount_myr: '1658' });
    expect(sent[1]).not.toHaveProperty('amount_myr');
    for (const [code, sentence] of [['FIN44', RECEIPT_MESSAGES.oneCurrency], ['FIN46', RECEIPT_MESSAGES.ringgitReceived]]) {
      const failing = { rpc: async () => ({ data: null, error: { code, message: 'x' } }) } as never;
      expect(await recordPaymentIn({ client: failing, orgId: 'org1' }, { ...payment, allocations: [{ invoice_id: USD_ID, amount: 1 }] })).toEqual({
        ok: false,
        error: sentence,
      });
    }
  });

  it('refuses a ringgit figure that is not money above 0', () => {
    for (const bad of ['0', '0.00', '1.005', '1,658', 'NaN', '-5']) {
      expect(recordPaymentInInput.safeParse({ ...payment, amount_myr: bad, allocations: [{ invoice_id: USD_ID, amount: 1 }] }).success, bad).toBe(false);
    }
  });
});

describe('the assistant records payments in ringgit only', () => {
  it('is offered no ringgit-received figure', () => {
    const { client } = fakeClient({});
    const tools = createBendaharaTools({ client, orgId: 'org1', canWrite: true }) as unknown as Record<string, { inputSchema: z.ZodType }>;
    const schema = z.toJSONSchema(tools.recordPaymentIn.inputSchema, { unrepresentable: 'any', io: 'input' }) as { properties: object };
    expect(Object.keys(schema.properties)).not.toContain('amount_myr');
    expect(recordPaymentInToolInput.parse({ ...payment, amount_myr: '5', allocations: [{ invoice_id: MYR_ID, amount: 1 }] })).not.toHaveProperty('amount_myr');
  });

  it('refuses an invoice in another currency in its own words, and records nothing', async () => {
    const { client, calls } = fakeClient({ [MYR_ID]: 'MYR', [USD_ID]: 'USD' });
    expect(
      await recordPaymentInRinggit({ client, orgId: 'org1' }, { ...payment, allocations: [{ invoice_id: MYR_ID, amount: 1 }, { invoice_id: USD_ID, amount: 1 }] }),
    ).toEqual({ ok: false, error: 'This invoice is not in ringgit. Record its payment on the Invoices screen.' });
    expect(calls.map((c) => c.kind)).toEqual(['read:finance_accounts', 'read:finance_invoices']);
  });

  it('records a ringgit one', async () => {
    const { client, calls } = fakeClient({ [MYR_ID]: 'MYR' });
    expect(await recordPaymentInRinggit({ client, orgId: 'org1' }, { ...payment, allocations: [{ invoice_id: MYR_ID, amount: 100 }] })).toEqual({
      ok: true,
      data: { id: 'txn-1' },
    });
    expect(calls.map((c) => c.kind)).toEqual(['read:finance_accounts', 'read:finance_invoices', 'rpc:finance_record_payment_in']);
  });

  it('refuses money into an account in another currency in its own words, before anything else (stage 5a)', async () => {
    const { client, calls } = fakeClient({ [MYR_ID]: 'MYR' }, { [BANK]: 'USD' });
    expect(await recordPaymentInRinggit({ client, orgId: 'org1' }, { ...payment, allocations: [{ invoice_id: MYR_ID, amount: 100 }] })).toEqual({
      ok: false,
      error: 'This account is not in ringgit. Record this on the screen, where its currency and rate are shown.',
    });
    expect(calls.map((c) => c.kind)).toEqual(['read:finance_accounts']);
  });
});

/* ---- every figure that adds payments up is in ringgit ----------------------------- */

const row = (p: Partial<PaymentInRow>): PaymentInRow => ({
  allocation_id: 'a', transaction_id: 't', number: 'RC-1', txn_date: '2026-10-12', method: 'fpx', amount: 100,
  transaction_amount: 100, status: 'posted', reference: null, account_id: BANK, account_name: 'Main Bank',
  invoice_id: MYR_ID, invoice_no: 'INV-1', customer_name: 'Aisyah Trading', ...p,
});
const MYR_PAY = row({ allocation_id: 'a1', transaction_id: 't1' });
const USD_PAY = row({
  allocation_id: 'a2', transaction_id: 't2', amount: 400, transaction_amount: 1658, invoice_id: USD_ID, invoice_no: 'INV-2',
  currency: 'USD', amount_myr: 1658, carried_myr: 1680, realised_myr: -22,
});

describe('payments added up', () => {
  it('count a foreign payment at the ringgit it brought', () => {
    expect(paymentInRinggit(USD_PAY)).toBe(1658);
    expect(paymentInRinggit(MYR_PAY)).toBe(100);
    expect(paymentInRinggit({ amount: 5, currency: 'USD', amount_myr: null })).toBe(0);
  });

  it('on Payments In: received this month, the trend and the methods', () => {
    const view = paymentsInView([MYR_PAY, USD_PAY], TODAY);
    expect(view.stats[0]).toMatchObject({ label: 'Received (MTD)', value: 'RM 1,758' });
    expect(view.byMethod.find((s) => s.key === 'fpx')?.value).toBe(1758);
  });

  it('in the export, with the currency, the ringgit and the realised difference once a payment is foreign', () => {
    const lines = paymentsInCsv([MYR_PAY, USD_PAY]).replace(/^﻿/, '').split(/\r?\n/);
    expect(lines[0]).toBe('Date,No.,Customer,Invoice,Account,Method,Amount,Status,Currency,Amount (RM),Carried (RM),Realised (RM)');
    expect(lines[1]).toContain(',100,Received,MYR,100,100,0');
    expect(lines[2]).toContain(',400,Received,USD,1658,1680,-22');
    expect(paymentsInCsv([MYR_PAY]).replace(/^﻿/, '').split(/\r?\n/)[0]).toBe('Date,No.,Customer,Invoice,Account,Method,Amount,Status');
  });

  it('on Kasturi’s Billings: received is what the payments carried off, in ringgit', () => {
    expect(invoicePaidRinggit(USD_ROW)).toBe(1680);
    expect(invoicePaidRinggit({ paid: 5, currency: 'USD' })).toBe(0);
    const billings = buildBillings([MYR_ROW, USD_ROW], new Date('2026-10-18T04:00:00Z'));
    expect(billings.stats.received).toBe(1680);
  });
});
