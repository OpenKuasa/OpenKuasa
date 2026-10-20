import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { createBankAccount } from '@/lib/finance/bank-accounts';
import { listBankAccounts } from '@/lib/finance/banking';
import { billPayload, newBillForm, withSupplier } from '@/lib/finance/bill-form';
import { listBills, postBill, saveBill } from '@/lib/finance/bills';
import { createContact } from '@/lib/finance/contacts';
import { emptyLine } from '@/lib/finance/document-form';
import { withRateProvider, withRateReference, withRateTyped } from '@/lib/finance/document-currency';
import { invoicePayload, newInvoiceForm, withCustomer } from '@/lib/finance/invoice-form';
import { getInvoice, listInvoices, postInvoice, saveInvoice } from '@/lib/finance/invoices';
import {
  MONEY_MESSAGES,
  type FinanceAccount,
  listAccounts,
  listPaymentsIn,
  listPaymentsOut,
  recordPaymentIn,
  recordPaymentInRinggit,
  recordPaymentOut,
} from '@/lib/finance/money';
import { choosePaymentAccount, newPaymentForm, payableBills, paymentPayload, toggleBill, withPaymentFx } from '@/lib/finance/payment-form';
import {
  chooseReceiptAccount,
  newReceiptForm,
  receiptAccountNotes,
  receiptPayload,
  receivableInvoices,
  toggleInvoice,
  withReceiptFx,
} from '@/lib/finance/receipt-form';

// Money on a bank or cash account in another currency (stage 5b, 20261122110000_bendahara_fx_foreign_account_money)
// against the hosted database, through the app's own data layer and form rules with a real client. Run by the
// controller only, after the migration is applied. Every refusal and role cell is proved by
// supabase/tests/bendahara_fx_foreign_account_money_check.sql; this file adds what only the API shows: the forms'
// payloads with a rate are taken by PostgREST, worked examples B5 and B5.2 post to the sen, the ledger's balances
// read Receivable and Payable 0.00 with the realised difference, Banking reads the USD account's book value, a
// scheduled payment out there hears FIN47 in the screen's words, the assistant keeps to ringgit accounts, and a
// ringgit payment is what it always was. It writes no BNM rate (finance_fx_rates is shared): every rate is typed.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Ctx = { client: SupabaseClient; orgId: string };

const today = new Date().toISOString().slice(0, 10);

async function owner(orgName: string): Promise<Ctx> {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  return { client: c, orgId: orgId as string };
}

/** A USD bank account with no opening balance, as the owner adds it on Banking. */
async function usdAccount(ctx: Ctx): Promise<FinanceAccount> {
  const added = await createBankAccount(ctx, { name: 'USD Current', kind: 'bank', bank_name: 'HSBC', account_no: null, currency: 'USD' });
  if (!added.ok) throw new Error(added.error);
  const account = (await listAccounts(ctx)).find((a) => a.id === added.data.id);
  if (!account) throw new Error('the USD account is not listed');
  return account;
}

/** Worked example B5's invoice: USD 1,000.00, no SST, typed at 4.2000 from Reuters (RM 4,200.00), posted. */
async function postedUsdInvoice(ctx: Ctx) {
  const acme = await createContact(ctx, { name: 'Acme Pte Ltd', is_customer: true, is_supplier: false, default_currency: 'USD' });
  if (!acme.ok) throw new Error(acme.error);
  let form = withCustomer(newInvoiceForm(today, 'k1'), { id: acme.data.id, payment_terms_days: 30, default_currency: 'USD' });
  form = {
    ...form,
    lines: [{ ...emptyLine('k1'), description: 'Consulting', quantity: '1', unit_price: '1000', sst_rate: '0' }],
    fx: withRateProvider(withRateTyped(form.fx, '4.2000'), 'reuters'),
  };
  const saved = await saveInvoice(ctx, invoicePayload(form));
  if (!saved.ok) throw new Error(saved.error);
  expect((await postInvoice(ctx, { id: saved.data.id })).ok).toBe(true);
  return { id: saved.data.id, customerId: acme.data.id };
}

