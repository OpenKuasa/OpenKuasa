import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBendaharaTools } from '@/lib/ai/finance-tools';
import type { BillListRow } from '@/lib/finance/bills';
import { billPaymentPreview, carriedSen, realisedOutSen, senFromText, shareRinggit } from '@/lib/finance/fx-settlement';
import {
  type FinanceAccount,
  MONEY_MESSAGES,
  type PaymentOutRow,
  paymentOutRinggit,
  recordPaymentOut,
  recordPaymentOutInput,
  recordPaymentOutInRinggit,
  recordPaymentOutToolInput,
} from '@/lib/finance/money';
import {
  PAYMENT_OUT_KIND,
  type PaymentForm,
  newPaymentForm,
  offeredBills,
  payableBills,
  paymentFormError,
  paymentPayload,
  paymentPreview,
  toggleAll,
  toggleBill,
  withRinggit,
} from '@/lib/finance/payment-form';
import { billsView, paymentsCsv, paymentsView } from '@/lib/finance/purchase-views';
import { VOUCHER_MESSAGES, saveVoucher } from '@/lib/finance/vouchers';
import { ringgitBill } from './helpers/bill-rows';

/**
 * Stage 4b, payments out of bills in another currency: the settlement preview, the form, the data layer, the
 * assistant, and every figure that adds payments out up, in ringgit. The database side is
 * supabase/tests/bendahara_fx_payments_out_check.sql (the same worked examples, through the real functions).
 */

const LIM = '11111111-1111-4111-8111-111111111111';
const BANK = '66666666-6666-4666-8666-666666666666';
const TODAY = '2026-10-19';
const MYR_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const USD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002';
const USD2_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000003';
const SGD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000004';
const JPY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000005';

const RATE = BigInt(10) ** BigInt(10);
const rate = (text: string) => {
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * RATE + BigInt(frac.padEnd(10, '0'));
};
const sen = (text: string) => senFromText(text) as bigint;

describe('the closing rule for a bill (carriedSen, as private.finance_fx_carried_bill)', () => {
  it('B4: USD 400.00 of USD 1,080.00 at 4.2 carries 1,680.00; paid with RM 1,700.00 a loss of 20.00', () => {
    const carried = carriedSen(sen('400'), rate('4.2'), sen('1080'), sen('4536'));
    expect(carried).toBe(sen('1680'));
    expect(realisedOutSen(carried, sen('1700'))).toBe(-sen('20'));
  });
  it('B4: the last USD 680.00 carries the RM 2,856.00 still open; paid with RM 2,800.00 a gain of 56.00', () => {
    const carried = carriedSen(sen('680'), rate('4.2'), sen('680'), sen('2856'));
    expect(carried).toBe(sen('2856'));
    expect(realisedOutSen(carried, sen('2800'))).toBe(sen('56'));
  });
  it('B4.1: the last USD 49.99 carries the 212.74 still open, not round(212.732445) = 212.73', () => {
    expect(carriedSen(sen('50'), rate('4.2555'), sen('99.99'), sen('425.52'))).toBe(sen('212.78'));
    expect(carriedSen(sen('49.99'), rate('4.2555'), sen('49.99'), sen('212.74'))).toBe(sen('212.74'));
  });
  it('C4: never more than the ringgit still open, then 0.00 for the last IDR 1.00', () => {
    expect(carriedSen(sen('2000029'), rate('0.00028'), sen('2000030'), sen('560'))).toBe(sen('560'));
    expect(carriedSen(sen('1'), rate('0.00028'), sen('1'), sen('0'))).toBe(sen('0'));
  });
});

