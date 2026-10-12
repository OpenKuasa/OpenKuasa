/**
 * FIN37, "money does not move on an archived account" (20261116110000): every write of the three data layers
 * that can meet it today answers with one sentence, and the migration is read as text beside the ones before it.
 * Nothing here touches a database.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { postCashReceipt, saveCashReceipt } from '@/lib/finance/cash-receipts';
import { markPaymentPaid, recordPaymentIn, recordPaymentOut } from '@/lib/finance/money';
import { markRefundPaid, recordRefund } from '@/lib/finance/refunds';
import { ACCOUNT_ARCHIVED, FIN_ACCOUNT_ARCHIVED } from '@/lib/finance/result';
import { type FinanceCall, fakeFinance } from './setup/fake-finance';

const TXN = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';
const DOCUMENT = '77777777-7777-4777-8777-777777777777';
const CATEGORY = '99999999-9999-4999-8999-999999999999';

/** Every check a write makes first finds its row; the database function then refuses with FIN37. */
const archived = () =>
  fakeFinance((call: FinanceCall) =>
    call.op === 'rpc' ? { data: null, error: { code: 'FIN37', message: 'money does not move on an archived account' } } : { data: [{ transaction_id: TXN }], error: null },
  );
const REFUSED = { ok: false, error: 'The account this is on has been archived. Restore it on Banking, or use another account, then try again.' };

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