/** A part of the invoice paid into the USD account at a typed rate, as the Record payment form sends it. */
async function receiveIntoUsd(ctx: Ctx, usd: FinanceAccount, invoiceId: string, customerId: string, part: string, rate: string) {
  const receivable = receivableInvoices(await listInvoices(ctx), await listPaymentsIn(ctx));
  const invoice = receivable.find((i) => i.id === invoiceId);
  if (!invoice) throw new Error('the invoice is not offered on Record payment');
  const ticked = toggleInvoice({ ...newReceiptForm(receivable, await listAccounts(ctx), today), customerId }, invoice, true);
  const onUsd = chooseReceiptAccount(ticked, usd);
  const form = { ...withReceiptFx(onUsd, withRateTyped(onUsd.fx, rate)), amounts: { [invoiceId]: part } };
  return { result: await recordPaymentIn(ctx, receiptPayload(form)), notes: receiptAccountNotes(form, receivable) };
}

/** Each system account's balance (debit less credit), in sen so the figures are exact. */
async function balancesBySystemKey(ctx: Ctx): Promise<Map<string, number>> {
  const { data: accounts, error: accountsError } = await ctx.client
    .from('finance_ledger_accounts')
    .select('id, system_key')
    .eq('org_id', ctx.orgId);
  expect(accountsError, accountsError?.message).toBeNull();
  const { data, error } = await ctx.client
    .from('finance_ledger_balances')
    .select('account_id, debit_total, credit_total')
    .eq('org_id', ctx.orgId);
  expect(error, error?.message).toBeNull();
  const keyOf = new Map(((accounts ?? []) as { id: string; system_key: string | null }[]).map((a) => [a.id, a.system_key]));
  const out = new Map<string, number>();
  for (const row of (data ?? []) as { account_id: string; debit_total: string; credit_total: string }[]) {
    const key = keyOf.get(row.account_id);
    if (key) out.set(key, (out.get(key) ?? 0) + Math.round(Number(row.debit_total) * 100) - Math.round(Number(row.credit_total) * 100));
  }
  return out;
}

testWithSupabase('worked example B5: a USD invoice paid into a USD account in two parts, with its realised loss and gain', async () => {
  const ctx = await owner(`FX account money ${Date.now()}`);
  const usd = await usdAccount(ctx);
  const { id, customerId } = await postedUsdInvoice(ctx);

  // Payment 1: USD 400.00 at 4.15 is RM 1,660.00; the invoice carried RM 1,680.00, a loss of RM 20.00.
  const first = await receiveIntoUsd(ctx, usd, id, customerId, '400', '4.15');
  expect(first.result.ok, first.result.ok ? '' : first.result.error).toBe(true);
  expect(first.notes).toEqual([
    'About RM 1,660.00 at this rate.',
    'The invoice carries about RM 1,680.00 for what is paid.',
    'Realised exchange loss of about RM 20.00.',
  ]);
  // Payment 2: USD 600.00 at 4.25 is RM 2,550.00; it closes the invoice, carried RM 2,520.00, a gain of RM 30.00.
  const second = await receiveIntoUsd(ctx, usd, id, customerId, '600', '4.25');
  expect(second.result.ok, second.result.ok ? '' : second.result.error).toBe(true);
  expect(await getInvoice(ctx, id)).toMatchObject({ balance: 0, balance_myr: 0, display_status: 'paid' });

  const rows = (await listPaymentsIn(ctx)).filter((p) => p.invoice_id === id).sort((a, b) => a.amount - b.amount);
  expect(
    rows.map((p) => [p.transaction_currency, p.transaction_amount, p.transaction_amount_myr, p.amount_myr, p.carried_myr, p.realised_myr]),
  ).toEqual([
    ['USD', 400, 1660, 1660, 1680, -20],
    ['USD', 600, 2550, 2550, 2520, 30],
  ]);

  // Receivable back at 0.00; Realised Exchange Gain or Loss a net credit (gain) of 10.00.
  const balances = await balancesBySystemKey(ctx);
  expect(balances.get('receivable')).toBe(0);
  expect(balances.get('fx_realised')).toBe(-1000);
  // The USD account reads USD 1,000.00 with a book value of RM 4,210.00.
  expect((await listBankAccounts(ctx)).find((a) => a.id === usd.id)).toMatchObject({ currency: 'USD', balance: 1000, balance_myr: 4210 });
});

