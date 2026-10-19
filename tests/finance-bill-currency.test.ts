import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBendaharaTools } from '@/lib/ai/finance-tools';
import {
  BILL_FORM_KIND,
  billCurrencyLock,
  billFormError,
  billFormFromDetail,
  billPayload,
  newBillForm,
  withPurchaseOrder,
  withSupplier,
} from '@/lib/finance/bill-form';
import {
  BILL_MESSAGES,
  type BillDetail,
  type BillListRow,
  billRinggit,
  postBill,
  saveBill,
  saveBillInRinggit,
  saveBillInput,
  saveBillToolInput,
} from '@/lib/finance/bills';
import { listBillBalances } from '@/lib/finance/contacts';
import { contraParties } from '@/lib/finance/contra-form';
import { CONTRA_MESSAGES, saveContra } from '@/lib/finance/contras';
import { ringgitTotal, withCurrency, withRateAnswer, withRateProvider, withRateReference, withRateTyped } from '@/lib/finance/document-currency';
import { type LineDraft, emptyLine } from '@/lib/finance/document-form';
import type { FxDefault } from '@/lib/finance/fx-rates';
import { MONEY_MESSAGES, type PaymentOutRow, recordPaymentOut } from '@/lib/finance/money';
import { buildFinanceOverview } from '@/lib/finance/overview';
import { payableBills } from '@/lib/finance/payment-form';
import { billsCsv, billsView } from '@/lib/finance/purchase-views';
import { attachCandidates, filterAttachCandidates, sameAmount } from '@/lib/finance/receipt-match';
import { listOpenBills } from '@/lib/finance/reports-data';
import { openPayables } from '@/lib/finance/reports';
import { voucherPayableBills } from '@/lib/finance/voucher-form';
import { VOUCHER_MESSAGES, saveVoucher } from '@/lib/finance/vouchers';
import { ringgitBill } from './helpers/bill-rows';
import { fakeFinance } from './setup/fake-finance';

const SUPPLIER = '6a9c1c7e-2f0b-4a67-9a53-0d4a8f1f6e11';
const DRAFT = '0b6f3f6e-5d0e-4b0f-8f55-1d4b2f2f9a22';
const ORDER = '1c7f4a0e-5d0e-4b0f-8f55-1d4b2f2f9a33';
const ACCOUNT = '2d8a5b1f-5d0e-4b0f-8f55-1d4b2f2f9a44';
const TODAY = '2026-10-18';
const USD_SELLING: FxDefault = { rate: 4.083, rate_text: '4.0830000000', rate_date: '2026-10-15', unit: 1, published_rate: 4.083, figure: 'selling' };

const line = (description: string, quantity: string, unit_price: string, sst_rate = '0'): LineDraft => ({
  ...emptyLine(description),
  description,
  quantity,
  unit_price,
  sst_rate,
});

/** A bill form in USD, with a supplier and one line, answered by BNM with `bnm` for the bill date. */
function usdForm(bnm: FxDefault | null) {
  const form = { ...withSupplier(newBillForm(TODAY, 'k1'), { id: SUPPLIER, payment_terms_days: 30 }), lines: [line('Machine', '1', '1000', '8')] };
  const fx = withCurrency(form.fx, 'USD', true);
  return { ...form, fx: withRateAnswer(fx, TODAY, `USD|${TODAY}`, { ok: true, rate: bnm }, true) };
}

/* ---- the data layer -------------------------------------------------------- */

const bill = { supplier_id: SUPPLIER, bill_date: TODAY, due_date: TODAY, lines: [{ description: 'Machine', quantity: 1, unit_price: 1000, sst_rate: 8 }] };
const typed = { currency: 'USD', fx_rate: '4.2', fx_rate_source: 'manual', fx_rate_provider: 'malaysian_bank', fx_rate_reference: 'Maybank' };
const first = (value: unknown) => saveBillInput.safeParse(value).error?.issues[0]?.message;

