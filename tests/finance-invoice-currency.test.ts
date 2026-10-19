import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBendaharaTools } from '@/lib/ai/finance-tools';
import { buildBillings } from '@/lib/crm/billings';
import { dealBilling } from '@/lib/crm/invoice-links';
import { receiptInvoicesForForm } from '@/lib/finance/cash-receipt-form';
import { creditableInvoices } from '@/lib/finance/credit-note-form';
import {
  CURRENCY_MESSAGES,
  currencyPayload,
  rateNotes,
  ringgitTotal,
  sourceError,
  withCurrency,
  withRateAnswer,
  withRateProvider,
  withRateReference,
  withRateTyped,
} from '@/lib/finance/document-currency';
import { type LineDraft, emptyLine } from '@/lib/finance/document-form';
import type { FxDefault } from '@/lib/finance/fx-rates';
import {
  INVOICE_FORM_KIND,
  invoiceFormError,
  invoiceFormFromDetail,
  invoicePayload,
  invoiceRateDate,
  newInvoiceForm,
  withCustomer,
  withSupplyDate,
} from '@/lib/finance/invoice-form';
import {
  INVOICE_MESSAGES,
  type InvoiceDetail,
  type InvoiceListRow,
  invoiceRinggit,
  saveInvoiceInRinggit,
  saveInvoiceInput,
  saveInvoiceToolInput,
} from '@/lib/finance/invoices';
import { buildFinanceOverview } from '@/lib/finance/overview';
import { receivableInvoices } from '@/lib/finance/receipt-form';
import { refundTargets } from '@/lib/finance/refund-form';
import { invoicesCsv, invoicesView, rateSourceWords } from '@/lib/finance/sales-views';
import { ringgitRow } from './helpers/invoice-rows';

const CUSTOMER = '6a9c1c7e-2f0b-4a67-9a53-0d4a8f1f6e11';
const DRAFT = '0b6f3f6e-5d0e-4b0f-8f55-1d4b2f2f9a22';
const TODAY = '2026-10-18';
/** BNM's 5 pm selling rates as the SST read gives them: exact text per one unit. */
const USD_SELLING: FxDefault = { rate: 4.083, rate_text: '4.0830000000', rate_date: '2026-10-15', unit: 1, published_rate: 4.083, figure: 'selling' };
const JPY_SELLING: FxDefault = { rate: 0.02582, rate_text: '0.0258200000', rate_date: '2026-10-16', unit: 100, published_rate: 2.582, figure: 'selling' };

/** An invoice form in `code` answered by BNM with `bnm` for the date the rate is for. */
function answeredForm(code: string, bnm: FxDefault | null) {
  const form = withCustomer(newInvoiceForm(TODAY, 'k1'), { id: CUSTOMER, payment_terms_days: 30 });
  const fx = withCurrency(form.fx, code, true);
  const date = invoiceRateDate({ ...form, fx });
  return { ...form, fx: withRateAnswer(fx, date, `${code}|${date}`, { ok: true, rate: bnm }, true) };
}
const line = (description: string, quantity: string, unit_price: string, sst_rate = '0'): LineDraft => ({
  ...emptyLine(description),
  description,
  quantity,
  unit_price,
  sst_rate,
});