testWithSupabase('worked example B5.2: the A4 bill paid from the USD account at 4.10 leaves Payable at 0.00 and a gain of RM 108.00', async () => {
  const ctx = await owner(`FX account pay out ${Date.now()}`);
  const usd = await usdAccount(ctx);
  const acme = await createContact(ctx, { name: 'Acme Supplies Pte Ltd', is_customer: false, is_supplier: true, default_currency: 'USD' });
  if (!acme.ok) throw new Error(acme.error);
  let billForm = withSupplier(newBillForm(today, 'k1'), { id: acme.data.id, payment_terms_days: 30, default_currency: 'USD' });
  billForm = {
    ...billForm,
    lines: [{ ...emptyLine('k1'), description: 'Machine', quantity: '1', unit_price: '1000', sst_rate: '8' }],
    fx: withRateReference(withRateProvider(withRateTyped(billForm.fx, '4.2000'), 'malaysian_bank'), 'Maybank'),
  };
  const saved = await saveBill(ctx, billPayload(billForm));
  if (!saved.ok) throw new Error(saved.error);
  expect((await postBill(ctx, { id: saved.data.id })).ok).toBe(true);

  const payable = payableBills(await listBills(ctx), await listPaymentsOut(ctx));
  const bill = payable.find((b) => b.id === saved.data.id);
  if (!bill) throw new Error('the bill is not offered on Payments Out');
  const ticked = toggleBill({ ...newPaymentForm(payable, await listAccounts(ctx), today), supplierId: acme.data.id }, bill, true);
  const onUsd = choosePaymentAccount(ticked, usd);
  const form = withPaymentFx(onUsd, withRateTyped(onUsd.fx, '4.1'));
  const paid = await recordPaymentOut(ctx, paymentPayload(form));
  expect(paid.ok, paid.ok ? '' : paid.error).toBe(true);

  const balances = await balancesBySystemKey(ctx);
  expect(balances.get('payable')).toBe(0);
  expect(balances.get('fx_realised')).toBe(-10800);

  // Scheduled from the USD account: FIN47, in the screen's words, and nothing written.
  const before = (await listPaymentsOut(ctx)).length;
  const scheduled = await recordPaymentOut(ctx, {
    account_id: usd.id, txn_date: today, method: 'bank_transfer', scheduled: true, fx_rate: '4.1', fx_rate_source: 'manual',
    allocations: [{ bill_id: saved.data.id, amount: 1 }],
  });
  expect(scheduled).toEqual({ ok: false, error: MONEY_MESSAGES.payNowAccount });
  expect((await listPaymentsOut(ctx)).length).toBe(before);
});

testWithSupabase('the assistant keeps to ringgit accounts, and a ringgit payment is what it always was', async () => {
  const ctx = await owner(`FX account ringgit ${Date.now()}`);
  const usd = await usdAccount(ctx);
  const kedai = await createContact(ctx, { name: 'Kedai Runcit Sdn Bhd', is_customer: true, is_supplier: false });
  if (!kedai.ok) throw new Error(kedai.error);
  let form = withCustomer(newInvoiceForm(today, 'k1'), { id: kedai.data.id, payment_terms_days: 30, default_currency: null });
  form = { ...form, lines: [{ ...emptyLine('k1'), description: 'Goods', quantity: '1', unit_price: '100', sst_rate: '0' }] };
  const saved = await saveInvoice(ctx, invoicePayload(form));
  if (!saved.ok) throw new Error(saved.error);
  expect((await postInvoice(ctx, { id: saved.data.id })).ok).toBe(true);

  expect(
    await recordPaymentInRinggit(ctx, {
      account_id: usd.id, txn_date: today, method: 'bank_transfer', allocations: [{ invoice_id: saved.data.id, amount: 100 }],
    }),
  ).toEqual({ ok: false, error: MONEY_MESSAGES.foreignAccountByAssistant });

  const [bank] = (await listAccounts(ctx)).filter((a) => a.kind === 'bank' && a.currency === 'MYR');
  const paid = await recordPaymentIn(ctx, {
    account_id: bank.id, txn_date: today, method: 'bank_transfer', allocations: [{ invoice_id: saved.data.id, amount: 100 }],
  });
  expect(paid.ok, paid.ok ? '' : paid.error).toBe(true);
  if (!paid.ok) return;
  const { data: movement } = await ctx.client
    .from('finance_transactions')
    .select('currency, fx_rate_text:fx_rate::text, fx_rate_source, amount_myr')
    .eq('id', paid.data.id)
    .maybeSingle();
  expect(movement).toEqual({ currency: 'MYR', fx_rate_text: '1.0000000000', fx_rate_source: null, amount_myr: null });
  const row = (await listPaymentsIn(ctx)).find((p) => p.transaction_id === paid.data.id);
  expect(row).toMatchObject({ transaction_currency: 'MYR', transaction_amount: 100, transaction_amount_myr: 100, amount_myr: 100 });
});