describe('billPaymentPreview', () => {
  it('B4 payment 1: carried 1,680.00, a loss of 20.00', () => {
    const preview = billPaymentPreview('1700', [{ id: USD_ID, amount: '400', rateText: '4.2000000000', openForeign: 1080, openRinggit: 4536 }]);
    expect(preview).toEqual({ parts: [{ id: USD_ID, ringgit: 1700, carried: 1680, realised: -20 }], carried: 1680, realised: -20 });
  });
  it('B4 payment 2: closing, carried 2,856.00, a gain of 56.00', () => {
    const preview = billPaymentPreview('2800', [{ id: USD_ID, amount: '680', rateText: '4.2000000000', openForeign: 680, openRinggit: 2856 }]);
    expect(preview).toMatchObject({ carried: 2856, realised: 56 });
  });
  it('B4.1: the closing 212.74', () => {
    const preview = billPaymentPreview('212', [{ id: USD_ID, amount: '49.99', rateText: '4.2555000000', openForeign: 49.99, openRinggit: 212.74 }]);
    expect(preview).toMatchObject({ carried: 212.74, realised: 0.74 });
  });
  it('B4.2: RM 1,000.00 over three USD 100.00 bills: 333.34 to the lowest id, realised -3.00 in all', () => {
    const [x1, x2, x3] = ['bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000003'];
    // Given in another order: the remainder still goes to the lowest id among the largest.
    const preview = billPaymentPreview('1000', [
      { id: x3, amount: '100', rateText: '3.3200000000', openForeign: 100, openRinggit: 332 },
      { id: x1, amount: '100', rateText: '3.3000000000', openForeign: 100, openRinggit: 330 },
      { id: x2, amount: '100', rateText: '3.3500000000', openForeign: 100, openRinggit: 335 },
    ]);
    expect(preview?.parts).toEqual([
      { id: x3, ringgit: 333.33, carried: 332, realised: -1.33 },
      { id: x1, ringgit: 333.34, carried: 330, realised: -3.34 },
      { id: x2, ringgit: 333.33, carried: 335, realised: 1.67 },
    ]);
    expect(preview).toMatchObject({ carried: 997, realised: -3 });
    expect(shareRinggit(sen('1000'), [{ id: x2, sen: sen('100') }, { id: x1, sen: sen('100') }])).toEqual([sen('500'), sen('500')]);
  });
  it('C4: capped at the ringgit still open, then 0.00', () => {
    expect(billPaymentPreview('561', [{ id: USD_ID, amount: '2000029', rateText: '0.0002800000', openForeign: 2000030, openRinggit: 560 }]))
      .toMatchObject({ carried: 560, realised: -1 });
    expect(billPaymentPreview('0.01', [{ id: USD_ID, amount: '1', rateText: '0.0002800000', openForeign: 1, openRinggit: 0 }]))
      .toMatchObject({ carried: 0, realised: -0.01 });
  });
  it('is null while a figure is not a number yet', () => {
    const part = { id: USD_ID, amount: '400', rateText: '4.2000000000', openForeign: 1080, openRinggit: 4536 };
    expect(billPaymentPreview('', [part])).toBeNull();
    expect(billPaymentPreview('0', [part])).toBeNull();
    expect(billPaymentPreview('1700', [])).toBeNull();
    expect(billPaymentPreview('1700', [{ ...part, amount: 'abc' }])).toBeNull();
    expect(billPaymentPreview('1700', [{ ...part, rateText: null }])).toBeNull();
  });
});

/* ---- the payment form, one currency at a time --------------------------------------- */

const billRow = (b: Partial<BillListRow> & { id: string }): BillListRow =>
  ringgitBill({
    bill_no: 'BILL-1', supplier_id: LIM, supplier_name: 'Lim Hardware', bill_date: '2026-10-05', due_date: '2026-10-30',
    total: 100, paid: 0, balance: 100, display_status: 'pending', purchase_order_id: null, purchase_order_no: null,
    category_id: null, category_name: null, ...b,
  });
const MYR_BILL = billRow({ id: MYR_ID });
/** Worked example B4 after payment 1: USD 1,080.00 at 4.2, USD 400.00 paid (carried RM 1,680.00). */
const foreign = (b: Partial<BillListRow> & { id: string; currency: string; fx_rate_text: string }): BillListRow =>
  billRow({ fx_rate: Number(b.fx_rate_text), fx_rate_source: 'manual', fx_rate_provider: 'reuters', ...b });