describe('the rate an invoice is offered', () => {
  it('is the selling rate, put in the box from its exact text and sent back unchanged', () => {
    const usd = answeredForm('USD', USD_SELLING);
    expect(usd.fx).toMatchObject({ rate: '4.083', rateSource: 'bnm', rateDate: '2026-10-15' });
    expect(invoicePayload(usd)).toMatchObject({ currency: 'USD', fx_rate: '4.083', fx_rate_source: 'bnm', fx_rate_date: '2026-10-15' });
    // JPY is typed per 100: 2.582 in the box, 0.02582 per yen sent, which is SQL's round(2.582 / 100, 10).
    const jpy = answeredForm('JPY', JPY_SELLING);
    expect(jpy.fx.rate).toBe('2.582');
    expect(currencyPayload(jpy.fx).fx_rate).toBe('0.02582');
  });

  it('says it is the 5 pm selling rate, and the stale date when it is old', () => {
    const usd = answeredForm('USD', USD_SELLING);
    expect(rateNotes(usd.fx, TODAY, INVOICE_FORM_KIND.currency?.figure)).toEqual([
      "Bank Negara Malaysia's 5 pm selling rate of 15 October 2026.",
    ]);
  });

  it('is asked for the date of supply when one is typed, else the invoice date', () => {
    const usd = answeredForm('USD', USD_SELLING);
    expect(invoiceRateDate(usd)).toBe(TODAY);
    expect(invoiceRateDate(withSupplyDate(usd, '2026-10-14'))).toBe('2026-10-14');
    expect(INVOICE_FORM_KIND.rateDate?.(withSupplyDate(usd, '2026-10-14'))).toBe('2026-10-14');
    // A ringgit invoice has no rate, so a stray date of supply drives nothing and is not sent.
    const myr = withSupplyDate(newInvoiceForm(TODAY, 'k1'), '2026-10-14');
    expect(invoiceRateDate(myr)).toBe(TODAY);
    expect(invoicePayload(myr).supply_date).toBeNull();
    expect(invoicePayload(withSupplyDate(usd, '2026-10-14')).supply_date).toBe('2026-10-14');
  });

  it('typed back exactly, is BNM’s again', () => {
    const usd = answeredForm('USD', USD_SELLING);
    const typed = { ...usd, fx: withRateTyped(usd.fx, '4.2') };
    expect(typed.fx.rateSource).toBe('manual');
    expect(withRateTyped(typed.fx, '4.0830').rateSource).toBe('bnm');
  });
});

describe('a rate typed by hand names its source', () => {
  const typed = () => {
    const usd = answeredForm('USD', USD_SELLING);
    return { ...usd, lines: [line('Work', '1', '100')], fx: withRateTyped(usd.fx, '4.2') };
  };

  it('is refused with no source, and a bank needs its name', () => {
    const form = typed();
    expect(sourceError(form.fx)).toBe(CURRENCY_MESSAGES.rateSource);
    expect(invoiceFormError(form)).toBe(INVOICE_MESSAGES.rateSource);
    const bank = { ...form, fx: withRateProvider(form.fx, 'malaysian_bank') };
    expect(invoiceFormError(bank)).toBe(INVOICE_MESSAGES.rateSource);
    const named = { ...bank, fx: withRateReference(bank.fx, ' Maybank ') };
    expect(invoiceFormError(named)).toBeNull();
    expect(invoicePayload(named)).toMatchObject({ fx_rate: '4.2', fx_rate_source: 'manual', fx_rate_provider: 'malaysian_bank', fx_rate_reference: 'Maybank' });
  });

  it('needs no name for Reuters, and sends none for BNM’s own rate', () => {
    const reuters = { ...typed(), fx: withRateProvider(typed().fx, 'reuters') };
    expect(invoiceFormError(reuters)).toBeNull();
    expect(invoicePayload(reuters)).toMatchObject({ fx_rate_provider: 'reuters', fx_rate_reference: null });
    const bnm = answeredForm('USD', USD_SELLING);
    expect(invoicePayload({ ...bnm, fx: withRateProvider(bnm.fx, 'reuters') })).toMatchObject({ fx_rate_source: 'bnm', fx_rate_provider: null });
  });

  it('is held to the same rule by the schema, for a direct call', () => {
    const base = { customer_id: CUSTOMER, invoice_date: TODAY, due_date: TODAY, lines: [{ description: 'Work', quantity: 1, unit_price: 100 }] };
    const said = (v: object) => saveInvoiceInput.safeParse({ ...base, ...v }).error?.issues[0]?.message;
    expect(said({ currency: 'USD', fx_rate: '4.2', fx_rate_source: 'manual' })).toBe(INVOICE_MESSAGES.rateSource);
    expect(said({ currency: 'USD', fx_rate: '4.2', fx_rate_source: 'manual', fx_rate_provider: 'customs_approved' })).toBe(INVOICE_MESSAGES.rateSource);
    expect(said({ currency: 'USD', fx_rate: '4.2', fx_rate_source: 'manual', fx_rate_provider: 'customs_approved', fx_rate_reference: 'JKDM/2026/7' })).toBeUndefined();
    expect(said({ currency: 'USD', fx_rate: '4.083', fx_rate_source: 'bnm', fx_rate_date: '2026-10-15' })).toBeUndefined();
    expect(said({ currency: 'USD', fx_rate: null })).toBeUndefined();
    expect(said({ currency: 'MYR' })).toBeUndefined();
    // Longer than the e-Invoice's 15 characters: its own sentence, not the database's generic refusal.
    expect(said({ currency: 'USD', fx_rate: '12345.1234567891', fx_rate_source: 'manual', fx_rate_provider: 'oanda' })).toBe(INVOICE_MESSAGES.rateTooLong);
    expect(said({ currency: 'USD', fx_rate: '1234.1234567891', fx_rate_source: 'manual', fx_rate_provider: 'oanda' })).toBeUndefined();
    expect(said({ currency: 'USD', fx_rate: '4.2000000000', fx_rate_source: 'manual', fx_rate_provider: 'oanda' })).toBeUndefined();
  });
});

