import { describe, expect, it } from 'vitest';
import {
  cashReceiptAccounts,
  cashReceiptFormError,
  chooseCashReceiptAccount,
  chooseCashReceiptKind,
  newCashReceiptForm,
  recordCashReceiptPayload,
} from '@/lib/finance/cash-receipt-form';
import { CASH_RECEIPT_MESSAGES, recordCashReceipt, recordCashReceiptInput } from '@/lib/finance/cash-receipts';
import { withRateTyped } from '@/lib/finance/document-currency';
import {
  billPaymentPreview,
  movementRinggitSen,
  movementRinggitText,
  refundPreview,
  settlementPreview,
} from '@/lib/finance/fx-settlement';
import {
  type FinanceAccount,
  MONEY_MESSAGES,
  RECEIPT_MESSAGES,
  recordPaymentIn,
  recordPaymentInToolInput,
  recordPaymentOut,
  recordPaymentOutInput,
} from '@/lib/finance/money';
import { MOVEMENT_MESSAGES, movementRatePayload } from '@/lib/finance/movement-rate';
import {
  PAYMENT_OUT_KIND,
  type PayableBill,
  choosePaymentAccount,
  needsRinggit as needsRinggitOut,
  newPaymentForm,
  offeredBills,
  paymentAccountNotes,
  paymentAccounts,
  paymentFormError,
  paymentPayload,
  toggleBill,
  withPaymentFx,
} from '@/lib/finance/payment-form';
import {
  PAYMENT_IN_KIND,
  type ReceivableInvoice,
  chooseReceiptAccount,
  needsRinggit,
  newReceiptForm,
  offeredInvoices,
  receiptAccountNotes,
  receiptAccounts,
  receiptFormError,
  receiptPayload,
  toggleInvoice,
  withReceiptFx,
} from '@/lib/finance/receipt-form';
import { type RefundTarget, chooseRefundAccount, newRefundForm, offeredRefundTargets, refundFormError, refundPayload, refundPreviewNotes, withRefundFx } from '@/lib/finance/refund-form';
import { REFUND_MESSAGES } from '@/lib/finance/refunds';
import {
  FOREIGN_ACCOUNT_HINT,
  chooseVoucherAccount,
  chooseVoucherKind,
  newVoucherForm,
  voucherAccounts,
  voucherFormError,
  voucherPayload,
  voucherPaysNow,
  voucherSaveHint,
  withVoucherFx,
} from '@/lib/finance/voucher-form';
import { VOUCHER_MESSAGES, recordVoucherInput } from '@/lib/finance/vouchers';
import { fakeFinance } from './setup/fake-finance';

/**
 * Stage 5b: money on a bank or cash account in another currency (plan .superpowers/sdd/2026-10-20-bendahara-fx-banking.md,
 * "Worked examples" B5 to B5.4). The movement is in the account's currency; its ringgit is its amount at its rate, to
 * the sen; that ringgit is shared over the documents as a ringgit payment's is. Every figure here is the plan's.
 */

const BANK: FinanceAccount = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Maybank', kind: 'bank', bank_name: 'Maybank', currency: 'MYR' };
const USD: FinanceAccount = { id: '00000000-0000-4000-8000-0000000000a2', name: 'USD Current', kind: 'bank', bank_name: 'HSBC', currency: 'USD' };
const SGD: FinanceAccount = { id: '00000000-0000-4000-8000-0000000000a3', name: 'SGD Current', kind: 'bank', bank_name: 'DBS', currency: 'SGD' };
const ACCOUNTS = [BANK, USD, SGD];
const TODAY = '2026-10-20';
const CUSTOMER = '00000000-0000-4000-8000-00000000c001';
const SUPPLIER = '00000000-0000-4000-8000-00000000d001';
const I_USD = '00000000-0000-4000-8000-00000000e001';
const I_MYR = '00000000-0000-4000-8000-00000000e002';
const B_USD = '00000000-0000-4000-8000-00000000f001';