const USD_BILL = foreign({
  id: USD_ID, bill_no: 'BILL-2', currency: 'USD', fx_rate_text: '4.2000000000', total: 1080, paid: 400, balance: 680,
  total_myr: 4536, balance_myr: 2856, subtotal_myr: 4200, sst_myr: 336,
});
const USD2_BILL = foreign({ id: USD2_ID, bill_no: 'BILL-3', currency: 'USD', fx_rate_text: '4.2000000000', total: 1080, balance: 1080, total_myr: 4536, balance_myr: 4536 });
const SGD_BILL = foreign({ id: SGD_ID, bill_no: 'BILL-4', currency: 'SGD', fx_rate_text: '3.2000000000', total: 1080, balance: 1080, total_myr: 3456, balance_myr: 3456 });
const JPY_BILL = foreign({ id: JPY_ID, bill_no: 'BILL-5', currency: 'JPY', fx_rate_text: '0.0290000000', total: 100000, balance: 100000, total_myr: 2900, balance_myr: 2900 });
const ALL = [MYR_BILL, USD_BILL, USD2_BILL, SGD_BILL, JPY_BILL];

const accounts: FinanceAccount[] = [{ id: BANK, name: 'Main Bank', kind: 'bank', bank_name: 'Maybank', currency: 'MYR' }];
const payable = payableBills(ALL, []);
const fresh = (): PaymentForm => ({ ...newPaymentForm(payable, accounts, TODAY), supplierId: LIM });
const usd = payable.find((b) => b.id === USD_ID)!;
const usd2 = payable.find((b) => b.id === USD2_ID)!;
const sgd = payable.find((b) => b.id === SGD_ID)!;
const myr = payable.find((b) => b.id === MYR_ID)!;
const jpy = payable.find((b) => b.id === JPY_ID)!;