describe('a typed rate too long for the e-Invoice', () => {
  it('is refused by the form with its own sentence', () => {
    const usd = answeredForm('USD', null);
    const form = { ...usd, lines: [line('Work', '1', '100')], fx: withRateProvider(withRateTyped(usd.fx, '12345.1234567891'), 'oanda') };
    expect(invoiceFormError(form)).toBe(INVOICE_MESSAGES.rateTooLong);
  });
});

describe('posting a foreign invoice', () => {
  it('needs a rate, in the invoice’s own words', () => {
    const none = answeredForm('THB', null);
    const filled = { ...none, lines: [line('Work', '1', '100')] };
    expect(invoiceFormError(filled)).toBeNull();
    expect(invoiceFormError(filled, true)).toBe('Enter the exchange rate before posting.');
    expect(INVOICE_MESSAGES.rateBeforePosting).toBe('Enter the exchange rate before posting.');
  });
});

describe('the ringgit total of a foreign invoice', () => {
  it('rounds each line to the sen, as the database does: 3 × USD 33.33 at 4.2555 is RM 425.52', () => {
    const usd = answeredForm('USD', null);
    const fx = withRateTyped(usd.fx, '4.2555');
    expect(ringgitTotal(fx, [line('a', '1', '33.33'), line('b', '1', '33.33'), line('c', '1', '33.33')])).toBe(425.52);
  });
});

describe('discounted foreign lines', () => {
  it('agree with the database: RM 11,694.75 (supabase/tests/bendahara_invoice_currency_check.sql, case 29)', () => {
    const fx = withRateTyped(answeredForm('USD', null).fx, '4.2555');
    const lines = [
      { ...line('a', '3', '33.33', '8'), discount_pct: '10' },
      { ...line('b', '2', '1250.505', '6'), discount_amount: '0.10' },
    ];
    // 89.99 + 7.20 -> 382.95 + 30.64; 2500.91 + 150.05 -> 10,642.62 + 638.54.
    expect(ringgitTotal(fx, lines)).toBe(11694.75);
  });
});

describe('opening a saved foreign draft', () => {
  it('shows the rate from its exact text, its source and its date of supply', () => {
    const detail: InvoiceDetail = ringgitRow({
      id: DRAFT, invoice_no: null, customer_id: CUSTOMER, customer_name: 'Acme Pte Ltd', invoice_date: TODAY, due_date: TODAY,
      total: 100, paid: 0, credited: 0, refunded: 0, balance: 100, display_status: 'draft', einvoice_status: 'none', einvoice_uuid: null,
      subtotal: 100, sst: 0, notes: null, lines: [],
      currency: 'JPY', fx_rate: 0.0258, fx_rate_text: '0.0258200000', fx_rate_source: 'manual', fx_rate_date: null,
      fx_rate_provider: 'foreign_central_bank', fx_rate_reference: 'Bank of Japan', supply_date: '2026-10-14', total_myr: 2.58, balance_myr: 2.58,
    });
    const form = invoiceFormFromDetail(detail);
    expect(form.fx).toMatchObject({ currency: 'JPY', rate: '2.582', rateSource: 'manual', provider: 'foreign_central_bank', reference: 'Bank of Japan' });
    expect(form.supplyDate).toBe('2026-10-14');
  });
});