/** A typed rate on a form's rate part: the box takes ringgit per one USD. */
const typed = <F extends { fx: Parameters<typeof withRateTyped>[0] }>(form: F, rate: string): F => ({ ...form, fx: withRateTyped(form.fx, rate) });

const invoice = (id: string, currency: string, balance: number, balanceMyr: number, rate: string): ReceivableInvoice => ({
  id, invoice_no: `INV-${id.slice(-3)}`, customer_id: CUSTOMER, customer_name: 'Overseas Ltd', due_date: '2026-11-01', overdue: false,
  balance, held: 0, payable: balance, currency, fx_rate_text: rate, balance_myr: balanceMyr,
});
const RECEIVABLE = [invoice(I_USD, 'USD', 1000, 4200, '4.2000000000'), invoice(I_MYR, 'MYR', 50, 50, '1.0000000000')];

const BILL: PayableBill = {
  id: B_USD, bill_no: 'BILL-A4', supplier_id: SUPPLIER, supplier_name: 'Overseas Supplier Ltd', purchase_order_id: null,
  currency: 'USD', due_date: '2026-11-01', overdue: false, balance: 1080, scheduled: 0, payable: 1080,
  fx_rate_text: '4.2000000000', balance_myr: 4536,
};

describe('a movement in ringgit at its rate (finance_transaction_to_currency)', () => {
  it('is its amount at its rate, to the sen, half away from zero', () => {
    expect(movementRinggitText('400', '4.1500000000')).toBe('1660.00');
    expect(movementRinggitText('600', '4.25')).toBe('2550.00');
    // B5.3: interest USD 3.17 at 4.4620 is 14.14454, so RM 14.14; a bank charge of USD 25.00 is RM 111.55.
    expect(movementRinggitText('3.17', '4.4620000000')).toBe('14.14');
    expect(movementRinggitText('25', '4.462')).toBe('111.55');
    // B5.5: JPY 100,000 at 0.0285.
    expect(movementRinggitText('100000', '0.0285000000')).toBe('2850.00');
    expect(movementRinggitSen(BigInt(1), BigInt(5) * BigInt(10) ** BigInt(9))).toBe(BigInt(1));
  });
  it('is nothing while a figure is not a number above 0', () => {
    expect(movementRinggitText('', '4.15')).toBeNull();
    expect(movementRinggitText('400', '')).toBeNull();
    expect(movementRinggitText('400', '0')).toBeNull();
    expect(movementRinggitText('1,200', '4.15')).toBeNull();
  });
});

describe('the worked examples, previewed as the database settles them', () => {
  it('B5 payment 1: USD 400.00 at 4.15 on an invoice at 4.20 is RM 1,660.00 against RM 1,680.00 carried: a loss of RM 20.00', () => {
    const preview = settlementPreview(movementRinggitText('400', '4.15')!, [
      { id: I_USD, amount: '400', rateText: '4.2000000000', openForeign: 1000, openRinggit: 4200 },
    ]);
    expect(preview).toEqual({ parts: [{ id: I_USD, ringgit: 1660, carried: 1680, realised: -20 }], carried: 1680, realised: -20 });
  });
  it('B5 payment 2: USD 600.00 at 4.25 closes the invoice: carried RM 2,520.00, a gain of RM 30.00', () => {
    const preview = settlementPreview(movementRinggitText('600', '4.25')!, [
      { id: I_USD, amount: '600', rateText: '4.2000000000', openForeign: 600, openRinggit: 2520 },
    ]);
    expect(preview?.carried).toBe(2520);
    expect(preview?.realised).toBe(30);
  });
  it('B5.1: USD 30.00 at 4.4444 over three invoices of USD 10.00 shares RM 133.33 as 44.45, 44.44, 44.44', () => {
    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
    const ringgit = movementRinggitText('30', '4.4444');
    expect(ringgit).toBe('133.33');
    const preview = settlementPreview(ringgit!, ids.map((id) => ({ id, amount: '10', rateText: '4.2000000000', openForeign: 10, openRinggit: 42 })));
    expect(preview?.parts.map((p) => p.ringgit)).toEqual([44.45, 44.44, 44.44]);
    expect(preview?.carried).toBe(126);
    expect(preview?.realised).toBe(7.33);
  });
  it('B5.2: the A4 bill, USD 1,080.00 carried at RM 4,536.00, paid at 4.10 is RM 4,428.00: a gain of RM 108.00', () => {
    const preview = billPaymentPreview(movementRinggitText('1080', '4.1')!, [
      { id: B_USD, amount: '1080', rateText: '4.2000000000', openForeign: 1080, openRinggit: 4536 },
    ]);
    expect(preview?.carried).toBe(4536);
    expect(preview?.realised).toBe(108);
  });
  it('B5.4: a refund of USD 100.00 at 4.30 on a credit of USD 100.00 carried at RM 420.00 is a loss of RM 10.00', () => {
    expect(refundPreview(movementRinggitText('100', '4.3')!, '100', '4.2000000000', 100, 420)).toEqual({ carried: 420, realised: -10 });
  });
});