describe('the payment-out form, one currency at a time', () => {
  it('offers bills in every currency, each with its rate and the ringgit it still carries', () => {
    expect(payable.map((b) => b.id).sort()).toEqual([MYR_ID, USD_ID, USD2_ID, SGD_ID, JPY_ID].sort());
    expect(usd).toMatchObject({ currency: 'USD', fx_rate_text: '4.2000000000', payable: 680, balance_myr: 2856 });
    expect(PAYMENT_OUT_KIND.owed(usd)).toBe('USD 680.00 to pay (≈ RM 2,856.00 still carried)');
    expect(PAYMENT_OUT_KIND.owed(myr)).toBe('RM 100.00 to pay');
  });
  it('does not offer a foreign draft with no rate', () => {
    const rateless = foreign({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000009', currency: 'EUR', fx_rate_text: '1', display_status: 'pending' });
    expect(payableBills([{ ...rateless, fx_rate: null, fx_rate_text: null }], [])).toEqual([]);
  });
  it('lists only the ticked currency once one is ticked, and every currency when none is', () => {
    const form = toggleBill(fresh(), usd, true);
    expect(offeredBills(form, payable).map((b) => b.id).sort()).toEqual([USD_ID, USD2_ID].sort());
    expect(PAYMENT_OUT_KIND.currency?.of(form)).toBe('USD');
    expect(offeredBills(toggleBill(form, usd, false), payable)).toHaveLength(5);
    expect(Object.keys(toggleAll(form, offeredBills(form, payable), true).amounts).sort()).toEqual([USD_ID, USD2_ID].sort());
  });
  it('starts again when a bill in another currency is ticked', () => {
    const now = toggleBill(withRinggit(toggleBill(fresh(), usd, true), '1700'), sgd, true);
    expect(Object.keys(now.amounts)).toEqual([SGD_ID]);
    expect(now).toMatchObject({ currency: 'SGD', ringgit: '' });
  });
  it('asks for the ringgit paid out for a foreign bill, and not for a ringgit one', () => {
    const form = toggleBill(fresh(), usd, true);
    expect(PAYMENT_OUT_KIND.currency?.ringgit.needed(form)).toBe(true);
    expect(paymentFormError(form, payable)).toBe(MONEY_MESSAGES.ringgitPaidOut);
    expect(paymentFormError(withRinggit(form, '0'), payable)).toBe(MONEY_MESSAGES.ringgitPaidOut);
    expect(paymentFormError(withRinggit(form, '1,700.00'), payable)).toBeNull();
    const ringgit = toggleBill(fresh(), myr, true);
    expect(PAYMENT_OUT_KIND.currency?.ringgit.needed(ringgit)).toBe(false);
    expect(paymentFormError(ringgit, payable)).toBeNull();
    expect(paymentPayload(ringgit)).not.toHaveProperty('amount_myr');
  });
  it('pays a foreign bill now: ticking one clears "Schedule for later", and a scheduled one is refused in the form', () => {
    const scheduled = { ...fresh(), scheduled: true };
    expect(toggleBill(scheduled, usd, true).scheduled).toBe(false);
    expect(toggleBill(scheduled, myr, true).scheduled).toBe(true);
    const forced = withRinggit({ ...toggleBill(fresh(), usd, true), scheduled: true }, '1700');
    expect(paymentFormError(forced, payable)).toBe(MONEY_MESSAGES.payNow);
    expect(PAYMENT_OUT_KIND.schedule?.offered?.(toggleBill(fresh(), usd, true))).toBe(false);
    expect(PAYMENT_OUT_KIND.schedule?.offered?.(toggleBill(fresh(), myr, true))).toBe(true);
  });
  it('sends the ringgit as the text typed, commas dropped, and the amounts in the bill’s currency', () => {
    const form = withRinggit({ ...toggleBill(fresh(), usd, true), amounts: { [USD_ID]: '400' } }, '1,700.00');
    expect(paymentPayload(form)).toMatchObject({ amount_myr: '1700.00', scheduled: false, allocations: [{ bill_id: USD_ID, amount: 400 }] });
    expect(recordPaymentOutInput.parse(paymentPayload(form)).amount_myr).toBe('1700.00');
  });
  it('previews example B4: a loss of 20.00, then the closing gain of 56.00', () => {
    const first = withRinggit({ ...toggleBill(fresh(), usd2, true), amounts: { [USD2_ID]: '400' } }, '1700');
    expect(paymentPreview(first, payable)).toEqual([
      'The bill carries about RM 1,680.00 for what is paid.',
      'Realised exchange loss of about RM 20.00.',
    ]);
    const closing = withRinggit(toggleBill(fresh(), usd, true), '2800');
    expect(paymentPreview(closing, payable)).toEqual([
      'The bill carries about RM 2,856.00 for what is paid.',
      'Realised exchange gain of about RM 56.00.',
    ]);
    expect(paymentPreview(toggleBill(fresh(), myr, true), payable)).toEqual([]);
  });
  it('asks for whole yen', () => {
    const form = withRinggit({ ...toggleBill(fresh(), jpy, true), amounts: { [JPY_ID]: '100.5' } }, '2900');
    expect(paymentFormError(form, payable)).toBe('JPY has no cents: enter whole amounts.');
  });
});

/* ---- the data layer and the assistant ----------------------------------------------- */

function fakeClient(currencies: Record<string, string>, accounts: Record<string, string> = {}) {
  const calls: { kind: string; payload: unknown }[] = [];
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ kind: `rpc:${name}`, payload: args });
      return { data: 'txn-1', error: null };
    },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
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
        calls.push({ kind: `read:${table}`, payload: values });
        return Promise.resolve({ data: values.map((id) => ({ id, currency: currencies[id] })), error: null });
      };
      return q;
    },
  };
  return { client: client as never, calls };
}

const payment = { account_id: BANK, txn_date: TODAY, method: 'bank_transfer' as const };

