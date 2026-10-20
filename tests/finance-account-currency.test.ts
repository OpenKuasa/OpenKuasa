import { describe, expect, it } from 'vitest';
import {
  type BankAccountForm,
  asksOpeningRate,
  bankAccountFormError,
  bankAccountOpeningChange,
  bankAccountPayload,
  bankAccountRows,
  editBankAccountForm,
  hasForeignAccount,
  newBankAccountForm,
  openingRinggitNote,
} from '@/lib/finance/bank-account-form';
import {
  BANK_ACCOUNT_MESSAGES,
  changesOpeningBalance,
  createBankAccount,
  createBankAccountInput,
  updateBankAccount,
  updateBankAccountInput,
} from '@/lib/finance/bank-accounts';
import type { BankAccountRow } from '@/lib/finance/banking';
import { CURRENCY_MESSAGES, withCurrency, withRateAnswer, withRateTyped } from '@/lib/finance/document-currency';
import type { FinanceWriteContext } from '@/lib/finance/result';

/**
 * Stage 5a (plan .superpowers/sdd/2026-10-20-bendahara-fx-banking.md, Task 5a.3): a bank or cash account in
 * another currency, with an opening balance at a rate. Worked example A5: USD 10,000.00 at 4.4620 (BNM's 17:00
 * selling rate of Friday 16 October 2026, for a Sunday opening date) is RM 44,620.00.
 */

const M = BANK_ACCOUNT_MESSAGES;
const ID = '11111111-1111-4111-8111-111111111111';
const BNM_USD = { rate: 4.462, rate_text: '4.4620000000', rate_date: '2026-10-16', unit: 1, figure: 'selling' as const };

/** A stand-in client that records the one write and answers it. */
function fake(answer: { data: unknown; error: unknown }) {
  const calls: { op?: string; values?: Record<string, unknown> }[] = [];
  const client = {
    from() {
      const call: { op?: string; values?: Record<string, unknown> } = {};
      calls.push(call);
      const builder = {
        insert(values: Record<string, unknown>) {
          call.op = 'insert';
          call.values = values;
          return builder;
        },
        update(values: Record<string, unknown>) {
          call.op = 'update';
          call.values = values;
          return builder;
        },
        eq: () => builder,
        select: () => builder,
        maybeSingle: async () => answer,
      };
      return builder;
    },
  };
  return { ctx: { client: client as never, orgId: 'org-1' } satisfies FinanceWriteContext, calls };
}
const saved = { data: { id: ID, name: 'USD Current', active: true }, error: null };
const refused = (code: string) => ({ data: null, error: { code, message: 'the database said no' } });

/** A USD form with USD 10,000.00 on Sunday 18 October 2026 and BNM's Friday rate in the box. */
function usdForm(over: Partial<BankAccountForm> = {}): BankAccountForm {
  const base = newBankAccountForm('2026-10-18');
  const fx = withRateAnswer(withCurrency(base.fx, 'USD', true), '2026-10-18', 'USD|2026-10-18', { ok: true, rate: BNM_USD }, true);
  return { ...base, name: 'USD Current', opening: '10000', fx, ...over };
}

function account(over: Partial<BankAccountRow> = {}): BankAccountRow {
  return {
    id: ID,
    name: 'USD Current',
    kind: 'bank',
    bank_name: 'Maybank',
    opening_balance: 10000,
    opening_date: '2026-10-18',
    active: true,
    balance: 10000,
    to_be_paid: 0,
    last_import_at: null,
    unmatched_lines: 0,
    currency: 'USD',
    opening_rate_text: '4.4620000000',
    opening_rate_source: 'bnm',
    opening_rate_date: '2026-10-16',
    opening_balance_myr: 44620,
    balance_myr: 44620,
    ...over,
  };
}

