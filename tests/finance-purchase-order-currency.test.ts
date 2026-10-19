/**
 * Stage 4p: RFQs and purchase orders in another currency. The data layer's payloads and refusals, a bill made
 * from a foreign order, the forms' currency part, the comparison in ringgit, the lists and CSVs, and the printed
 * order. The database's own answers are pinned by supabase/tests/bendahara_purchase_order_currency_check.sql.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { billFormFromDetail, ordersForSupplier, withPurchaseOrder, billOrderWarnings } from '@/lib/finance/bill-form';
import type { BillDetail } from '@/lib/finance/bills';
import { emptyLine } from '@/lib/finance/document-form';
import { ringgitFields, withCurrency, withRateTyped } from '@/lib/finance/document-currency';
import {
  PURCHASE_ORDER_FORM_KIND,
  newPurchaseOrderForm,
  purchaseOrderFormError,
  purchaseOrderFormFromDetail,
  purchaseOrderPayload,
  withOrderSupplier,
} from '@/lib/finance/purchase-order-form';
import { purchaseOrderPrint, type PrintablePurchaseOrder } from '@/lib/finance/purchase-order-print';
import {
  PURCHASE_ORDER_MESSAGES,
  type PurchaseOrderDetail,
  type PurchaseOrderListRow,
  billFromPurchaseOrder,
  billFromPurchaseOrderInRinggit,
  listPurchaseOrders,
  savePurchaseOrder,
  savePurchaseOrderInRinggit,
  savePurchaseOrderInput,
  savePurchaseOrderToolInput,
  submitPurchaseOrder,
} from '@/lib/finance/purchase-orders';
import { orderNotesForBills, purchaseOrdersCsv, rfqsCsv } from '@/lib/finance/purchase-views';
import { compareQuotes, quoteTotals, quotesInSeveralCurrencies } from '@/lib/finance/rfq-compare';
import { RFQ_FORM_KIND, newRfqForm, rfqFormError, rfqPayload } from '@/lib/finance/rfq-form';
import {
  RFQ_MESSAGES,
  type RfqDetail,
  type RfqListRow,
  listRfqs,
  saveRfq,
  saveRfqInRinggit,
  saveRfqInput,
  saveRfqToolInput,
} from '@/lib/finance/rfqs';
import { fakeFinance } from './setup/fake-finance';

const ID = '33333333-3333-4333-8333-333333333333';
const SUPPLIER = '44444444-4444-4444-8444-444444444444';
const BILL = '77777777-7777-4777-8777-777777777777';

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const line = { description: 'Press', quantity: 1, unit_price: 666.7 };
const order = { supplier_id: SUPPLIER, po_date: '2026-10-15', lines: [line] };
const rfq = { supplier_id: SUPPLIER, rfq_date: '2026-10-15', lines: [{ description: 'Press', quantity: 1 }] };

describe('the save inputs take a currency, the assistant’s do not', () => {
  it('passes the four currency keys through on an order and an RFQ', () => {
    const fx = { currency: 'USD', fx_rate: '4.083', fx_rate_source: 'bnm', fx_rate_date: '2026-10-15' } as const;
    expect(savePurchaseOrderInput.parse({ ...order, ...fx })).toMatchObject(fx);
    expect(saveRfqInput.parse({ ...rfq, ...fx })).toMatchObject(fx);
    // No rate yet is allowed on a draft.
    expect(savePurchaseOrderInput.parse({ ...order, currency: 'USD', fx_rate: null }).fx_rate).toBeNull();
  });
  it('sends nothing about a currency when none is given, so a draft keeps its own', () => {
    expect(savePurchaseOrderInput.parse(order)).not.toHaveProperty('currency');
    expect(saveRfqInput.parse(rfq)).not.toHaveProperty('currency');
  });
  it('refuses a currency that is not a document currency, and a rate that is not a number above 0', () => {
    expect(savePurchaseOrderInput.safeParse({ ...order, currency: 'XXX' }).error?.issues[0]?.message).toBe(PURCHASE_ORDER_MESSAGES.currency);
    expect(saveRfqInput.safeParse({ ...rfq, currency: 'USD', fx_rate: '-1' }).error?.issues[0]?.message).toBe(RFQ_MESSAGES.rate);
  });
  it('wants whole amounts in a currency with no cents', () => {
    expect(savePurchaseOrderInput.safeParse({ ...order, currency: 'JPY', fx_rate: '0.031' }).error?.issues[0]?.message).toBe(
      'JPY has no cents: enter whole amounts.',
    );
  });
  it('strips the currency keys from what the assistant sends', () => {
    const sent = { ...order, currency: 'USD', fx_rate: '4.2', fx_rate_source: 'manual' };
    expect(savePurchaseOrderToolInput.parse(sent)).not.toHaveProperty('currency');
    expect(saveRfqToolInput.parse({ ...rfq, currency: 'USD' })).not.toHaveProperty('currency');
  });
});

describe('saving and submitting say the database’s refusals in words', () => {
  it('FIN38 on submit is the rate sentence; FIN39 on save is the BNM sentence', async () => {
    const fin38 = fakeFinance({ data: null, error: { code: 'FIN38' } });
    expect(await submitPurchaseOrder(fin38.ctx, { id: ID })).toEqual({ ok: false, error: PURCHASE_ORDER_MESSAGES.rateBeforeSubmitting });
    expect(PURCHASE_ORDER_MESSAGES.rateBeforeSubmitting).toBe('Enter the exchange rate before submitting the order.');
    const fin39 = fakeFinance({ data: null, error: { code: 'FIN39' } });
    expect(await savePurchaseOrder(fin39.ctx, { ...order, currency: 'USD', fx_rate: '4.0815', fx_rate_source: 'bnm', fx_rate_date: '2026-10-15' })).toEqual({
      ok: false, error: PURCHASE_ORDER_MESSAGES.notBnmRate,
    });
    expect(await saveRfq(fin39.ctx, { ...rfq, currency: 'USD', fx_rate: '4.0815', fx_rate_source: 'bnm', fx_rate_date: '2026-10-15' })).toEqual({
      ok: false, error: RFQ_MESSAGES.notBnmRate,
    });
  });
  it('sends the currency keys to the save function', async () => {
    const { ctx, calls } = fakeFinance({ data: ID, error: null });
    await savePurchaseOrder(ctx, { ...order, currency: 'USD', fx_rate: '4.083', fx_rate_source: 'bnm', fx_rate_date: '2026-10-15' });
    expect((calls[0].args as { purchase_order: Record<string, unknown> }).purchase_order).toMatchObject({
      currency: 'USD', fx_rate: '4.083', fx_rate_source: 'bnm', fx_rate_date: '2026-10-15',
    });
  });
});

describe('the assistant writes orders and RFQs in ringgit only', () => {
  const stored = (currency: string | null) =>
    fakeFinance((call) =>
      call.kind === 'table' ? { data: currency === null ? null : { currency }, error: null } : { data: ID, error: null },
    );
  it('refuses to edit a draft that is in another currency, and saves a ringgit one', async () => {
    const usd = stored('USD');
    expect(await savePurchaseOrderInRinggit(usd.ctx, { ...order, id: ID })).toEqual({ ok: false, error: PURCHASE_ORDER_MESSAGES.foreignDraftByAssistant });
    expect(usd.calls.map((c) => c.name)).not.toContain('finance_save_purchase_order');
    expect(await saveRfqInRinggit(usd.ctx, { ...rfq, id: ID })).toEqual({ ok: false, error: RFQ_MESSAGES.foreignDraftByAssistant });
    const myr = stored('MYR');
    expect(await savePurchaseOrderInRinggit(myr.ctx, { ...order, id: ID, currency: 'USD' })).toEqual({ ok: true, data: { id: ID } });
    const save = myr.calls.find((c) => c.name === 'finance_save_purchase_order');
    expect((save?.args as { purchase_order: Record<string, unknown> }).purchase_order).not.toHaveProperty('currency');
  });
});

/* ---- reads ---------------------------------------------------------------- */