describe('a payment the database refuses because its account is archived', () => {
  it('has one code and one sentence', () => {
    expect(FIN_ACCOUNT_ARCHIVED).toBe('FIN37');
    expect(ACCOUNT_ARCHIVED).toBe(REFUSED.error);
  });

  it('is worded by Payments Out: recording a payment and marking a scheduled one paid', async () => {
    const payment = { account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx' as const, allocations: [{ bill_id: DOCUMENT, amount: 100 }] };
    expect(await recordPaymentOut(archived().ctx, payment)).toEqual(REFUSED);
    expect(await recordPaymentOut(archived().ctx, { ...payment, scheduled: true })).toEqual(REFUSED);
    expect(await markPaymentPaid(archived().ctx, { id: TXN, paid_on: '2026-10-09' })).toEqual(REFUSED);
  });

  it('is worded by Payments In', async () => {
    const payment = { account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx' as const, allocations: [{ invoice_id: DOCUMENT, amount: 100 }] };
    expect(await recordPaymentIn(archived().ctx, payment)).toEqual(REFUSED);
  });

  it('is worded by Cash Receipts: a new draft, a draft moved onto the account, and posting a draft that is on it', async () => {
    const receipt = { kind: 'income' as const, account_id: ACCOUNT, txn_date: '2026-10-05', method: 'cash' as const, category_id: CATEGORY, amount: 50, party_name: 'Walk-in' };
    expect(await saveCashReceipt(archived().ctx, receipt)).toEqual(REFUSED);
    expect(await saveCashReceipt(archived().ctx, { ...receipt, id: TXN })).toEqual(REFUSED);
    expect(await postCashReceipt(archived().ctx, { id: TXN })).toEqual(REFUSED);
  });

  it('is worded by Refunds: recording one and paying a pending one out', async () => {
    const refund = { invoice_id: DOCUMENT, account_id: ACCOUNT, txn_date: '2026-10-06', method: 'fpx' as const, reason: 'damaged_goods' as const, amount: 240 };
    expect(await recordRefund(archived().ctx, refund)).toEqual(REFUSED);
    expect(await recordRefund(archived().ctx, { ...refund, scheduled: true })).toEqual(REFUSED);
    expect(await markRefundPaid(archived().ctx, { id: TXN, paid_on: '2026-10-09' })).toEqual(REFUSED);
  });

  it('is not logged as an unknown failure', async () => {
    await postCashReceipt(archived().ctx, { id: TXN });
    expect(logged).not.toHaveBeenCalled();
  });
});

const DIR = join(__dirname, '..', 'supabase', 'migrations');
const NAME = '20261116110000_bendahara_archived_account_rule.sql';
/** The statements of a file, without its comments. */
const sql = (name: string) =>
  readFileSync(join(DIR, name), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
const text = sql(NAME);
const earlier = readdirSync(DIR)
  .filter((name) => name.endsWith('.sql') && name < NAME)
  .map(sql)
  .join('\n');

test('the migration replaces nothing: one new function and two new triggers', () => {
  expect(text).not.toMatch(/create or replace/);
  expect(text).not.toMatch(/drop (function|trigger|view|policy|table|index|constraint)|alter (function|table)|create (table|policy|view)|add column/);
  expect([...text.matchAll(/create function ([\w.]+)\(/g)].map((m) => m[1])).toEqual(['private.finance_transaction_account_guard']);
  expect([...text.matchAll(/create trigger (\w+)/g)].map((m) => m[1])).toEqual(['finance_use_account_insert', 'finance_use_account_update']);
  expect(earlier).not.toMatch(/finance_transaction_account_guard|finance_use_account_/);
  // Nothing earlier raises the code, and nothing here grants anything to anyone.
  expect(earlier).not.toContain('FIN37');
  expect([...text.matchAll(/FIN\d\d/g)].map((m) => m[0])).toEqual(['FIN37']);
  expect(text).not.toMatch(/\bgrant\b/);
});

test('the two triggers fire after every guard that was there and before the stamp that must be last', () => {
  const before = [...earlier.matchAll(/create trigger (\w+)\s+before (?:insert|update|delete)[^;]*?on public\.finance_transactions\b/g)].map((m) => m[1]);
  expect([...new Set(before)].sort()).toEqual([
    'finance_transaction_guard',
    'finance_transaction_insert_guard',
    'finance_transaction_sign_off',
    'finance_transfer_id_guard',
    'finance_void_stamp',
  ]);
  for (const name of ['finance_use_account_insert', 'finance_use_account_update']) {
    for (const guard of before.filter((b) => b !== 'finance_void_stamp')) expect(name > guard).toBe(true);
    expect(name < 'finance_void_stamp').toBe(true);
  }
});

test('the guard runs as its owner with a fixed search path, locks the account row, and nobody can call it', () => {
  const start = text.indexOf('create function private.finance_transaction_account_guard()');
  const body = text.slice(start, text.indexOf('end $$;', start));
  expect(body).toContain('security definer');
  expect(body).toContain("set search_path = ''");
  expect(body).toContain('(select auth.uid()) is null');
  expect(body).toMatch(/where a\.org_id = new\.org_id and a\.id = new\.account_id\s+for share;/);
  expect(text).toContain('revoke all on function private.finance_transaction_account_guard() from public, anon, authenticated, service_role;');
  expect(text).toMatch(/before update on public\.finance_transactions\s+for each row\s+when \(new\.account_id is distinct from old\.account_id\s+or \(new\.status in \('pending_approval','scheduled','posted'\) and new\.status is distinct from old\.status\)\)/);
  expect(text).toContain('lock table public.finance_transactions in share row exclusive mode nowait;');
});

test('service_role is revoked from every finance table and view an earlier migration made', () => {
  const made = new Set(
    [...earlier.matchAll(/create (?:or replace )?(?:table|view) public\.((?:finance_|supplier_bill)\w*)/g)].map((m) => m[1]),
  );
  const dropped = new Set([...earlier.matchAll(/drop table public\.(\w+)/g)].map((m) => m[1]));
  const list = text.slice(text.indexOf('foreach t in array array['), text.indexOf('] loop'));
  const named = [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]);
  expect(named).toHaveLength(43);
  expect([...named].sort()).toEqual([...made].filter((name) => !dropped.has(name)).sort());
  expect(text).toContain("execute format('revoke all on public.%I from service_role', t);");
});