describe('createBankAccountInput in another currency', () => {
  it('takes a currency, and a ringgit account still defaults to MYR', () => {
    expect(createBankAccountInput.parse({ name: 'A', kind: 'bank' }).currency).toBe('MYR');
    expect(createBankAccountInput.parse({ name: 'A', kind: 'bank', currency: 'USD' }).currency).toBe('USD');
    expect(createBankAccountInput.safeParse({ name: 'A', kind: 'bank', currency: 'XXX' }).error?.issues[0]?.message).toBe(M.currency);
  });

  it('asks a balance in another currency for its rate, and lets a balance of nothing go without one', () => {
    expect(createBankAccountInput.safeParse({ name: 'A', kind: 'bank', currency: 'USD', opening_balance: 100 }).error?.issues[0]?.message).toBe(M.rate);
    expect(createBankAccountInput.safeParse({ name: 'A', kind: 'bank', currency: 'USD', opening_balance: 0 }).success).toBe(true);
    expect(createBankAccountInput.safeParse({ name: 'A', kind: 'bank', currency: 'USD' }).success).toBe(true);
  });

  it('takes the rate as exact decimal text above 0, never a float', () => {
    const ok = createBankAccountInput.parse({
      name: 'A', kind: 'bank', currency: 'USD', opening_balance: 10000, opening_rate: '4.4620000000', opening_rate_source: 'bnm',
      opening_rate_date: '2026-10-16',
    });
    expect(ok.opening_rate).toBe('4.4620000000');
    for (const rate of ['0', '0.0000000000', '-4.46', '4.46e2', 'NaN', '12345678901', '1.12345678901', '']) {
      const parsed = createBankAccountInput.safeParse({ name: 'A', kind: 'bank', currency: 'USD', opening_balance: 1, opening_rate: rate, opening_rate_source: 'manual' });
      expect(parsed.success, rate).toBe(false);
    }
  });

  it('refuses cents in a currency with none: JPY 1.5', () => {
    const parsed = createBankAccountInput.safeParse({
      name: 'A', kind: 'bank', currency: 'JPY', opening_balance: 1.5, opening_rate: '0.029', opening_rate_source: 'manual',
    });
    expect(parsed.error?.issues[0]?.message).toBe(CURRENCY_MESSAGES.wholeUnits('JPY'));
    expect(
      createBankAccountInput.safeParse({ name: 'A', kind: 'bank', currency: 'JPY', opening_balance: 100000, opening_rate: '0.029', opening_rate_source: 'manual' }).success,
    ).toBe(true);
  });

  it('never takes a currency on a change, and counts a rate as a change to the opening balance', () => {
    const parsed = updateBankAccountInput.parse({ id: ID, name: 'A', currency: 'EUR', opening_rate: '4.5', opening_rate_source: 'manual' });
    expect(parsed).not.toHaveProperty('currency');
    expect(changesOpeningBalance(parsed)).toBe(true);
    expect(changesOpeningBalance(updateBankAccountInput.parse({ id: ID, name: 'A' }))).toBe(false);
  });
});

describe('writing an account in another currency', () => {
  it('sends a ringgit account as it always did, with no currency or rate', async () => {
    const { ctx, calls } = fake(saved);
    await createBankAccount(ctx, { name: 'Main', kind: 'bank', opening_balance: 100, opening_date: '2026-10-18' });
    expect(calls[0].values).not.toHaveProperty('currency');
    expect(calls[0].values).not.toHaveProperty('opening_rate');
  });

  it('sends the currency and the rate of a foreign balance, a BNM rate with its date and a typed one without', async () => {
    const bnm = fake(saved);
    await createBankAccount(bnm.ctx, {
      name: 'USD', kind: 'bank', currency: 'USD', opening_balance: 10000, opening_date: '2026-10-18',
      opening_rate: '4.4620000000', opening_rate_source: 'bnm', opening_rate_date: '2026-10-16',
    });
    expect(bnm.calls[0].values).toMatchObject({
      currency: 'USD', opening_rate: '4.4620000000', opening_rate_source: 'bnm', opening_rate_date: '2026-10-16',
    });
    const typed = fake(saved);
    await createBankAccount(typed.ctx, {
      name: 'IDR', kind: 'bank', currency: 'IDR', opening_balance: 15000000, opening_rate: '0.0002812345', opening_rate_source: 'manual',
      opening_rate_date: '2026-10-16',
    });
    expect(typed.calls[0].values).toMatchObject({ currency: 'IDR', opening_rate: '0.0002812345', opening_rate_source: 'manual', opening_rate_date: null });
  });

  it('sends a changed rate, never the currency', async () => {
    const { ctx, calls } = fake(saved);
    await updateBankAccount(ctx, { id: ID, name: 'USD', opening_balance: 10000, opening_rate: '4.5', opening_rate_source: 'manual' });
    expect(calls[0].values).toMatchObject({ opening_rate: '4.5', opening_rate_source: 'manual', opening_rate_date: null });
    expect(calls[0].values).not.toHaveProperty('currency');
  });

  it('words FIN38, FIN39 and a changed currency (42501)', async () => {
    expect(await createBankAccount(fake(refused('FIN38')).ctx, { name: 'A', kind: 'bank' })).toEqual({ ok: false, error: M.rate });
    expect(await createBankAccount(fake(refused('FIN39')).ctx, { name: 'A', kind: 'bank' })).toEqual({ ok: false, error: M.notBnmRate });
    expect(await updateBankAccount(fake(refused('FIN39')).ctx, { id: ID, name: 'A' })).toEqual({ ok: false, error: M.notBnmRate });
    expect((await updateBankAccount(fake(refused('42501')).ctx, { id: ID, name: 'A' })).ok).toBe(false);
  });
});