describe('Record payment on Invoices, into an account in another currency', () => {
  const ticked = toggleInvoice(newReceiptForm(RECEIVABLE, ACCOUNTS, TODAY), RECEIVABLE[0], true);
  const onUsd = chooseReceiptAccount({ ...ticked, customerId: CUSTOMER }, USD);

  it('offers the ringgit accounts, and the USD one once a USD invoice is ticked', () => {
    expect(receiptAccounts(newReceiptForm(RECEIVABLE, ACCOUNTS, TODAY), ACCOUNTS)).toEqual([BANK]);
    expect(receiptAccounts(ticked, ACCOUNTS)).toEqual([BANK, USD]);
    // The default is never an account in another currency.
    expect(newReceiptForm(RECEIVABLE, [USD, BANK], TODAY).accountId).toBe(BANK.id);
  });
  it('on the USD account offers only USD invoices, asks no ringgit but the rate, and sends the rate', () => {
    expect(offeredInvoices(onUsd, RECEIVABLE).map((i) => i.id)).toEqual([I_USD]);
    expect(needsRinggit(onUsd)).toBe(false);
    expect(receiptFormError(onUsd, RECEIVABLE)).toBe(MOVEMENT_MESSAGES.rate);
    const rated = typed(onUsd, '4.15');
    expect(receiptFormError({ ...rated, amounts: { [I_USD]: '400' } }, RECEIVABLE)).toBeNull();
    const payload = receiptPayload({ ...rated, amounts: { [I_USD]: '400' } });
    expect(payload).toMatchObject({ account_id: USD.id, fx_rate: '4.15', fx_rate_source: 'manual' });
    expect(payload).not.toHaveProperty('amount_myr');
    expect(payload).not.toHaveProperty('fx_rate_date');
  });
  it('says what B5 payment 1 comes to, as "about"', () => {
    const rated = { ...typed(onUsd, '4.15'), amounts: { [I_USD]: '400' } };
    expect(receiptAccountNotes(rated, RECEIVABLE)).toEqual([
      'About RM 1,660.00 at this rate.',
      'The invoice carries about RM 1,680.00 for what is paid.',
      'Realised exchange loss of about RM 20.00.',
    ]);
    expect(PAYMENT_IN_KIND.account?.notes(rated, RECEIVABLE)).toHaveLength(3);
  });
  it('choosing the USD account lets go of ticks in another currency; going back to ringgit drops the rate', () => {
    const myrTicked = toggleInvoice({ ...newReceiptForm(RECEIVABLE, ACCOUNTS, TODAY), customerId: CUSTOMER }, RECEIVABLE[1], true);
    expect(chooseReceiptAccount(myrTicked, USD).amounts).toEqual({});
    const back = chooseReceiptAccount(withReceiptFx(onUsd, onUsd.fx), BANK);
    expect(back.fx.currency).toBe('MYR');
    expect(needsRinggit(back)).toBe(true);
  });
});