describe('recording a payment out', () => {
  it('sends the ringgit paid out only when there is one', async () => {
    const { client, calls } = fakeClient({});
    await recordPaymentOut({ client, orgId: 'org1' }, { ...payment, amount_myr: '1700', allocations: [{ bill_id: USD_ID, amount: 400 }] });
    await recordPaymentOut({ client, orgId: 'org1' }, { ...payment, allocations: [{ bill_id: MYR_ID, amount: 100 }] });
    const sent = calls.map((c) => (c.payload as { payment: object }).payment);
    expect(sent[0]).toMatchObject({ amount_myr: '1700', status: 'posted' });
    expect(sent[1]).not.toHaveProperty('amount_myr');
  });
  it('maps FIN44, FIN46 and FIN47 to their sentences, and FIN41 to nothing of its own', async () => {
    const sentences: [string, string][] = [
      ['FIN44', 'One payment can only settle bills in one currency. Record a separate payment for each currency.'],
      ['FIN46', 'Enter the ringgit that left the account.'],
      ['FIN47', 'A payment of a bill in another currency is recorded as paid, on the day the money leaves.'],
    ];
    for (const [code, sentence] of sentences) {
      const failing = { rpc: async () => ({ data: null, error: { code, message: 'x' } }) } as never;
      expect(await recordPaymentOut({ client: failing, orgId: 'org1' }, { ...payment, allocations: [{ bill_id: USD_ID, amount: 1 }] })).toEqual({
        ok: false,
        error: sentence,
      });
    }
    expect(MONEY_MESSAGES).not.toHaveProperty('foreignBillNotYet');
  });
  it('refuses a ringgit figure that is not money above 0', () => {
    for (const bad of ['0', '0.00', '1.005', '1,700', 'NaN', '-5']) {
      expect(recordPaymentOutInput.safeParse({ ...payment, amount_myr: bad, allocations: [{ bill_id: USD_ID, amount: 1 }] }).success, bad).toBe(false);
    }
  });
});

describe('the assistant records payments out in ringgit only', () => {
  it('is offered no ringgit-paid-out figure', () => {
    const { client } = fakeClient({});
    const tools = createBendaharaTools({ client, orgId: 'org1', canWrite: true }) as unknown as Record<string, { inputSchema: z.ZodType }>;
    const schema = z.toJSONSchema(tools.recordPaymentOut.inputSchema, { unrepresentable: 'any', io: 'input' }) as { properties: object };
    expect(Object.keys(schema.properties)).not.toContain('amount_myr');
    expect(recordPaymentOutToolInput.parse({ ...payment, amount_myr: '5', allocations: [{ bill_id: MYR_ID, amount: 1 }] })).not.toHaveProperty('amount_myr');
  });
  it('refuses a bill in another currency in its own words, and records nothing', async () => {
    const { client, calls } = fakeClient({ [MYR_ID]: 'MYR', [USD_ID]: 'USD' });
    expect(
      await recordPaymentOutInRinggit({ client, orgId: 'org1' }, { ...payment, allocations: [{ bill_id: MYR_ID, amount: 1 }, { bill_id: USD_ID, amount: 1 }] }),
    ).toEqual({ ok: false, error: 'This bill is not in ringgit. Record its payment on the Payments Out screen.' });
    expect(calls.map((c) => c.kind)).toEqual(['read:finance_accounts', 'read:supplier_bills']);
  });
  it('records a ringgit one', async () => {
    const { client, calls } = fakeClient({ [MYR_ID]: 'MYR' });
    expect(await recordPaymentOutInRinggit({ client, orgId: 'org1' }, { ...payment, allocations: [{ bill_id: MYR_ID, amount: 100 }] })).toEqual({
      ok: true,
      data: { id: 'txn-1' },
    });
    expect(calls.map((c) => c.kind)).toEqual(['read:finance_accounts', 'read:supplier_bills', 'rpc:finance_record_payment_out']);
  });
  it('refuses money out of an account in another currency in its own words, before anything else (stage 5a)', async () => {
    const { client, calls } = fakeClient({ [MYR_ID]: 'MYR' }, { [BANK]: 'USD' });
    expect(await recordPaymentOutInRinggit({ client, orgId: 'org1' }, { ...payment, allocations: [{ bill_id: MYR_ID, amount: 100 }] })).toEqual({
      ok: false,
      error: 'This account is not in ringgit. Record this on the screen, where its currency and rate are shown.',
    });
    expect(calls.map((c) => c.kind)).toEqual(['read:finance_accounts']);
  });
});