describe('saveBillInput', () => {
  it('takes a USD bill with a typed rate and where it came from', () => {
    expect(saveBillInput.parse({ ...bill, ...typed })).toMatchObject({
      currency: 'USD', fx_rate: '4.2', fx_rate_source: 'manual', fx_rate_provider: 'malaysian_bank', fx_rate_reference: 'Maybank',
    });
  });
  it('asks where a typed rate came from, and a bank its name', () => {
    expect(first({ ...bill, ...typed, fx_rate_provider: null })).toBe(BILL_MESSAGES.rateSource);
    expect(first({ ...bill, ...typed, fx_rate_reference: '  ' })).toBe(BILL_MESSAGES.rateSource);
    expect(BILL_MESSAGES.rateSource).toBe('Say where this rate comes from: choose a source, and name the bank or the approval reference.');
  });
  it('refuses cents in a currency with none', () => {
    expect(first({ ...bill, currency: 'JPY', fx_rate: '0.02582', fx_rate_source: 'manual', fx_rate_provider: 'reuters', lines: [{ ...bill.lines[0], unit_price: 1.5 }] }))
      .toBe('JPY has no cents: enter whole amounts.');
  });
  it('sends none of the currency keys when none is given', () => {
    expect(Object.keys(saveBillInput.parse(bill))).not.toContain('currency');
  });
});

describe('the assistant and bills', () => {
  const KEYS = ['currency', 'fx_rate', 'fx_rate_source', 'fx_rate_date', 'fx_rate_provider', 'fx_rate_reference'];
  function stored(currency: string | null) {
    return fakeFinance((call) =>
      call.kind === 'rpc' ? { data: DRAFT, error: null } : { data: currency === null ? null : { currency }, error: null },
    );
  }
  it('is offered no currency, rate or source', () => {
    const { ctx } = stored(null);
    const tools = createBendaharaTools({ ...ctx, canWrite: true }) as unknown as Record<string, { inputSchema: z.ZodType }>;
    const schema = z.toJSONSchema(tools.saveBill.inputSchema, { unrepresentable: 'any', io: 'input' }) as { properties: object };
    for (const key of KEYS) expect(Object.keys(schema.properties), key).not.toContain(key);
    expect(Object.keys(saveBillToolInput.parse({ ...bill, ...typed }))).not.toContain('currency');
  });
  it('writes a new bill with none of them, even when the call carries them', async () => {
    const { ctx, calls } = stored(null);
    expect(await saveBillInRinggit(ctx, { ...bill, ...typed })).toEqual({ ok: true, data: { id: DRAFT } });
    const sent = calls.find((c) => c.name === 'finance_save_bill')!.args!.bill as object;
    for (const key of KEYS) expect(Object.keys(sent), key).not.toContain(key);
  });
  it('refuses to edit a draft in another currency, and writes nothing', async () => {
    const { ctx, calls } = stored('USD');
    expect(await saveBillInRinggit(ctx, { ...bill, id: DRAFT })).toEqual({
      ok: false,
      error: 'This bill is not in ringgit. Edit it on the Supplier Bills screen, where its currency and exchange rate are shown.',
    });
    expect(calls.filter((c) => c.kind === 'rpc')).toEqual([]);
  });
  it('edits a ringgit draft', async () => {
    const { ctx, calls } = stored('MYR');
    expect(await saveBillInRinggit(ctx, { ...bill, id: DRAFT })).toEqual({ ok: true, data: { id: DRAFT } });
    expect(calls.filter((c) => c.kind === 'rpc').map((c) => c.name)).toEqual(['finance_save_bill']);
  });
});

describe('saving a bill', () => {
  it('holds a draft in JPY to whole amounts when the form sends no currency', async () => {
    const { ctx, calls } = fakeFinance((call) => (call.kind === 'rpc' ? { data: DRAFT, error: null } : { data: { currency: 'JPY' }, error: null }));
    expect(await saveBill(ctx, { ...bill, id: DRAFT, lines: [{ ...bill.lines[0], unit_price: 1.5 }] })).toEqual({
      ok: false,
      error: 'JPY has no cents: enter whole amounts.',
    });
    expect(calls.filter((c) => c.kind === 'rpc')).toEqual([]);
  });
  it('words what the database answers of a rate and an order', async () => {
    const cases: [string, string][] = [
      ['FIN38', 'Enter the exchange rate before posting.'],
      ['FIN39', "That rate is not Bank Negara Malaysia's 5 pm selling rate for the bill date. Type it in again with its source, and save."],
      ['FIN43', 'Say where this rate comes from: choose a source, and name the bank or the approval reference.'],
      ['FIN49', "A bill raised against a purchase order is in the order's currency."],
    ];
    for (const [code, sentence] of cases) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      expect(await postBill(ctx, { id: DRAFT }), code).toEqual({ ok: false, error: sentence });
    }
  });
});

