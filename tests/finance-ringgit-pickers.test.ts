import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type FinanceAccount, ringgitAccounts } from '@/lib/finance/money';
import { movementAccounts } from '@/lib/finance/movement-rate';

/**
 * Stage 5b: money moves on an account in another currency for documents in its currency, recorded paid with its
 * rate. The payment screens read every active account, and each form offers ringgit accounts plus those in its
 * documents' currency (`movementAccounts`); drafts list ringgit ones. An expense is paid from a ringgit account only
 * (FIN51), so the Expenses screen still reads `listRinggitAccounts`.
 */

const MAYBANK: FinanceAccount = { id: 'a1', name: 'Maybank', kind: 'bank', bank_name: 'Maybank', currency: 'MYR' };
const TILL: FinanceAccount = { id: 'a2', name: 'Cash in hand', kind: 'cash', bank_name: null, currency: 'MYR' };
const USD: FinanceAccount = { id: 'a3', name: 'USD Current', kind: 'bank', bank_name: 'HSBC', currency: 'USD' };
const SGD: FinanceAccount = { id: 'a4', name: 'SGD Current', kind: 'bank', bank_name: 'DBS', currency: 'SGD' };

const EVERY_ACCOUNT = [
  'cash-receipts', 'credit-notes', 'invoices', 'payment-vouchers', 'payments-in', 'payments-out', 'refunds', 'supplier-bills',
];
const RINGGIT_ONLY = ['expenses'];

describe('the money pickers', () => {
  it('ringgitAccounts keeps ringgit accounts only, in the order given', () => {
    expect(ringgitAccounts([MAYBANK, USD, TILL])).toEqual([MAYBANK, TILL]);
    expect(ringgitAccounts([USD])).toEqual([]);
  });

  it('a payment form offers ringgit accounts, and those in its documents’ currency', () => {
    const all = [MAYBANK, USD, TILL, SGD];
    expect(movementAccounts(all, null, MAYBANK.id)).toEqual([MAYBANK, TILL]);
    expect(movementAccounts(all, 'MYR', MAYBANK.id)).toEqual([MAYBANK, TILL]);
    expect(movementAccounts(all, 'USD', MAYBANK.id)).toEqual([MAYBANK, USD, TILL]);
    // The account already chosen stays offered.
    expect(movementAccounts(all, null, SGD.id)).toEqual([MAYBANK, TILL, SGD]);
  });

  it.each(EVERY_ACCOUNT)('the %s screen reads every active account for its form', (screen) => {
    const source = readFileSync(new URL(`../src/screens/finance/${screen}.tsx`, import.meta.url), 'utf8');
    expect(source).toContain('listAccounts(ctx)');
    expect(source).not.toMatch(/\blistRinggitAccounts\(/);
  });

  it.each(RINGGIT_ONLY)('the %s screen reads its form accounts through listRinggitAccounts', (screen) => {
    const source = readFileSync(new URL(`../src/screens/finance/${screen}.tsx`, import.meta.url), 'utf8');
    expect(source).toContain('listRinggitAccounts(ctx)');
    expect(source).not.toMatch(/\blistAccounts\(/);
  });
});