const orderRow = (extra: Record<string, unknown> = {}) => ({
  id: ID, po_no: 'PO-0009', supplier_id: SUPPLIER, supplier_name: 'Pacific Tools Inc', rfq_id: null, rfq_no: null,
  po_date: '2026-10-15', expected_date: null, status: 'approved', created_by: 'u1', submitted_by: 'u1',
  rejection_reason: null, payment_terms_days: 30, delivery_address: null,
  total: '1000.00', delivery: 'pending', received_total: '0', billed_total: '0', over_billed: false, billed_over_received: false,
  currency: 'USD', fx_rate: '4.0830000000', fx_rate_text: '4.0830000000', fx_rate_source: 'bnm', fx_rate_date: '2026-10-15',
  total_myr: '4083.00',
  ...extra,
});

describe('reading orders and RFQs', () => {
  it('reads an order’s currency, its exact rate and its ringgit total', async () => {
    const { ctx, calls } = fakeFinance({ data: [orderRow()], error: null });
    const [row] = await listPurchaseOrders(ctx);
    expect(row).toMatchObject({ currency: 'USD', fx_rate: 4.083, fx_rate_text: '4.0830000000', fx_rate_source: 'bnm', fx_rate_date: '2026-10-15', total: 1000, total_myr: 4083 });
    expect(calls[0].columns).toContain('fx_rate_text:fx_rate::text');
    expect(calls[0].columns).toContain('total_myr');
  });
  it('reads an order with no rate yet as no ringgit, not 0', async () => {
    const { ctx } = fakeFinance({ data: [orderRow({ fx_rate: null, fx_rate_text: null, fx_rate_source: null, fx_rate_date: null, total_myr: null })], error: null });
    const [row] = await listPurchaseOrders(ctx);
    expect(row.fx_rate).toBeNull();
    expect(row.total_myr).toBeNull();
  });
  it('reads an RFQ’s currency and ringgit total', async () => {
    const { ctx } = fakeFinance({
      data: [{
        id: ID, rfq_no: 'RFQ-0001', supplier_id: SUPPLIER, supplier_name: 'Pacific Tools Inc', rfq_date: '2026-10-15', reply_by: null,
        supplier_ref: null, status: 'quoted', line_count: 2, total: '1000.00', quoted_at: '2026-10-16T01:00:00+00:00',
        purchase_order_id: null, purchase_order_no: null, source_rfq_id: null,
        currency: 'USD', fx_rate: '4.083', fx_rate_text: '4.0830000000', fx_rate_source: 'bnm', fx_rate_date: '2026-10-15', total_myr: '4083.00',
      }],
      error: null,
    });
    const [row] = await listRfqs(ctx);
    expect(row).toMatchObject({ currency: 'USD', fx_rate_text: '4.0830000000', total_myr: 4083 });
  });
});