describe('a bill in ringgit, for every adder', () => {
  it('is its ringgit, and a foreign draft with no rate counts nothing', () => {
    expect(billRinggit({ total_myr: 4536, balance_myr: 4536 })).toEqual({ total: 4536, balance: 4536 });
    expect(billRinggit({ total_myr: null, balance_myr: null })).toEqual({ total: 0, balance: 0 });
  });
});

/* ---- the form --------------------------------------------------------------- */

describe('the bill form in another currency', () => {
  it('is offered the selling rate for the bill date, and sends it as BNM’s', () => {
    const form = usdForm(USD_SELLING);
    expect(form.fx).toMatchObject({ rate: '4.083', rateSource: 'bnm', rateDate: '2026-10-15' });
    expect(billPayload(form)).toMatchObject({
      currency: 'USD', fx_rate: '4.083', fx_rate_source: 'bnm', fx_rate_date: '2026-10-15', fx_rate_provider: null, fx_rate_reference: null,
    });
    expect(BILL_FORM_KIND.currency).toMatchObject({ figure: 'selling', sources: true });
  });
  it('sends a typed rate with where it came from', () => {
    const form = usdForm(USD_SELLING);
    const fx = withRateReference(withRateProvider(withRateTyped(form.fx, '4.2'), 'malaysian_bank'), 'Maybank');
    expect(billPayload({ ...form, fx })).toMatchObject(typed);
  });
  it('sends a ringgit bill as MYR alone', () => {
    const form = withSupplier(newBillForm(TODAY, 'k1'), { id: SUPPLIER, payment_terms_days: 30 });
    expect(billPayload(form)).toMatchObject({ currency: 'MYR', fx_rate: null, fx_rate_source: null, fx_rate_date: null });
  });
  it('asks for the rate before posting, and for a typed rate’s source', () => {
    const none = usdForm(null);
    expect(billFormError(none)).toBeNull();
    expect(billFormError(none, true)).toBe('Enter the exchange rate before posting.');
    const typedOnly = { ...none, fx: withRateTyped(none.fx, '4.2') };
    expect(billFormError(typedOnly)).toBe(BILL_MESSAGES.rateSource);
  });
  it('takes the supplier’s default currency on a new bill', () => {
    const form = withSupplier(newBillForm(TODAY, 'k1'), { id: SUPPLIER, payment_terms_days: 30, default_currency: 'SGD' });
    expect(form.fx.currency).toBe('SGD');
  });
  it('keeps a bill with a purchase order in the order’s currency, and says so', () => {
    const form = usdForm(USD_SELLING);
    expect(billCurrencyLock(form)).toBeNull();
    const linked = withPurchaseOrder(form, ORDER);
    expect(linked.purchase_order_id).toBe(ORDER);
    expect(linked.fx.currency).toBe('MYR');
    expect(billCurrencyLock(linked)).toBe('In the order’s currency.');
    // A supplier's default does not move it.
    expect(withSupplier(linked, { id: SUPPLIER, payment_terms_days: 30, default_currency: 'SGD' }).fx.currency).toBe('MYR');
    expect(billCurrencyLock(withPurchaseOrder(linked, ''))).toBeNull();
  });
  it('works out the ringgit total line by line: 3 × USD 33.33 at 4.2555 is RM 425.52', () => {
    const form = usdForm(null);
    const fx = withRateTyped(form.fx, '4.2555');
    expect(ringgitTotal(fx, [line('a', '1', '33.33'), line('b', '1', '33.33'), line('c', '1', '33.33')])).toBe(425.52);
  });
  it('opens a saved foreign draft with its rate and source', () => {
    const detail: BillDetail = ringgitBill({
      id: DRAFT, bill_no: null, supplier_id: SUPPLIER, supplier_name: 'Acme Pte Ltd', bill_date: TODAY, due_date: TODAY,
      total: 1080, paid: 0, balance: 1080, display_status: 'draft', purchase_order_id: null, purchase_order_no: null,
      category_id: null, category_name: null, supplier_ref: null, notes: null, lines: [],
      currency: 'USD', fx_rate: 4.2, fx_rate_text: '4.2000000000', fx_rate_source: 'manual', fx_rate_provider: 'malaysian_bank',
      fx_rate_reference: 'Maybank', total_myr: 4536, balance_myr: 4536,
    });
    expect(billFormFromDetail(detail).fx).toMatchObject({ currency: 'USD', rate: '4.2', rateSource: 'manual', provider: 'malaysian_bank', reference: 'Maybank' });
  });
});

