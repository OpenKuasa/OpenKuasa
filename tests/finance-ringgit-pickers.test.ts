import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type FinanceAccount, ringgitAccounts } from '@/lib/finance/money';

/**
 * Stage 5a: money does not move on an account in another currency yet (FIN50), so every money form is handed
 * ringgit accounts only. The screens that read accounts for a form read them through `listRinggitAccounts`.
 */

const MAYBANK: FinanceAccount = { id: 'a1', name: 'Maybank', kind: 'bank', bank_name: 'Maybank', currency: 'MYR' };
const TILL: FinanceAccount = { id: 'a2', name: 'Cash in hand', kind: 'cash', bank_name: null, currency: 'MYR' };
const USD: FinanceAccount = { id: 'a3', name: 'USD Current', kind: 'bank', bank_name: 'HSBC', currency: 'USD' };

const SCREENS = [
  'cash-receipts', 'credit-notes', 'expenses', 'invoices', 'payment-vouchers', 'payments-in', 'payments-out', 'refunds',
  'supplier-bills',
];

describe('the money pickers', () => {
  it('offer ringgit accounts only, in the order given', () => {
    expect(ringgitAccounts([MAYBANK, USD, TILL])).toEqual([MAYBANK, TILL]);
    expect(ringgitAccounts([USD])).toEqual([]);
  });

  it.each(SCREENS)('the %s screen reads its form accounts through listRinggitAccounts', (screen) => {
    const source = readFileSync(new URL(`../src/screens/finance/${screen}.tsx`, import.meta.url), 'utf8');
    expect(source).toContain('listRinggitAccounts(ctx)');
    expect(source).not.toMatch(/\blistAccounts\(/);
  });
});