/* ---- the assistant writes ringgit ------------------------------------------- */

const KEYS = ['currency', 'fx_rate', 'fx_rate_source', 'fx_rate_date', 'fx_rate_provider', 'fx_rate_reference', 'supply_date'];

function fakeClient(storedCurrency: string | null) {
  const calls: { kind: string; payload: unknown }[] = [];
  const chain = (result: unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) q[m] = () => q;
    q.maybeSingle = async () => result;
    return q;
  };
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ kind: `rpc:${name}`, payload: args });
      return { data: DRAFT, error: null };
    },
    from: () => ({ select: () => chain({ data: storedCurrency === null ? null : { currency: storedCurrency }, error: null }) }),
  };
  return { client: client as never, calls };
}
const invoice = { customer_id: CUSTOMER, invoice_date: TODAY, due_date: TODAY, lines: [{ description: 'Design', quantity: 1, unit_price: 1000 }] };
const foreign = { currency: 'USD', fx_rate: '4.2', fx_rate_source: 'manual', fx_rate_provider: 'reuters', supply_date: '2026-10-14' };

describe('the assistant and invoices', () => {
  it('is offered no currency, rate, source or date of supply', () => {
    const { client } = fakeClient(null);
    const tools = createBendaharaTools({ client, orgId: 'org1', canWrite: true }) as unknown as Record<string, { inputSchema: z.ZodType }>;
    const schema = z.toJSONSchema(tools.saveInvoice.inputSchema, { unrepresentable: 'any', io: 'input' }) as { properties: object };
    for (const key of KEYS) expect(Object.keys(schema.properties), key).not.toContain(key);
    expect(Object.keys(saveInvoiceToolInput.parse({ ...invoice, ...foreign })).sort()).toEqual(['customer_id', 'due_date', 'invoice_date', 'lines', 'notes']);
  });

  it('writes a new invoice with none of them, even when the call carries them', async () => {
    const { client, calls } = fakeClient(null);
    expect(await saveInvoiceInRinggit({ client, orgId: 'org1' }, { ...invoice, ...foreign })).toEqual({ ok: true, data: { id: DRAFT } });
    const sent = calls.find((c) => c.kind === 'rpc:finance_save_invoice')!.payload as { invoice: object };
    for (const key of KEYS) expect(Object.keys(sent.invoice), key).not.toContain(key);
  });

  it('refuses to edit a draft in another currency, and writes nothing', async () => {
    const { client, calls } = fakeClient('USD');
    expect(await saveInvoiceInRinggit({ client, orgId: 'org1' }, { ...invoice, id: DRAFT })).toEqual({
      ok: false,
      error: 'This invoice is not in ringgit. Edit it on the Invoices screen, where its currency and exchange rate are shown.',
    });
    expect(calls).toEqual([]);
  });

  it('edits a ringgit draft', async () => {
    const { client, calls } = fakeClient('MYR');
    expect(await saveInvoiceInRinggit({ client, orgId: 'org1' }, { ...invoice, id: DRAFT })).toEqual({ ok: true, data: { id: DRAFT } });
    expect(calls.map((c) => c.kind)).toEqual(['rpc:finance_save_invoice']);
  });
});

/* ---- every sum is in ringgit ------------------------------------------------- */

/** MYR 100.00 and USD 1,080.00 at 4.2 (RM 4,536.00), both open; the ringgit sum is RM 4,636.00. */
const MYR_ROW: InvoiceListRow = ringgitRow({
  id: 'inv-myr', invoice_no: 'INV-1', customer_id: 'c1', customer_name: 'Aisyah Trading', invoice_date: '2026-10-05', due_date: '2026-10-20',
  total: 100, paid: 0, credited: 0, refunded: 0, balance: 100, display_status: 'sent', einvoice_status: 'none', einvoice_uuid: null,
});
const USD_ROW: InvoiceListRow = ringgitRow({
  ...MYR_ROW, id: 'inv-usd', invoice_no: 'INV-2', total: 1080, balance: 1080,
  currency: 'USD', fx_rate: 4.2, fx_rate_text: '4.2000000000', fx_rate_source: 'manual', fx_rate_provider: 'reuters',
  total_myr: 4536, balance_myr: 4536, sst_myr: 336,
});
const BOTH = [MYR_ROW, USD_ROW];