/* ---- every sum is in ringgit ------------------------------------------------ */

/** MYR 100.00 and USD 1,080.00 at 4.2 (RM 4,536.00), both open, one supplier; the ringgit sum is RM 4,636.00. */
const MYR_BILL: BillListRow = ringgitBill({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', bill_no: 'BILL-1', supplier_id: SUPPLIER, supplier_name: 'Lim Hardware',
  bill_date: '2026-10-05', due_date: '2026-10-20', total: 100, paid: 0, balance: 100, display_status: 'pending',
  purchase_order_id: null, purchase_order_no: null, category_id: null, category_name: null,
});
const USD_BILL: BillListRow = ringgitBill({
  ...MYR_BILL, id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002', bill_no: 'BILL-2', total: 1080, balance: 1080,
  currency: 'USD', fx_rate: 4.2, fx_rate_text: '4.2000000000', fx_rate_source: 'manual', fx_rate_provider: 'malaysian_bank',
  fx_rate_reference: 'Maybank', subtotal_myr: 4200, sst_myr: 336, total_myr: 4536, balance_myr: 4536,
});
const BOTH = [MYR_BILL, USD_BILL];
const NO_PAYMENTS: PaymentOutRow[] = [];

describe('adding bills up', () => {
  it('on the overview', () => {
    const overview = buildFinanceOverview([], BOTH, TODAY);
    expect(overview.payable.total).toBe(4636);
    expect(overview.unpaidBills.map((b) => b.balance)).toEqual([100, 4536]);
  });
  it('on the Supplier Bills KPIs and the largest suppliers', () => {
    const view = billsView(BOTH, NO_PAYMENTS, TODAY);
    expect(view.stats[0]).toMatchObject({ label: 'Total payable', value: 'RM 4,636' });
    expect(view.bySupplier).toEqual([{ label: 'Lim Hardware', value: 4636 }]);
  });
  it('on the aged payables and the Contacts payable, read in ringgit', async () => {
    const aged = fakeFinance({ data: [{ supplier_id: SUPPLIER, supplier_name: 'Lim', due_date: TODAY, balance: '4536.00', display_status: 'pending' }], error: null });
    const rows = await listOpenBills(aged.ctx);
    expect(aged.calls[0].columns).toBe('supplier_id,supplier_name,due_date,balance:balance_myr,display_status');
    // The filter stays on the bill's own balance: PostgREST filters by column, not by the alias.
    expect(aged.calls[0].filters).toMatchObject({ 'balance gt': 0 });
    expect(openPayables(rows)[0].balance).toBe(4536);
    const contacts = fakeFinance({ data: [], error: null });
    await listBillBalances(contacts.ctx);
    expect(contacts.calls[0].columns).toBe('supplier_id, balance:balance_myr, display_status');
  });
  it('in the CSV, with the currency columns once a bill is foreign', () => {
    expect(billsCsv([MYR_BILL]).split('\n')[0]).not.toContain('Currency');
    const csv = billsCsv(BOTH).split('\n');
    expect(csv[0]).toContain('Currency,Rate (RM per unit),Total (RM),Balance (RM),Rate source');
    expect(csv[2]).toContain('USD,4.2000000000,4536,4536,A bank in Malaysia: Maybank');
  });
});