/* ---- a bill made from an order ------------------------------------------- */

describe('billFromPurchaseOrder keeps the order’s currency', () => {
  const poLines = [
    { id: 'l1', product_id: null, description: 'Press', quantity: '1.000', uom: null, pack_size: null, unit_price: '666.7000', sst_rate: '0.00', amount: '666.70', sst_amount: '0.00', received_quantity: '0' },
  ];
  const answering = (head: Record<string, unknown>, rate: unknown) =>
    fakeFinance((call) => {
      if (call.name === 'finance_purchase_order_totals') return { data: head, error: null };
      if (call.name === 'finance_purchase_order_lines') return { data: poLines, error: null };
      if (call.name === 'finance_fx_rate_for_invoice') return { data: rate, error: null };
      return { data: BILL, error: null };
    });
  const billOf = (calls: { name: string; args?: Record<string, unknown> }[]) =>
    (calls.find((c) => c.name === 'finance_save_bill')?.args as { bill: Record<string, unknown> }).bill;

  it('sends the order’s currency and the rule’s rate for the bill date', async () => {
    const { ctx, calls } = answering({ ...orderRow(), subtotal: '666.70', sst_total: '0', notes: null }, [
      { rate: '4.0790000000', rate_date: '2026-10-17', unit: 1, selling_rate: '4.079' },
    ]);
    expect(await billFromPurchaseOrder(ctx, { id: ID, bill_date: '2026-10-18' })).toEqual({ ok: true, data: { id: ID, bill_id: BILL } });
    expect(calls.find((c) => c.name === 'finance_fx_rate_for_invoice')?.args).toEqual({ target_currency: 'USD', on_date: '2026-10-18' });
    expect(billOf(calls)).toMatchObject({
      purchase_order_id: ID, currency: 'USD', fx_rate: '4.0790000000', fx_rate_source: 'bnm', fx_rate_date: '2026-10-17',
    });
  });
  it('leaves the rate empty when Bank Negara has none (the bill form then asks for one)', async () => {
    const { ctx, calls } = answering({ ...orderRow(), subtotal: '666.70', sst_total: '0', notes: null }, []);
    await billFromPurchaseOrder(ctx, { id: ID, bill_date: '2026-10-18' });
    expect(billOf(calls)).toMatchObject({ currency: 'USD', fx_rate: null });
    expect(billOf(calls).fx_rate_source ?? null).toBeNull();
  });
  it('sends no currency at all for a ringgit order, as before', async () => {
    const { ctx, calls } = answering(
      { ...orderRow({ currency: 'MYR', fx_rate: '1', fx_rate_text: '1.0000000000', fx_rate_source: null, fx_rate_date: null, total_myr: '666.70' }), subtotal: '666.70', sst_total: '0', notes: null },
      [],
    );
    await billFromPurchaseOrder(ctx, { id: ID, bill_date: '2026-10-18' });
    expect(billOf(calls)).not.toHaveProperty('currency');
    expect(calls.map((c) => c.name)).not.toContain('finance_fx_rate_for_invoice');
  });
  it('makes no bill when the rate cannot be read, rather than a foreign bill with no rate unawares', async () => {
    const { ctx, calls } = fakeFinance((call) => {
      if (call.name === 'finance_purchase_order_totals') return { data: { ...orderRow(), subtotal: '666.70', sst_total: '0', notes: null }, error: null };
      if (call.name === 'finance_purchase_order_lines') return { data: poLines, error: null };
      if (call.name === 'finance_fx_rate_for_invoice') return { data: null, error: { code: 'XX000', message: 'boom' } };
      return { data: BILL, error: null };
    });
    expect(await billFromPurchaseOrder(ctx, { id: ID, bill_date: '2026-10-18' })).toEqual({
      ok: false, error: 'That change could not be saved. Please try again.',
    });
    expect(calls.map((c) => c.name)).not.toContain('finance_save_bill');
    expect(logged).toHaveBeenCalled();
  });
  it('is not done by the assistant for an order in another currency', async () => {
    const { ctx, calls } = answering({ ...orderRow(), subtotal: '666.70', sst_total: '0', notes: null }, []);
    expect(await billFromPurchaseOrderInRinggit(ctx, { id: ID, bill_date: '2026-10-18' })).toEqual({
      ok: false, error: PURCHASE_ORDER_MESSAGES.foreignOrderByAssistant,
    });
    expect(calls.map((c) => c.name)).not.toContain('finance_save_bill');
  });
});