describe('a payment voucher never names a bill in another currency', () => {
  it('words FIN47 for a voucher', async () => {
    const failing = { rpc: async () => ({ data: null, error: { code: 'FIN47', message: 'x' } }) } as never;
    const voucher = { kind: 'bills' as const, account_id: BANK, txn_date: TODAY, method: 'bank_transfer' as const, allocations: [{ bill_id: USD_ID, amount: 10 }] };
    expect(await saveVoucher({ client: failing, orgId: 'org1' }, voucher)).toEqual({ ok: false, error: VOUCHER_MESSAGES.foreignBill });
    expect(VOUCHER_MESSAGES.foreignBill).toBe(
      'A bill in another currency is paid on Payments Out, on the day the money leaves. It cannot wait for approval as a voucher.',
    );
    expect(VOUCHER_MESSAGES).not.toHaveProperty('foreignBillNotYet');
  });
});

/* ---- every figure that adds payments out up is in ringgit ----------------------------- */

const row = (p: Partial<PaymentOutRow>): PaymentOutRow => ({
  allocation_id: 'a', transaction_id: 't', number: 'PV-1', txn_date: '2026-10-12', method: 'bank_transfer', amount: 50,
  transaction_amount: 50, status: 'posted', reference: null, account_id: BANK, account_name: 'Main Bank',
  bill_id: MYR_ID, bill_no: 'BILL-1', supplier_name: 'Lim Hardware', ...p,
});
const MYR_PAY = row({ allocation_id: 'a1', transaction_id: 't1' });
const USD_PAY = row({
  allocation_id: 'a2', transaction_id: 't2', amount: 400, transaction_amount: 1700, bill_id: USD_ID, bill_no: 'BILL-2',
  currency: 'USD', amount_myr: 1700, carried_myr: 1680, realised_myr: -20,
});

describe('payments out added up', () => {
  it('count a foreign payment at the ringgit that left', () => {
    expect(paymentOutRinggit(USD_PAY)).toBe(1700);
    expect(paymentOutRinggit(MYR_PAY)).toBe(50);
    expect(paymentOutRinggit({ amount: 5, currency: 'USD', amount_myr: null })).toBe(0);
  });
  it('on Payments Out: paid this month (MYR 50.00 + USD 400.00 paid as RM 1,700.00 = RM 1,750), the methods, to be paid', () => {
    const view = paymentsView([MYR_PAY, USD_PAY], TODAY);
    expect(view.stats[0]).toMatchObject({ label: 'Paid (MTD)', value: 'RM 1,750' });
    expect(view.byMethod.find((s) => s.key === 'bank_transfer')?.value).toBe(1750);
    expect(view.paidMtd).toBe('RM 1,750');
  });
  it('on Supplier Bills: paid this month in ringgit', () => {
    const view = billsView([MYR_BILL, USD_BILL], [MYR_PAY, USD_PAY], TODAY);
    expect(view.stats.find((s) => s.label === 'Paid (MTD)')?.value).toBe('RM 1,750');
  });
  it('in the export, with the currency, the ringgit and the realised difference once a payment is foreign', () => {
    const lines = paymentsCsv([MYR_PAY, USD_PAY]).replace(/^﻿/, '').split(/\r?\n/);
    expect(lines[0]).toBe('Date,No.,Supplier,Bill,Account,Method,Amount,Status,Currency,Amount (RM),Carried (RM),Realised (RM)');
    expect(lines[1]).toContain(',50,Paid,MYR,50,50,0');
    expect(lines[2]).toContain(',400,Paid,USD,1700,1680,-20');
    expect(paymentsCsv([MYR_PAY]).replace(/^﻿/, '').split(/\r?\n/)[0]).toBe('Date,No.,Supplier,Bill,Account,Method,Amount,Status');
  });
});