describe('what may pay a foreign bill in stage 4', () => {
  it('Payments Out offers it (stage 4b); a voucher and a contra entry offer ringgit bills only', () => {
    expect(payableBills(BOTH, NO_PAYMENTS).map((b) => b.id).sort()).toEqual([MYR_BILL.id, USD_BILL.id].sort());
    expect(voucherPayableBills(BOTH, NO_PAYMENTS, null).map((b) => b.id)).toEqual([MYR_BILL.id]);
    const payable = payableBills(BOTH, NO_PAYMENTS).filter((b) => b.currency === 'MYR');
    expect(payable[0].currency).toBe('MYR');
    // Even if a foreign bill were offered to the contra form, it would not take it.
    const withForeign = [...payable, { ...payable[0], id: USD_BILL.id, currency: 'USD' }];
    const parties = contraParties(
      [{ id: SUPPLIER, name: 'Lim Hardware', active: true, is_customer: true, is_supplier: true }],
      [{ id: 'inv-1', invoice_no: 'INV-1', customer_id: SUPPLIER, customer_name: 'Lim', due_date: TODAY, overdue: false, balance: 10, held: 0, payable: 10, currency: 'MYR' }] as never,
      withForeign,
    );
    expect(parties[0].bills.map((b) => b.id)).toEqual([MYR_BILL.id]);
  });
  // Stage 4b retired FIN41: a foreign bill is paid now on Payments Out (FIN46/FIN47), never through a voucher (FIN47).
  it('words FIN47 and FIN44 on Payments Out, FIN47 on a voucher, FIN42 on a contra entry', async () => {
    const payment = { account_id: ACCOUNT, txn_date: TODAY, method: 'fpx' as const, allocations: [{ bill_id: USD_BILL.id, amount: 10 }] };
    expect(await recordPaymentOut(fakeFinance({ data: null, error: { code: 'FIN47' } }).ctx, payment)).toEqual({
      ok: false, error: MONEY_MESSAGES.payNow,
    });
    expect(await recordPaymentOut(fakeFinance({ data: null, error: { code: 'FIN44' } }).ctx, payment)).toEqual({
      ok: false, error: MONEY_MESSAGES.oneCurrency,
    });
    expect(MONEY_MESSAGES.oneCurrency).toBe('One payment can only settle bills in one currency. Record a separate payment for each currency.');
    const voucher = { kind: 'bills' as const, account_id: ACCOUNT, txn_date: TODAY, method: 'fpx' as const, allocations: [{ bill_id: USD_BILL.id, amount: 10 }] };
    expect(await saveVoucher(fakeFinance({ data: null, error: { code: 'FIN47' } }).ctx, voucher)).toEqual({
      ok: false, error: VOUCHER_MESSAGES.foreignBill,
    });
    expect(CONTRA_MESSAGES.foreignInvoice).toBe('A contra entry can only set off invoices and bills in ringgit.');
    const contra = { contact_id: SUPPLIER, contra_date: TODAY, amount: 10, invoices: [{ invoice_id: DRAFT, amount: 10 }], bills: [{ bill_id: USD_BILL.id, amount: 10 }] };
    expect(await saveContra(fakeFinance({ data: null, error: { code: 'FIN42' } }).ctx, contra)).toEqual({
      ok: false, error: 'A contra entry can only set off invoices and bills in ringgit.',
    });
  });
});

describe('attaching a receipt to a bill', () => {
  it('shows a foreign bill in its own currency and never as the same amount', () => {
    const candidates = attachCandidates([], [{ ...USD_BILL, total: 100 }, MYR_BILL]);
    const usd = candidates.find((c) => c.id === USD_BILL.id)!;
    expect(usd).toMatchObject({ amount: 100, currency: 'USD' });
    expect(sameAmount(usd, 100)).toBe(false);
    const myr = candidates.find((c) => c.id === MYR_BILL.id)!;
    expect(sameAmount(myr, 100)).toBe(true);
    expect(filterAttachCandidates(candidates, 'bill', 'USD 100.00', 100).map((c) => c.id)).toEqual([USD_BILL.id]);
  });
});