/* ---- the forms ----------------------------------------------------------- */

const filledOrder = () => ({
  ...newPurchaseOrderForm('2026-10-15', 'k0'),
  supplier_id: SUPPLIER,
  lines: [{ ...emptyLine('k0'), description: 'Press', quantity: '1', unit_price: '666.70' }],
});

describe('the purchase order form', () => {
  it('is in ringgit when new, and sends ringgit as the quotation form does', () => {
    const form = filledOrder();
    expect(form.fx).toEqual(ringgitFields());
    expect(purchaseOrderPayload(form)).toMatchObject({ currency: 'MYR', fx_rate: null, fx_rate_source: null, fx_rate_date: null });
    expect(purchaseOrderFormError(form, true)).toBeNull();
  });
  it('asks for a rate before an order in another currency is submitted, not before it is saved', () => {
    const form = { ...filledOrder(), fx: withCurrency(ringgitFields(), 'USD', true) };
    expect(purchaseOrderFormError(form)).toBeNull();
    expect(purchaseOrderFormError(form, true)).toBe(PURCHASE_ORDER_MESSAGES.rateBeforeSubmitting);
    const typed = { ...form, fx: withRateTyped(form.fx, '4.2') };
    expect(purchaseOrderFormError(typed, true)).toBeNull();
    expect(purchaseOrderPayload(typed)).toMatchObject({ currency: 'USD', fx_rate: '4.2', fx_rate_source: 'manual', fx_rate_date: null });
    expect(savePurchaseOrderInput.safeParse(purchaseOrderPayload(typed)).success).toBe(true);
  });
  it('takes a new order’s currency from the supplier’s default, unless the person picked one', () => {
    const form = withOrderSupplier(newPurchaseOrderForm('2026-10-15', 'k0'), { id: SUPPLIER, payment_terms_days: 30, default_currency: 'USD' });
    expect(form.fx.currency).toBe('USD');
    const picked = { ...newPurchaseOrderForm('2026-10-15', 'k0'), fx: withCurrency(ringgitFields(), 'SGD', true) };
    expect(withOrderSupplier(picked, { id: SUPPLIER, payment_terms_days: 30, default_currency: 'USD' }).fx.currency).toBe('SGD');
  });
  it('opens a saved draft in its currency, at its exact rate', () => {
    const detail = {
      ...orderRow({ status: 'draft' }), total: 1000, received_total: 0, billed_total: 0, fx_rate: 4.083, total_myr: 4083,
      subtotal: 1000, sst_total: 0, notes: null, lines: [],
    } as unknown as PurchaseOrderDetail;
    const form = purchaseOrderFormFromDetail(detail);
    expect(form.fx).toMatchObject({ currency: 'USD', rate: '4.083', rateSource: 'bnm', rateDate: '2026-10-15' });
  });
  it('draws the currency picker, offered the selling rate', () => {
    expect(PURCHASE_ORDER_FORM_KIND.currency?.figure).toBe('selling');
    expect(RFQ_FORM_KIND.currency?.figure).toBe('selling');
  });
});