describe('Payments Out, from an account in another currency', () => {
  const ticked = toggleBill({ ...newPaymentForm([BILL], ACCOUNTS, TODAY), supplierId: SUPPLIER }, BILL, true);
  const onUsd = choosePaymentAccount({ ...ticked, scheduled: true }, USD);

  it('offers the USD account once a USD bill is ticked, and on it only USD bills, paid now, with no ringgit box', () => {
    expect(paymentAccounts(ticked, ACCOUNTS)).toEqual([BANK, USD]);
    expect(offeredBills(onUsd, [BILL]).map((b) => b.id)).toEqual([B_USD]);
    expect(onUsd.scheduled).toBe(false);
    expect(PAYMENT_OUT_KIND.schedule?.offered?.(onUsd)).toBe(false);
    expect(needsRinggitOut(onUsd)).toBe(false);
  });
  it('asks for the rate, then sends it with the bills, and previews B5.2', () => {
    expect(paymentFormError(onUsd, [BILL])).toBe(MOVEMENT_MESSAGES.rate);
    const rated = withPaymentFx(onUsd, withRateTyped(onUsd.fx, '4.1'));
    expect(paymentFormError(rated, [BILL])).toBeNull();
    const payload = paymentPayload(rated);
    expect(recordPaymentOutInput.parse(payload)).toMatchObject({ fx_rate: '4.1', fx_rate_source: 'manual', scheduled: false });
    expect(payload).not.toHaveProperty('amount_myr');
    expect(paymentAccountNotes(rated, [BILL])).toEqual([
      'About RM 4,428.00 at this rate.',
      'The bill carries about RM 4,536.00 for what is paid.',
      'Realised exchange gain of about RM 108.00.',
    ]);
  });
  it('refuses "Schedule for later" on the USD account in its own words', () => {
    const rated = withPaymentFx(onUsd, withRateTyped(onUsd.fx, '4.1'));
    expect(paymentFormError({ ...rated, scheduled: true }, [BILL])).toBe(MONEY_MESSAGES.payNowAccount);
  });
});

describe('Refunds, from an account in another currency', () => {
  const target: RefundTarget = {
    key: `note:${I_USD}`, kind: 'credit_note', id: I_USD, number: 'CN-0001', invoice_id: I_USD, invoice_no: 'INV-001',
    customer_name: 'Overseas Ltd', refundable: 100, currency: 'USD', fx_rate_text: '4.2000000000', credit: 100, credit_myr: 420,
  };
  const myrTarget: RefundTarget = { ...target, key: `invoice:${I_MYR}`, kind: 'invoice', id: I_MYR, currency: 'MYR', fx_rate_text: '1.0000000000' };
  const form = { ...newRefundForm([target, myrTarget], ACCOUNTS, TODAY, target.key), reason: 'damaged_goods' as const };
  const onUsd = chooseRefundAccount(form, USD, [target, myrTarget]);

  it('offers only that currency’s invoices and credit notes, paid out now, and previews B5.4', () => {
    expect(offeredRefundTargets(onUsd, [target, myrTarget]).map((t) => t.key)).toEqual([target.key]);
    expect(refundFormError(onUsd, [target])).toBe(MOVEMENT_MESSAGES.rate);
    const rated = withRefundFx(onUsd, withRateTyped(onUsd.fx!, '4.3'));
    expect(refundFormError(rated, [target])).toBeNull();
    expect(refundFormError({ ...rated, scheduled: true }, [target])).toBe(REFUND_MESSAGES.payNowAccount);
    expect(refundPayload(rated, [target])).toMatchObject({ credit_note_id: I_USD, amount: 100, fx_rate: '4.3' });
    expect(refundPayload(rated, [target])).not.toHaveProperty('amount_myr');
    expect(refundPreviewNotes(rated, [target])).toEqual([
      'About RM 430.00 at this rate.',
      'The invoice carries about RM 420.00 for what is refunded.',
      'Realised exchange loss of about RM 10.00.',
    ]);
  });
});