describe('adding invoices up', () => {
  it('takes each invoice’s ringgit, and a foreign draft with no rate as nothing', () => {
    expect(invoiceRinggit(USD_ROW)).toEqual({ total: 4536, balance: 4536 });
    expect(invoiceRinggit({ total_myr: null, balance_myr: null })).toEqual({ total: 0, balance: 0 });
  });

  it('on the overview', () => {
    const overview = buildFinanceOverview(BOTH, [], TODAY);
    expect(overview.receivable.total).toBe(4636);
    expect(overview.outstandingByCustomer).toEqual([{ label: 'Aisyah Trading', amount: 4636 }]);
  });

  it('on the Invoices KPIs and the trend', () => {
    const view = invoicesView(BOTH, [], TODAY);
    expect(view.stats[0]).toMatchObject({ label: 'Total receivable', value: 'RM 4,636' });
    expect(view.trend.at(-1)?.invoiced).toBe(4.6);
  });

  it('on Kasturi’s Billings and a deal’s billing', () => {
    const billings = buildBillings(BOTH, new Date('2026-10-18T04:00:00Z'));
    expect(billings.stats).toMatchObject({ billedThisMonth: 4636, outstanding: 4636 });
    expect(billings.topCustomers[0]).toMatchObject({ billed: 4636, outstanding: 4636 });
    expect(dealBilling([{ dealId: 'd', invoiceId: 'inv-myr' }, { dealId: 'd', invoiceId: 'inv-usd' }], BOTH)).toEqual({
      d: { count: 2, billed: 4636, outstanding: 4636 },
    });
  });

  it('exports each invoice in its currency, with its ringgit and its rate’s source once one is foreign', () => {
    const lines = invoicesCsv(BOTH).replace(/^﻿/, '').split(/\r?\n/);
    expect(lines[0]).toBe('No.,Date,Customer,Due,Total,Paid,Credited,Refunded,Balance,Status,e-Invois,Set off,Currency,Rate (RM per unit),Total (RM),Balance (RM),Rate source');
    expect(lines[2]).toContain(',USD,4.2000000000,4536,4536,Reuters');
    expect(invoicesCsv([MYR_ROW]).replace(/^﻿/, '').split(/\r?\n/)[0]).toBe('No.,Date,Customer,Due,Total,Paid,Credited,Refunded,Balance,Status,e-Invois,Set off');
    expect(rateSourceWords({ ...USD_ROW, fx_rate_source: 'bnm' })).toBe('Bank Negara Malaysia, 5 pm selling');
  });
});

describe('what settles a foreign invoice (3b: payments in; 3c: credit notes, refunds; FIN42, FIN45 for the rest)', () => {
  it('offers it to the payment, credit note and refund forms, not to receipts or contra entries', () => {
    // 3b: Record payment takes it, with the ringgit received (tests/finance-fx-payments-in.test.ts); 3c: a credit
    // note and a refund (tests/finance-fx-credit-notes-refunds.test.ts).
    expect(receivableInvoices(BOTH, []).map((i) => i.id)).toEqual(['inv-myr', 'inv-usd']);
    expect(receiptInvoicesForForm(BOTH).map((i) => i.id)).toEqual(['inv-myr']);
    expect(creditableInvoices(BOTH).map((i) => i.id)).toEqual(['inv-myr', 'inv-usd']);
    const inCredit = BOTH.map((i) => ({ ...i, balance: -10, balance_myr: -10, display_status: 'paid' as const }));
    expect(refundTargets(inCredit, [], []).map((t) => t.id)).toEqual(['inv-myr', 'inv-usd']);
  });
});