describe('the RFQ form', () => {
  it('never needs a rate: an RFQ’s is only there to compare quotes', () => {
    const form = { ...newRfqForm('2026-10-15', 'k0'), supplier_id: SUPPLIER, fx: withCurrency(ringgitFields(), 'USD', true) };
    form.lines = [{ ...emptyLine('k0'), description: 'Press', quantity: '1' }];
    expect(rfqFormError(form)).toBeNull();
    expect(rfqPayload(form)).toMatchObject({ currency: 'USD', fx_rate: null });
    expect(saveRfqInput.safeParse(rfqPayload(form)).success).toBe(true);
  });
});

/* ---- comparing quotes in ringgit -------------------------------------------- */

const quoted = (id: string, currency: string, total: number, total_myr: number | null, unit_price: number, fx_rate_text: string | null) =>
  ({
    id, rfq_no: `RFQ-${id}`, supplier_id: SUPPLIER, supplier_name: `Supplier ${id}`, rfq_date: '2026-10-15', reply_by: null,
    supplier_ref: null, status: 'quoted', line_count: 1, total, quoted_at: '2026-10-16T01:00:00+00:00',
    purchase_order_id: null, purchase_order_no: null, source_rfq_id: null,
    currency, fx_rate: fx_rate_text === null ? null : Number(fx_rate_text), fx_rate_text, fx_rate_source: 'manual', fx_rate_date: null, total_myr,
    subtotal: total, sst_total: 0, notes: null,
    lines: [{ id: `${id}-l`, product_id: null, description: 'Press', quantity: 1, uom: null, pack_size: null, unit_price, sst_rate: 0 }],
  }) as RfqDetail;