describe('Payment Vouchers, from an account in another currency', () => {
  const category = { id: '00000000-0000-4000-8000-00000000b001', name: 'Bank charges' };
  const base = { ...newVoucherForm(ACCOUNTS, [category], TODAY), payeeName: 'The bank', amount: '25' };
  const onUsd = chooseVoucherAccount(base, USD);

  it('lists every account for a new category voucher, ringgit ones for bills and drafts', () => {
    expect(voucherAccounts(base, ACCOUNTS)).toEqual(ACCOUNTS);
    expect(voucherAccounts({ ...base, kind: 'bills' }, ACCOUNTS)).toEqual([BANK]);
    expect(voucherAccounts({ ...base, id: '00000000-0000-4000-8000-00000000b002' }, ACCOUNTS)).toEqual([BANK]);
    // Back on a ringgit account the voucher is To be paid again (review N3); one chosen paid now on ringgit keeps it.
    expect(chooseVoucherAccount(onUsd, BANK).paidNow).toBeUndefined();
    expect(chooseVoucherAccount({ ...base, paidNow: true }, BANK).paidNow).toBe(true);
    // A voucher for bills lets go of an account in another currency.
    expect(chooseVoucherKind(onUsd, 'bills')).toMatchObject({ kind: 'bills', accountId: '' });
  });
  it('is paid now by an owner or admin, with its rate; a member is told first', () => {
    expect(voucherPaysNow(true, onUsd)).toBe(true);
    expect(voucherPaysNow(false, onUsd)).toBe(false);
    expect(voucherSaveHint(false, onUsd)).toEqual([VOUCHER_MESSAGES.payNowAccount]);
    expect(VOUCHER_MESSAGES.payNowAccount).toBe('A payment from an account in another currency is recorded paid, by an owner or admin.');
    expect(voucherSaveHint(true, onUsd)).toEqual([FOREIGN_ACCOUNT_HINT]);
    expect(voucherFormError(onUsd, [], false)).toBe(VOUCHER_MESSAGES.payNowAccount);
    expect(voucherFormError(onUsd, [], true)).toBe(MOVEMENT_MESSAGES.rate);
    const rated = withVoucherFx(onUsd, withRateTyped(onUsd.fx!, '4.4620'));
    expect(voucherFormError(rated, [], true)).toBeNull();
    expect(recordVoucherInput.parse(voucherPayload(rated, voucherPaysNow(true, rated)))).toMatchObject({
      paid_now: true, amount: 25, fx_rate: '4.462', fx_rate_source: 'manual',
    });
  });
});

describe('Cash Receipts: income into an account in another currency, recorded at once', () => {
  const category = { id: '00000000-0000-4000-8000-00000000b003', name: 'Interest' };
  const base = { ...newCashReceiptForm(ACCOUNTS, [category], TODAY), amount: '3.17', payerName: 'The bank' };
  const onUsd = chooseCashReceiptAccount(base, USD);

  it('offers every account for new income, ringgit ones for invoices and drafts, and is for income on the USD account', () => {
    expect(cashReceiptAccounts(base, ACCOUNTS)).toEqual(ACCOUNTS);
    expect(cashReceiptAccounts({ ...base, kind: 'invoice' }, ACCOUNTS)).toEqual([BANK]);
    expect(cashReceiptAccounts({ ...base, id: '00000000-0000-4000-8000-00000000b004' }, ACCOUNTS)).toEqual([BANK]);
    expect(chooseCashReceiptAccount({ ...base, kind: 'invoice' }, USD).kind).toBe('income');
    expect(chooseCashReceiptKind(onUsd, 'invoice')).toMatchObject({ kind: 'invoice', accountId: '' });
    expect(CASH_RECEIPT_MESSAGES.invoicesOnInvoices('USD')).toBe('Record a payment of an invoice in USD on Invoices.');
  });
  it('is recorded by an owner or admin with its rate (a member is told first) through finance_record_cash_receipt', () => {
    expect(cashReceiptFormError(onUsd, [], false)).toBe(CASH_RECEIPT_MESSAGES.postedByDecider);
    expect(cashReceiptFormError(onUsd, [], true)).toBe(MOVEMENT_MESSAGES.rate);
    const rated = { ...onUsd, fx: withRateTyped(onUsd.fx!, '4.462') };
    expect(cashReceiptFormError(rated, [], true)).toBeNull();
    expect(recordCashReceiptInput.parse(recordCashReceiptPayload(rated))).toMatchObject({
      account_id: USD.id, category_id: category.id, amount: 3.17, fx_rate: '4.462', fx_rate_source: 'manual',
    });
  });
});