describe('the account form in another currency', () => {
  it('offers BNM selling rate for the opening date, says "About RM 44,620.00", and sends it as BNM\'s', () => {
    const form = usdForm();
    expect(form.fx.rate).toBe('4.462');
    expect(openingRinggitNote(form)).toBe('About RM 44,620.00 at this rate.');
    expect(bankAccountPayload(form, true)).toEqual({
      kind: 'bank', currency: 'USD', name: 'USD Current', bank_name: '', account_no: '', opening_balance: 10000, opening_date: '2026-10-18',
      opening_rate: '4.462', opening_rate_source: 'bnm', opening_rate_date: '2026-10-16',
    });
    expect(bankAccountFormError(form, true)).toBeNull();
  });

  it('marks a rate typed by hand as manual, with no date', () => {
    const form = usdForm();
    const typed = { ...form, fx: withRateTyped(form.fx, '4.5') };
    expect(bankAccountPayload(typed, true)).toMatchObject({ opening_rate: '4.5', opening_rate_source: 'manual' });
    expect(bankAccountPayload(typed, true)).not.toHaveProperty('opening_rate_date');
    expect(openingRinggitNote(typed)).toBe('About RM 45,000.00 at this rate.');
  });

  it('works the ringgit as the database does: IDR per 100 in the box, an overdraft, half away from zero', () => {
    const idr = usdForm({ opening: '15000000', fx: withRateTyped(withCurrency(newBankAccountForm('2026-10-18').fx, 'IDR', true), '0.02812345') });
    expect(bankAccountPayload(idr, true)).toMatchObject({ opening_rate: '0.0002812345' });
    expect(openingRinggitNote(idr)).toBe('About RM 4,218.52 at this rate.');
    const od = usdForm({ opening: '-250', fx: withRateTyped(withCurrency(newBankAccountForm('2026-10-18').fx, 'USD', true), '4.462') });
    expect(openingRinggitNote(od)).toBe('About RM -1,115.50 at this rate.');
  });

  it('asks a foreign balance for its rate before sending, and refuses cents in JPY', () => {
    const empty = usdForm({ fx: withCurrency(newBankAccountForm('2026-10-18').fx, 'USD', true) });
    expect(bankAccountFormError(empty, true)).toBe(M.rate);
    const jpy = usdForm({ opening: '1.5', fx: withRateTyped(withCurrency(newBankAccountForm('2026-10-18').fx, 'JPY', true), '2.9') });
    expect(bankAccountFormError(jpy, true)).toBe(CURRENCY_MESSAGES.wholeUnits('JPY'));
  });

  it('gives a member the currency and nothing of the balance or the rate', () => {
    const form = usdForm();
    expect(asksOpeningRate(form, false)).toBe(false);
    expect(bankAccountPayload(form, false)).toEqual({ kind: 'bank', currency: 'USD', name: 'USD Current', bank_name: '', account_no: '' });
    expect(bankAccountFormError(form, false)).toBeNull();
  });

  it('asks no rate for a foreign account with no balance', () => {
    const form = usdForm({ opening: '' });
    expect(asksOpeningRate(form, true)).toBe(false);
    expect(bankAccountPayload(form, true)).not.toHaveProperty('opening_rate');
    expect(openingRinggitNote(form)).toBeNull();
  });

  it('keeps a ringgit account exactly as it was: no currency, no rate', () => {
    const form = { ...newBankAccountForm('2026-10-18'), name: 'Main', opening: '100' };
    expect(bankAccountPayload(form, true)).toEqual({
      kind: 'bank', name: 'Main', bank_name: '', account_no: '', opening_balance: 100, opening_date: '2026-10-18',
    });
    expect(openingRinggitNote(form)).toBeNull();
  });

  it('opens a saved account with its own rate, exactly, and never sends the currency on a change', () => {
    const form = editBankAccountForm(account(), undefined, '2026-10-20');
    expect(form.fx).toMatchObject({ currency: 'USD', rate: '4.462', rateSource: 'bnm', rateDate: '2026-10-16' });
    const payload = bankAccountPayload(form, true);
    expect(payload).not.toHaveProperty('currency');
    expect(payload).toMatchObject({ opening_rate: '4.462', opening_rate_source: 'bnm', opening_rate_date: '2026-10-16' });
    expect(bankAccountOpeningChange(form, account(), true).balance).toBe(false);
    const moved = { ...form, fx: withRateTyped(form.fx, '4.5') };
    expect(bankAccountOpeningChange(moved, account(), true)).toMatchObject({ balance: true, currency: 'USD' });
  });
});

describe('the Accounts table in another currency', () => {
  it('shows the balance in its currency with its ringgit beneath, and a Currency column once one exists', () => {
    const [row] = bankAccountRows([account()]);
    expect(row).toMatchObject({
      balance: 'USD 10,000.00', ringgit: '≈ RM 44,620.00', currency: 'USD', opening: 'USD 10,000.00 as at 18 Oct 2026',
    });
    expect(hasForeignAccount([account()])).toBe(true);
    expect(hasForeignAccount([account({ currency: 'MYR' })])).toBe(false);
    const [ringgit] = bankAccountRows([account({ currency: 'MYR', balance: 50, balance_myr: 50 })]);
    expect(ringgit).toMatchObject({ balance: 'RM 50.00', ringgit: null });
  });
});