describe('comparing quotes in different currencies', () => {
  it('ranks by the ringgit total: a USD quote of RM 4,083.00 is below a ringgit quote of RM 4,100.00', () => {
    const usd = quoted('a', 'USD', 1000, 4083, 1000, '4.083');
    const myr = quoted('b', 'MYR', 4100, 4100, 4100, '1');
    const totals = quoteTotals([myr, usd]);
    expect(totals.map((t) => t.lowest)).toEqual([false, true]);
    expect(totals[1]).toMatchObject({ total: 'USD 1,000.00', ringgit: '≈ RM 4,083.00' });
    expect(totals[0]).toMatchObject({ total: 'RM 4,100.00', ringgit: null });
    // The line is marked lowest in ringgit too, not by comparing 1,000 dollars with 4,100 ringgit the other way.
    const [row] = compareQuotes([myr, usd]);
    expect(row.cells.map((c) => c?.lowest)).toEqual([false, true]);
  });
  it('does not rank a quote with no exchange rate, and says so', () => {
    const none = quoted('c', 'USD', 900, null, 900, null);
    const myr = quoted('b', 'MYR', 4100, 4100, 4100, '1');
    const other = quoted('d', 'MYR', 4200, 4200, 4200, '1');
    const totals = quoteTotals([none, myr, other]);
    expect(totals[0]).toMatchObject({ total: 'USD 900.00', ringgit: 'No exchange rate', lowest: false });
    expect(totals.map((t) => t.lowest)).toEqual([false, true, false]);
    const [row] = compareQuotes([none, myr, other]);
    expect(row.cells.map((c) => c?.lowest)).toEqual([false, true, false]);
  });
  it('reads an all-ringgit comparison as before when a foreign RFQ in the group is not quoted yet', () => {
    const a = quoted('a', 'MYR', 4100, 4100, 4100, '1');
    const b = quoted('b', 'MYR', 4050, 4050, 4050, '1');
    const waiting = { ...quoted('c', 'USD', 0, null, 0, null), status: 'sent', quoted_at: null } as RfqDetail;
    expect(quotesInSeveralCurrencies([a, b, waiting])).toBe(false);
    expect(quoteTotals([a, b, waiting]).map((t) => t.lowest)).toEqual([false, false, false]);
    expect(quoteTotals([a, b, waiting])[2]).toEqual({ total: null, ringgit: null, lowest: false });
    // Once it is quoted, the comparison is across currencies and is ranked in ringgit.
    expect(quotesInSeveralCurrencies([a, b, quoted('c', 'USD', 900, 3600, 900, '4')])).toBe(true);
  });
  it('compares prices in their own currency when every quote is in the same one', () => {
    const a = quoted('a', 'USD', 1000, null, 1000, null);
    const b = quoted('b', 'USD', 990, null, 990, null);
    const [row] = compareQuotes([a, b]);
    expect(row.cells.map((c) => c?.lowest)).toEqual([false, true]);
    expect(quoteTotals([a, b]).map((t) => t.lowest)).toEqual([false, false]);
  });
});

/* ---- lists, CSVs, notes and the printout -------------------------------------- */

const listRow = (extra: Partial<PurchaseOrderListRow> = {}): PurchaseOrderListRow => ({
  id: ID, po_no: 'PO-0009', supplier_id: SUPPLIER, supplier_name: 'Pacific Tools Inc', rfq_id: null, rfq_no: null,
  po_date: '2026-10-15', expected_date: null, status: 'approved', created_by: 'u1', submitted_by: 'u1', rejection_reason: null,
  payment_terms_days: 30, delivery_address: null, total: 1000, delivery: 'pending', received_total: 0, billed_total: 0,
  over_billed: false, billed_over_received: false,
  currency: 'MYR', fx_rate: 1, fx_rate_text: '1.0000000000', fx_rate_source: null, fx_rate_date: null, total_myr: 1000,
  ...extra,
});

/** A CSV's lines, without the byte-order mark and the line ends. */
const csvLines = (csv: string) => csv.replace(/^﻿/, '').split('\r\n');

describe('the orders and RFQs CSVs', () => {
  it('are as before while every order is in ringgit', () => {
    expect(csvLines(purchaseOrdersCsv([listRow()]))[0]).toBe('No.,Date,Supplier,RFQ,Expected delivery,Total,Received,Billed,Delivery,Status');
  });
  it('add the currency, the exact rate and the ringgit total once one is foreign', () => {
    const csv = purchaseOrdersCsv([listRow(), listRow({ currency: 'USD', fx_rate: 4.083, fx_rate_text: '4.0830000000', fx_rate_source: 'bnm', fx_rate_date: '2026-10-15', total_myr: 4083 })]);
    const [head, , usd] = csvLines(csv);
    expect(head).toBe('No.,Date,Supplier,RFQ,Expected delivery,Total,Received,Billed,Delivery,Status,Currency,Rate (RM per unit),Total (RM)');
    expect(usd.endsWith(',USD,4.0830000000,4083')).toBe(true);
  });
  it('do the same for RFQs, with the ringgit only once the quote is recorded', () => {
    const base = quoted('a', 'USD', 1000, 4083, 1000, '4.0830000000') as RfqListRow;
    const [head, row] = csvLines(rfqsCsv([base], '2026-10-18'));
    expect(head.endsWith(',Currency,Rate (RM per unit),Total (RM)')).toBe(true);
    expect(row.endsWith(',USD,4.0830000000,4083')).toBe(true);
  });
});