describe('the data layer', () => {
  it('sends a rate only when there is one, and words FIN38, FIN39, FIN50 and FIN51 for money in', async () => {
    const allocations = [{ invoice_id: I_USD, amount: 400 }];
    const base = { account_id: USD.id, txn_date: TODAY, method: 'fpx' as const, allocations };
    const { ctx, calls } = fakeFinance({ data: 'txn-1', error: null });
    await recordPaymentIn(ctx, { ...base, fx_rate: '4.15', fx_rate_source: 'manual' });
    expect(calls[0].args?.payment).toMatchObject({ fx_rate: '4.15', fx_rate_source: 'manual' });
    expect(calls[0].args?.payment).not.toHaveProperty('fx_rate_date');
    const ringgit = fakeFinance({ data: 'txn-2', error: null });
    await recordPaymentIn(ringgit.ctx, { ...base, account_id: BANK.id });
    expect(ringgit.calls[0].args?.payment).not.toHaveProperty('fx_rate');
    for (const [code, sentence] of [
      ['FIN38', MOVEMENT_MESSAGES.rate],
      ['FIN39', MOVEMENT_MESSAGES.notBnmRate],
      ['FIN50', MOVEMENT_MESSAGES.draft],
      ['FIN51', RECEIPT_MESSAGES.foreignAccountInvoices],
    ] as const) {
      const refused = fakeFinance({ data: null, error: { code } });
      expect(await recordPaymentIn(refused.ctx, base)).toEqual({ ok: false, error: sentence });
    }
  });
  it('words FIN47 on an account in another currency as that account’s "paid now", and a bill’s as before', async () => {
    const payment = { account_id: USD.id, txn_date: TODAY, method: 'bank_transfer' as const, allocations: [{ bill_id: B_USD, amount: 10 }] };
    const refused = () => fakeFinance({ data: null, error: { code: 'FIN47' } }).ctx;
    expect(await recordPaymentOut(refused(), { ...payment, fx_rate: '4.1', fx_rate_source: 'manual' })).toEqual({
      ok: false,
      error: MONEY_MESSAGES.payNowAccount,
    });
    expect(await recordPaymentOut(refused(), { ...payment, amount_myr: '42' })).toEqual({ ok: false, error: MONEY_MESSAGES.payNow });
  });
  it('records income at once and reads its number back', async () => {
    const { ctx, calls } = fakeFinance((call) =>
      call.kind === 'rpc' ? { data: 'txn-9', error: null } : { data: { number: 'RC-0009' }, error: null },
    );
    const answer = await recordCashReceipt(ctx, {
      account_id: USD.id, txn_date: TODAY, method: 'bank_transfer', category_id: '00000000-0000-4000-8000-00000000b003',
      amount: 3.17, party_name: 'The bank', fx_rate: '4.462', fx_rate_source: 'bnm', fx_rate_date: '2026-10-16',
    });
    expect(answer).toEqual({ ok: true, data: { id: 'txn-9', number: 'RC-0009' } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_record_cash_receipt' });
    expect(calls[0].args?.receipt).toMatchObject({ fx_rate: '4.462', fx_rate_source: 'bnm', fx_rate_date: '2026-10-16' });
  });
  it('keeps the assistant on ringgit accounts: its inputs take no rate', () => {
    expect(Object.keys(recordPaymentInToolInput.shape)).not.toContain('fx_rate');
    expect(movementRatePayload(undefined)).toEqual({});
  });
});