describe('a bill’s order notes and picker speak the order’s currency', () => {
  it('names the order’s figures in its currency', () => {
    const usd = listRow({ currency: 'USD', total: 1000, billed_total: 1200, over_billed: true });
    expect(orderNotesForBills([{ bill_no: 'BILL-1', purchase_order_id: ID }], [usd])).toEqual([
      'BILL-1 is against PO-0009, whose bills come to USD 1,200.00, over its total of USD 1,000.00.',
    ]);
  });
  it('labels the order in the picker, warns in its currency and puts the bill in it', () => {
    const option = { id: ID, po_no: 'PO-0009', supplier_id: SUPPLIER, status: 'approved', total: 1000, billed_total: 0, received_total: 0, currency: 'USD' };
    expect(ordersForSupplier([option], SUPPLIER, '')).toEqual([{ id: ID, label: 'PO-0009 · USD 1,000.00 · billed USD 0.00' }]);
    const lines = [{ ...emptyLine('k'), description: 'Press', quantity: '2', unit_price: '666.70' }];
    expect(billOrderWarnings(lines, option, 0)[0]).toBe('This takes the bills for PO-0009 over its total of USD 1,000.00.');
    const bill = billFormFromDetail({
      id: BILL, supplier_id: SUPPLIER, supplier_name: 'x', bill_no: null, supplier_ref: null, bill_date: '2026-10-18', due_date: '2026-11-17',
      notes: null, lines: [], purchase_order_id: null, purchase_order_no: null, category_id: null, category_name: null,
      currency: 'MYR', fx_rate: 1, fx_rate_text: '1', fx_rate_source: null, fx_rate_date: null, fx_rate_provider: null, fx_rate_reference: null,
    } as unknown as BillDetail);
    expect(withPurchaseOrder(bill, ID, 'USD').fx.currency).toBe('USD');
  });
});

describe('the printed order shows its currency', () => {
  it('prints the lines and totals in USD, with no ringgit figure', () => {
    const printable = {
      ...listRow({ currency: 'USD', fx_rate: 4.083, fx_rate_text: '4.0830000000', fx_rate_source: 'bnm', fx_rate_date: '2026-10-15', total_myr: 4083 }),
      subtotal: 1000, sst_total: 0, notes: null,
      lines: [{ id: 'l1', product_id: null, description: 'Bolts', quantity: 10, uom: null, pack_size: null, unit_price: 33.33, sst_rate: 0, amount: 333.3, sst_amount: 0, received_quantity: 0 },
              { id: 'l2', product_id: null, description: 'Press', quantity: 1, uom: null, pack_size: null, unit_price: 666.7, sst_rate: 0, amount: 666.7, sst_amount: 0, received_quantity: 0 }],
      submitted_at: null, approved_by: null, approved_at: null,
      supplier: { name: 'Pacific Tools Inc', ssm_no: null, phone: null, email: null }, people: {},
    } as unknown as PrintablePurchaseOrder;
    const p = purchaseOrderPrint(printable, null);
    expect(p.totals).toEqual([
      { label: 'Subtotal', value: 'USD 1,000.00' },
      { label: 'SST', value: 'USD 0.00' },
      { label: 'Total', value: 'USD 1,000.00' },
    ]);
    expect(p.lines[0]).toMatchObject({ unit_price: 'USD 33.33', amount: 'USD 333.30' });
    expect(JSON.stringify(p)).not.toContain('RM');
  });
  it('prints a ringgit order as before', () => {
    const printable = {
      ...listRow(), subtotal: 1000, sst_total: 0, notes: null,
      lines: [{ id: 'l1', product_id: null, description: 'Bolts', quantity: 10, uom: null, pack_size: null, unit_price: 100, sst_rate: 0, amount: 1000, sst_amount: 0, received_quantity: 0 }],
      submitted_at: null, approved_by: null, approved_at: null,
      supplier: { name: 'Kedai', ssm_no: null, phone: null, email: null }, people: {},
    } as unknown as PrintablePurchaseOrder;
    const p = purchaseOrderPrint(printable, null);
    expect(p.totals[2]).toEqual({ label: 'Total', value: 'RM 1,000.00' });
    expect(p.lines[0]).toMatchObject({ unit_price: 'RM 100.00', amount: 'RM 1,000.00' });
  });
});
