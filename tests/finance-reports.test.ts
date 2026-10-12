import { describe, expect, it } from 'vitest';
import type { AccountType, LedgerAccount, LedgerLine } from '@/lib/finance/ledger';
import {
  balanceSheet,
  balanceSheetCsv,
  chartState,
  countUnassigned,
  expenseBreakdown,
  isValidPeriod,
  lastDayOfMonth,
  monthEndLabel,
  monthlySeries,
  monthlyTotals,
  monthsIn,
  periodFor,
  periodLabel,
  profitAndLoss,
  profitAndLossCsv,
  rangeMessage,
  sliceTotal,
  trialBalance,
  trialBalanceCsv,
  type MonthlyTotals,
  type Period,
} from '@/lib/finance/reports';

const account = (code: string, name: string, type: AccountType): LedgerAccount => ({
  id: `a-${code}`, code, name, type, active: true, stands_for: 'own', system_key: null, bank_account_id: null,
  category_id: null, default_for: null, debit_total: 0, credit_total: 0, balance: 0,
});

const BANK = account('1100', 'Main Bank', 'asset');
const AR = account('1200', 'Trade Receivables', 'asset');
const SPARE = account('1900', 'Spare Asset', 'asset');
const AP = account('2000', 'Trade Payables', 'liability');
const SST = account('2100', 'SST Payable', 'liability');
const CAPITAL = account('3000', 'Owner’s Capital', 'equity');
const SALES = account('4000', 'Sales', 'income');
const PURCHASES = account('5000', 'Purchases', 'expense');
const UTILITIES = account('6300', 'Utilities', 'expense');
const ACCOUNTS = [BANK, AR, SPARE, AP, SST, CAPITAL, SALES, PURCHASES, UTILITIES];

type Side = [LedgerAccount | null, number, number];
const entry = (key: string, date: string, sides: Side[]): LedgerLine[] =>
  sides.map(([a, debit, credit]) => ({
    entry_key: key, entry_date: date, source: 'journal', source_id: key, source_no: null, description: key,
    account_id: a ? a.id : null, debit, credit,
  }));

/**
 * The books of a small business, 2026. Every entry balances.
 *   Jan  owner puts in 10,000.00; invoice of 1,000.00 plus 60.00 SST (6%), owed 1,060.00
 *   Feb  the customer pays 1,060.00; a supplier bill of 400.00
 *   Mar  the bill is paid; an approved expense of 150.50 (utilities, paid from the bank); a second invoice 500.00 + 30.00 SST
 *   Apr  the second invoice is voided: its reversal is dated in April
 */
const LINES: LedgerLine[] = [
  ...entry('capital', '2026-01-02', [[BANK, 10000, 0], [CAPITAL, 0, 10000]]),
  ...entry('inv-1', '2026-01-15', [[AR, 1060, 0], [SALES, 0, 1000], [SST, 0, 60]]),
  ...entry('rcp-1', '2026-02-10', [[BANK, 1060, 0], [AR, 0, 1060]]),
  ...entry('bill-1', '2026-02-20', [[PURCHASES, 400, 0], [AP, 0, 400]]),
  ...entry('pay-1', '2026-03-05', [[AP, 400, 0], [BANK, 0, 400]]),
  ...entry('exp-1', '2026-03-12', [[UTILITIES, 150.5, 0], [BANK, 0, 150.5]]),
  ...entry('inv-2', '2026-03-20', [[AR, 530, 0], [SALES, 0, 500], [SST, 0, 30]]),
  ...entry('inv-2:void', '2026-04-03', [[SALES, 500, 0], [SST, 30, 0], [AR, 0, 530]]),
];
const { totals: TOTALS } = monthlyTotals(LINES);
const only = (month: string): Period => ({ from: month, to: month });
const names = (rows: { name: string }[]) => rows.map((r) => r.name);

describe('monthlyTotals', () => {
  it('adds each account and month up, keeping debit and credit apart', () => {
    const { totals, unassigned } = monthlyTotals([
      ...entry('a', '2026-03-01', [[BANK, 100, 0], [SALES, 0, 100]]),
      ...entry('b', '2026-03-31', [[BANK, 50, 0], [SALES, 0, 50]]),
      ...entry('c', '2026-04-01', [[BANK, 0, 20], [SALES, 20, 0]]),
    ]);
    expect(unassigned).toBe(0);
    expect(totals).toEqual([
      { account_id: 'a-1100', month: '2026-03', debit: 150, credit: 0 },
      { account_id: 'a-1100', month: '2026-04', debit: 0, credit: 20 },
      { account_id: 'a-4000', month: '2026-03', debit: 0, credit: 150 },
      { account_id: 'a-4000', month: '2026-04', debit: 20, credit: 0 },
    ]);
  });
  it('drops lines with no account and counts them', () => {
    const { totals, unassigned } = monthlyTotals(entry('x', '2026-03-01', [[BANK, 10, 0], [null, 0, 6], [null, 0, 4]]));
    expect(unassigned).toBe(2);
    expect(totals).toEqual([{ account_id: 'a-1100', month: '2026-03', debit: 10, credit: 0 }]);
  });
  it('has one row per account and month that has a line, and none for an empty ledger', () => {
    // January 5 accounts, February 4, March 6, April 3.
    expect(TOTALS).toHaveLength(18);
    expect(monthlyTotals([])).toEqual({ totals: [], unassigned: 0 });
  });
  it('is exact to the sen: 0.10 plus 0.20, and a thousand lines of 0.01', () => {
    const small = monthlyTotals([
      ...entry('a', '2026-03-01', [[BANK, 0.1, 0], [SALES, 0, 0.1]]),
      ...entry('b', '2026-03-02', [[BANK, 0.2, 0], [SALES, 0, 0.2]]),
    ]).totals;
    expect(small.find((t) => t.account_id === 'a-1100')?.debit).toBe(0.3);
    const many = monthlyTotals(
      Array.from({ length: 1000 }, (_, i) => entry(`k${i}`, '2026-03-01', [[BANK, 0.01, 0], [SALES, 0, 0.01]])).flat(),
    ).totals;
    expect(many.find((t) => t.account_id === 'a-1100')?.debit).toBe(10);
    expect(many.find((t) => t.account_id === 'a-4000')?.credit).toBe(10);
  });
});

describe('periods', () => {
  const none: MonthlyTotals = [];
  it('are worked out from a mid-year date', () => {
    const today = '2026-05-20';
    expect(periodFor('this_month', today, none)).toEqual(only('2026-05'));
    expect(periodFor('last_month', today, none)).toEqual(only('2026-04'));
    expect(periodFor('this_quarter', today, none)).toEqual({ from: '2026-04', to: '2026-05' });
    expect(periodFor('this_year', today, none)).toEqual({ from: '2026-01', to: '2026-05' });
    expect(periodFor('last_year', today, none)).toEqual({ from: '2025-01', to: '2025-12' });
  });
  it('start the quarter on its first calendar month and run to the current month', () => {
    expect(periodFor('this_quarter', '2026-07-01', none)).toEqual(only('2026-07'));
    expect(periodFor('this_quarter', '2026-12-31', none)).toEqual({ from: '2026-10', to: '2026-12' });
    expect(periodFor('this_quarter', '2026-03-09', none)).toEqual({ from: '2026-01', to: '2026-03' });
  });
  it('cross the year in January', () => {
    const today = '2027-01-09';
    expect(periodFor('this_month', today, none)).toEqual(only('2027-01'));
    expect(periodFor('last_month', today, none)).toEqual(only('2026-12'));
    expect(periodFor('this_quarter', today, none)).toEqual(only('2027-01'));
    expect(periodFor('this_year', today, none)).toEqual(only('2027-01'));
    expect(periodFor('last_year', today, none)).toEqual({ from: '2026-01', to: '2026-12' });
  });
  it('run all time from the earliest month with a line, or from this month when there is none', () => {
    expect(periodFor('all_time', '2026-05-20', TOTALS)).toEqual({ from: '2026-01', to: '2026-05' });
    expect(periodFor('all_time', '2026-05-20', none)).toEqual(only('2026-05'));
    // an entry dated after this month is in the books, so all time runs on to it
    expect(periodFor('all_time', '2026-05-20', [{ account_id: 'x', month: '2026-09', debit: 1, credit: 0 }])).toEqual({ from: '2026-05', to: '2026-09' });
    expect(periodFor('all_time', '2026-05-20', [...TOTALS, { account_id: 'x', month: '2026-07', debit: 1, credit: 0 }])).toEqual({ from: '2026-01', to: '2026-07' });
    expect(periodFor('this_year', '2026-05-20', [{ account_id: 'x', month: '2026-09', debit: 1, credit: 0 }])).toEqual({ from: '2026-01', to: '2026-05' });
  });
  it('list their months, including a year boundary', () => {
    expect(monthsIn({ from: '2025-11', to: '2026-02' })).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthsIn(only('2026-05'))).toEqual(['2026-05']);
    expect(monthsIn({ from: '2026-05', to: '2026-01' })).toEqual([]);
  });
  it('are valid when both ends are real months and from is not after to', () => {
    expect(isValidPeriod({ from: '2026-01', to: '2026-01' })).toBe(true);
    expect(isValidPeriod({ from: '2025-12', to: '2026-01' })).toBe(true);
    expect(isValidPeriod({ from: '2026-02', to: '2026-01' })).toBe(false);
    expect(isValidPeriod({ from: '2026-13', to: '2026-14' })).toBe(false);
    expect(isValidPeriod({ from: '2026-00', to: '2026-01' })).toBe(false);
    expect(isValidPeriod({ from: '', to: '2026-01' })).toBe(false);
    expect(isValidPeriod({ from: '2026-1', to: '2026-01' })).toBe(false);
    expect(isValidPeriod({ from: '2026-01-01', to: '2026-02' })).toBe(false);
  });
  it('accept only years 1900 to 2999, so a typed year can never break the arithmetic', () => {
    expect(isValidPeriod({ from: '2026-01', to: '9999-12' })).toBe(false);
    expect(isValidPeriod({ from: '1899-12', to: '2026-01' })).toBe(false);
    expect(isValidPeriod({ from: '0002-01', to: '2026-01' })).toBe(false);
    expect(isValidPeriod({ from: '1900-01', to: '2999-12' })).toBe(true);
    expect(isValidPeriod({ from: '2026-01', to: '3000-01' })).toBe(false);
    expect(() => monthsIn({ from: '2026-01', to: '9999-12' })).not.toThrow();
    expect(monthsIn({ from: '2026-01', to: '9999-12' })).toEqual([]);
    expect(monthsIn({ from: '0050-01', to: '0050-06' })).toEqual([]);
  });
  it('count 300 months across many year boundaries', () => {
    const months = monthsIn({ from: '2000-01', to: '2024-12' });
    expect(months).toHaveLength(300);
    expect(months[0]).toBe('2000-01');
    expect(months[11]).toBe('2000-12');
    expect(months[12]).toBe('2001-01');
    expect(months[299]).toBe('2024-12');
    expect(monthsIn({ from: '2999-11', to: '2999-12' })).toEqual(['2999-11', '2999-12']);
  });
  it('name the range problem: both months, or the order', () => {
    expect(rangeMessage({ from: '2026-01', to: '2026-03' })).toBeNull();
    expect(rangeMessage({ from: '2026-03', to: '2026-03' })).toBeNull();
    expect(rangeMessage({ from: '2026-04', to: '2026-03' })).toBe('Choose a From month that is not after the To month.');
    expect(rangeMessage({ from: '', to: '2026-03' })).toBe('Enter both months.');
    expect(rangeMessage({ from: '2026-01', to: '' })).toBe('Enter both months.');
    expect(rangeMessage({ from: '2026-1', to: '2026-03' })).toBe('Enter both months.');
    expect(rangeMessage({ from: '2026-01', to: '9999-12' })).toBe('Enter both months.');
  });
  it('are put in words', () => {
    expect(periodLabel(only('2026-10'))).toBe('October 2026');
    expect(periodLabel({ from: '2026-01', to: '2026-10' })).toBe('January to October 2026');
    expect(periodLabel({ from: '2025-07', to: '2026-06' })).toBe('July 2025 to June 2026');
    expect(periodLabel({ from: '2026-01', to: '2026-12' })).toBe('January to December 2026');
  });
  it('name the last day of a month, leap years included', () => {
    expect(lastDayOfMonth('2026-10')).toBe('2026-10-31');
    expect(lastDayOfMonth('2026-04')).toBe('2026-04-30');
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
    expect(lastDayOfMonth('2028-02')).toBe('2028-02-29');
    // 2100 is divisible by 100 but not 400: not a leap year
    expect(lastDayOfMonth('2100-02')).toBe('2100-02-28');
    expect(lastDayOfMonth('2000-02')).toBe('2000-02-29');
    expect(lastDayOfMonth('1900-02')).toBe('1900-02-28');
    expect(lastDayOfMonth('2999-12')).toBe('2999-12-31');
    expect(lastDayOfMonth('2026-12')).toBe('2026-12-31');
    expect(monthEndLabel('2026-10')).toBe('31 October 2026');
    expect(monthEndLabel('2028-02')).toBe('29 February 2028');
  });
});

describe('profitAndLoss', () => {
  it('shows one month: January has the sale and nothing else', () => {
    const pl = profitAndLoss(ACCOUNTS, TOTALS, only('2026-01'));
    expect(pl.income).toEqual([{ account_id: 'a-4000', code: '4000', name: 'Sales', amount: 1000 }]);
    expect(pl.expenses).toEqual([]);
    expect(pl).toMatchObject({ totalIncome: 1000, totalExpenses: 0, netProfit: 1000, margin: 1 });
  });
  it('shows a loss and no margin when there is no income', () => {
    const pl = profitAndLoss(ACCOUNTS, TOTALS, only('2026-02'));
    expect(pl.income).toEqual([]);
    expect(pl.expenses).toEqual([{ account_id: 'a-5000', code: '5000', name: 'Purchases', amount: 400 }]);
    expect(pl).toMatchObject({ totalIncome: 0, totalExpenses: 400, netProfit: -400, margin: null });
  });
  it('shows March: income 500, expenses 150.50, profit 349.50', () => {
    const pl = profitAndLoss(ACCOUNTS, TOTALS, only('2026-03'));
    expect(pl).toMatchObject({ totalIncome: 500, totalExpenses: 150.5, netProfit: 349.5, margin: 0.699 });
    expect(names(pl.expenses)).toEqual(['Utilities']);
  });
  it('lets a void in a later month take the sale back out: April income is minus 500', () => {
    const pl = profitAndLoss(ACCOUNTS, TOTALS, only('2026-04'));
    expect(pl.income).toEqual([{ account_id: 'a-4000', code: '4000', name: 'Sales', amount: -500 }]);
    expect(pl).toMatchObject({ totalIncome: -500, netProfit: -500 });
    // a margin on negative income would be a meaningless positive number
    expect(pl.margin).toBeNull();
  });
  it('shows the year: the voided invoice nets to nothing', () => {
    const pl = profitAndLoss(ACCOUNTS, TOTALS, { from: '2026-01', to: '2026-12' });
    expect(pl.income.map((l) => l.amount)).toEqual([1000]);
    expect(pl.expenses.map((l) => [l.name, l.amount])).toEqual([['Purchases', 400], ['Utilities', 150.5]]);
    expect(pl).toMatchObject({ totalIncome: 1000, totalExpenses: 550.5, netProfit: 449.5, margin: 0.4495 });
  });
  it('leaves out balance sheet accounts and accounts with no movement in the period', () => {
    const pl = profitAndLoss(ACCOUNTS, TOTALS, only('2026-01'));
    expect([...pl.income, ...pl.expenses].map((l) => l.code)).toEqual(['4000']);
    // Purchases has movement only in February, so January leaves it out, and a period before the books has nothing
    const before = profitAndLoss(ACCOUNTS, TOTALS, only('2025-12'));
    expect(before).toEqual({ income: [], expenses: [], totalIncome: 0, totalExpenses: 0, netProfit: 0, margin: null });
  });
  it('orders each section by code, whatever order the accounts came in', () => {
    const pl = profitAndLoss([UTILITIES, PURCHASES, SALES], TOTALS, { from: '2026-01', to: '2026-12' });
    expect(pl.expenses.map((l) => l.code)).toEqual(['5000', '6300']);
  });
  it('is exact to the sen', () => {
    const { totals } = monthlyTotals([
      ...entry('a', '2026-03-01', [[BANK, 0.1, 0], [SALES, 0, 0.1]]),
      ...entry('b', '2026-03-02', [[BANK, 0.2, 0], [SALES, 0, 0.2]]),
      ...entry('c', '2026-03-03', [[UTILITIES, 0.1, 0], [BANK, 0, 0.1]]),
    ]);
    const pl = profitAndLoss(ACCOUNTS, totals, only('2026-03'));
    expect(pl.totalIncome).toBe(0.3);
    expect(pl.netProfit).toBe(0.2);
    const thousand = monthlyTotals(
      Array.from({ length: 1000 }, (_, i) => entry(`k${i}`, '2026-03-01', [[BANK, 0.01, 0], [SALES, 0, 0.01]])).flat(),
    ).totals;
    expect(profitAndLoss(ACCOUNTS, thousand, only('2026-03')).totalIncome).toBe(10);
  });
});

describe('balanceSheet', () => {
  const at = (month: string) => balanceSheet(ACCOUNTS, TOTALS, only(month));
  const amounts = (rows: { code: string; amount: number }[]) => rows.map((r) => [r.code, r.amount]);

  it('balances at the end of January', () => {
    const bs = at('2026-01');
    expect(bs.asAt).toBe('2026-01');
    expect(amounts(bs.assets)).toEqual([['1100', 10000], ['1200', 1060]]);
    expect(amounts(bs.liabilities)).toEqual([['2100', 60]]);
    expect(amounts(bs.equity)).toEqual([['3000', 10000]]);
    expect(bs).toMatchObject({ currentEarnings: 1000, totalAssets: 11060, totalLiabilities: 60, totalEquity: 11000, balanced: true });
  });
  it('balances at the end of February: the receivable is settled but still listed at 0.00', () => {
    const bs = at('2026-02');
    expect(amounts(bs.assets)).toEqual([['1100', 11060], ['1200', 0]]);
    expect(amounts(bs.liabilities)).toEqual([['2000', 400], ['2100', 60]]);
    expect(bs).toMatchObject({ currentEarnings: 600, totalAssets: 11060, totalLiabilities: 460, totalEquity: 10600, balanced: true });
  });
  it('balances at the end of March', () => {
    const bs = at('2026-03');
    expect(amounts(bs.assets)).toEqual([['1100', 10509.5], ['1200', 530]]);
    expect(amounts(bs.liabilities)).toEqual([['2000', 0], ['2100', 90]]);
    expect(bs).toMatchObject({ currentEarnings: 949.5, totalAssets: 11039.5, totalLiabilities: 90, totalEquity: 10949.5, balanced: true });
  });
  it('balances at the end of April, after the void', () => {
    const bs = at('2026-04');
    expect(amounts(bs.assets)).toEqual([['1100', 10509.5], ['1200', 0]]);
    expect(amounts(bs.liabilities)).toEqual([['2000', 0], ['2100', 60]]);
    expect(bs).toMatchObject({ currentEarnings: 449.5, totalAssets: 10509.5, totalLiabilities: 60, totalEquity: 10449.5, balanced: true });
  });
  it('has current earnings equal to the profit and loss from the beginning of the books to that date', () => {
    for (const month of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-09']) {
      const bs = at(month);
      const pl = profitAndLoss(ACCOUNTS, TOTALS, { from: '2000-01', to: month });
      expect(bs.currentEarnings, month).toBe(pl.netProfit);
      expect(bs.balanced, month).toBe(true);
    }
  });
  it('ignores period.from: it is cumulative from the beginning of the books', () => {
    const bs = balanceSheet(ACCOUNTS, TOTALS, { from: '2026-04', to: '2026-04' });
    expect(bs).toEqual(at('2026-04'));
  });
  it('leaves out an account with no balance and no activity, and lists the equity section with current earnings apart', () => {
    const bs = at('2026-04');
    expect(bs.assets.map((l) => l.code)).not.toContain('1900');
    expect(bs.equity.map((l) => l.code)).toEqual(['3000']);
  });
  it('shows an account whose only movement is before the period, because the sheet is cumulative', () => {
    // the bank moved in January alone; as at April it still holds the money, though April's P&L and trial balance omit it
    const april = only('2026-04');
    expect(trialBalance(ACCOUNTS, TOTALS, april).rows.map((r) => r.code)).not.toContain('1100');
    expect(balanceSheet(ACCOUNTS, TOTALS, april).assets.map((l) => l.code)).toContain('1100');
    expect(profitAndLoss(ACCOUNTS, TOTALS, only('2026-02')).income).toEqual([]);
  });
  it('gives empty statements that still balance for a date before the first line', () => {
    const bs = at('2025-12');
    expect(bs).toEqual({
      asAt: '2025-12', assets: [], liabilities: [], equity: [], currentEarnings: 0, totalAssets: 0, totalLiabilities: 0,
      totalEquity: 0, balanced: true,
    });
  });
  it('shows an asset in credit, such as an overdrawn bank, as a negative asset and not as a liability', () => {
    const { totals } = monthlyTotals(entry('od', '2026-03-01', [[BANK, 0, 300], [UTILITIES, 300, 0]]));
    const bs = balanceSheet(ACCOUNTS, totals, only('2026-03'));
    expect(amounts(bs.assets)).toEqual([['1100', -300]]);
    expect(bs.liabilities).toEqual([]);
    expect(bs).toMatchObject({ totalAssets: -300, currentEarnings: -300, totalEquity: -300, balanced: true });
  });
  it('flags books that do not balance, to the sen', () => {
    const { totals } = monthlyTotals(entry('bad', '2026-03-01', [[BANK, 100.01, 0], [CAPITAL, 0, 100]]));
    expect(balanceSheet(ACCOUNTS, totals, only('2026-03')).balanced).toBe(false);
  });
  it('is exact to the sen across a thousand small lines', () => {
    const { totals } = monthlyTotals(
      Array.from({ length: 1000 }, (_, i) => entry(`k${i}`, '2026-03-01', [[BANK, 0.01, 0], [CAPITAL, 0, 0.01]])).flat(),
    );
    const bs = balanceSheet(ACCOUNTS, totals, only('2026-03'));
    expect(bs.totalAssets).toBe(10);
    expect(bs.totalEquity).toBe(10);
    expect(bs.balanced).toBe(true);
  });
});

describe('trialBalance', () => {
  it('lists movement within the period, not net, ordered by code, with equal totals', () => {
    const tb = trialBalance(ACCOUNTS, TOTALS, only('2026-03'));
    expect(tb.rows.map((r) => [r.code, r.debit, r.credit])).toEqual([
      ['1100', 0, 550.5],
      ['1200', 530, 0],
      ['2000', 400, 0],
      ['2100', 0, 30],
      ['4000', 0, 500],
      ['6300', 150.5, 0],
    ]);
    expect(tb.rows[0]).toMatchObject({ account_id: 'a-1100', name: 'Main Bank', type: 'asset' });
    expect(tb).toMatchObject({ totalDebit: 1080.5, totalCredit: 1080.5, balanced: true });
  });
  it('keeps debit and credit apart for the year: sales has 500 of debits and 1,500 of credits', () => {
    const tb = trialBalance(ACCOUNTS, TOTALS, { from: '2026-01', to: '2026-12' });
    expect(tb.rows.find((r) => r.code === '4000')).toMatchObject({ debit: 500, credit: 1500 });
    expect(tb.rows.find((r) => r.code === '1100')).toMatchObject({ debit: 11060, credit: 550.5 });
    expect(tb.rows.map((r) => r.code)).not.toContain('1900');
    expect(tb).toMatchObject({ totalDebit: 14130.5, totalCredit: 14130.5, balanced: true });
  });
  it('has equal totals for every month and for any run of months', () => {
    for (const from of ['2026-01', '2026-02', '2026-03', '2026-04']) {
      for (const to of ['2026-03', '2026-04', '2026-06']) {
        if (from > to) continue;
        const tb = trialBalance(ACCOUNTS, TOTALS, { from, to });
        expect(tb.totalDebit, `${from}..${to}`).toBe(tb.totalCredit);
        expect(tb.balanced).toBe(true);
      }
    }
  });
  it('is empty and balanced for a period before the first line', () => {
    expect(trialBalance(ACCOUNTS, TOTALS, only('2025-06'))).toEqual({ rows: [], totalDebit: 0, totalCredit: 0, balanced: true });
  });
  it('leaves out an account whose only movement is outside the period', () => {
    expect(trialBalance(ACCOUNTS, TOTALS, only('2026-04')).rows.map((r) => r.code)).toEqual(['1200', '2100', '4000']);
  });
});

describe('monthlySeries', () => {
  it('gives one point per month of the period, empty months included', () => {
    const series = monthlySeries(ACCOUNTS, TOTALS, { from: '2026-01', to: '2026-05' });
    expect(series).toEqual([
      { month: '2026-01', label: 'Jan', revenue: 1000, expenses: 0, net: 1000 },
      { month: '2026-02', label: 'Feb', revenue: 0, expenses: 400, net: -400 },
      { month: '2026-03', label: 'Mar', revenue: 500, expenses: 150.5, net: 349.5 },
      { month: '2026-04', label: 'Apr', revenue: -500, expenses: 0, net: -500 },
      { month: '2026-05', label: 'May', revenue: 0, expenses: 0, net: 0 },
    ]);
  });
  it('returns at most the last 24 months of the period, and says the year when it spans years', () => {
    const series = monthlySeries(ACCOUNTS, TOTALS, { from: '2020-01', to: '2026-04' });
    expect(series).toHaveLength(24);
    expect(series[0]).toMatchObject({ month: '2024-05', label: 'May 24' });
    expect(series[23]).toMatchObject({ month: '2026-04', label: 'Apr 26', revenue: -500 });
    expect(monthlySeries(ACCOUNTS, TOTALS, { from: '2025-01', to: '2026-12' })).toHaveLength(24);
    expect(monthlySeries(ACCOUNTS, TOTALS, { from: '2025-01', to: '2027-01' })).toHaveLength(24);
  });
  it('is empty for an invalid period', () => {
    expect(monthlySeries(ACCOUNTS, TOTALS, { from: '2026-05', to: '2026-01' })).toEqual([]);
  });
});

describe('chartState', () => {
  const plOf = (income: number, expense: number) =>
    profitAndLoss(
      ACCOUNTS,
      [
        ...(income ? [{ account_id: 'a-4000', month: '2020-03', debit: 0, credit: income }] : []),
        ...(expense ? [{ account_id: 'a-5000', month: '2020-03', debit: expense, credit: 0 }] : []),
      ],
      { from: '2020-01', to: '2024-12' },
    );
  it('is quiet only when the statement has no income and no expense lines', () => {
    const period = { from: '2020-01', to: '2024-12' };
    expect(chartState(plOf(0, 0), period).quiet).toBe(true);
    expect(chartState(plOf(10, 0), period).quiet).toBe(false);
    expect(chartState(plOf(0, 10), period).quiet).toBe(false);
  });
  it('is not quiet for 60 months with activity only in the first 12, and says the chart shows the last 24', () => {
    const period = { from: '2020-01', to: '2024-12' };
    const state = chartState(plOf(500, 200), period);
    expect(monthlySeries(ACCOUNTS, [{ account_id: 'a-4000', month: '2020-03', debit: 0, credit: 500 }], period).every((p) => p.revenue === 0)).toBe(true);
    expect(state).toEqual({ quiet: false, subtitle: 'Last 24 months' });
  });
  it('says By month for a period of 24 months or fewer', () => {
    expect(chartState(plOf(1, 1), { from: '2023-01', to: '2024-12' }).subtitle).toBe('By month');
    expect(chartState(plOf(1, 1), { from: '2022-12', to: '2024-12' }).subtitle).toBe('Last 24 months');
  });
});

describe('sliceTotal', () => {
  it('adds the slices, so a negative expense line left out of the ring is not in the centre', () => {
    const pl = {
      income: [], totalIncome: 0, totalExpenses: 350, netProfit: -350, margin: null,
      expenses: [
        { account_id: 'a', code: '5000', name: 'Purchases', amount: 400 },
        { account_id: 'b', code: '6300', name: 'Utilities', amount: -50 },
      ],
    };
    expect(sliceTotal(expenseBreakdown(pl))).toBe(400);
    expect(sliceTotal([{ value: 0.1 }, { value: 0.2 }])).toBe(0.3);
    expect(sliceTotal([])).toBe(0);
  });
});

describe('countUnassigned', () => {
  it('counts lines with no account and lines whose account is not in the list', () => {
    const lines = entry('x', '2026-03-01', [[BANK, 10, 0], [null, 0, 6], [SALES, 0, 4]]);
    lines.push({ ...lines[0], account_id: 'gone', debit: 1 });
    expect(countUnassigned(lines, [BANK, SALES])).toBe(2);
    expect(countUnassigned(lines, ACCOUNTS)).toBe(2);
    expect(countUnassigned(lines, [BANK])).toBe(3);
    expect(countUnassigned([], [])).toBe(0);
  });
});

describe('expenseBreakdown', () => {
  const plWith = (amounts: number[]) => {
    const expenses = amounts.map((amount, i) => ({ account_id: `e${i}`, code: String(5000 + i), name: `Cat ${i}`, amount }));
    return { income: [], expenses, totalIncome: 0, totalExpenses: 0, netProfit: 0, margin: null };
  };
  it('lists the expense accounts largest first', () => {
    expect(expenseBreakdown(profitAndLoss(ACCOUNTS, TOTALS, { from: '2026-01', to: '2026-12' }))).toEqual([
      { key: 'a-5000', label: 'Purchases', value: 400 },
      { key: 'a-6300', label: 'Utilities', value: 150.5 },
    ]);
  });
  it('keeps five and sums the rest into Other when there are more than six', () => {
    const slices = expenseBreakdown(plWith([10, 70, 20, 60, 30, 50, 40, 5]));
    expect(slices.map((s) => [s.label, s.value])).toEqual([
      ['Cat 1', 70], ['Cat 3', 60], ['Cat 5', 50], ['Cat 6', 40], ['Cat 4', 30], ['Other', 35],
    ]);
    expect(slices).toHaveLength(6);
    expect(slices[5].key).toBe('other');
  });
  it('keeps exactly six as they are', () => {
    const slices = expenseBreakdown(plWith([6, 5, 4, 3, 2, 1]));
    expect(slices.map((s) => s.label)).toEqual(['Cat 0', 'Cat 1', 'Cat 2', 'Cat 3', 'Cat 4', 'Cat 5']);
  });
  it('sums the rest exactly to the sen', () => {
    const slices = expenseBreakdown(plWith([9, 8, 7, 6, 5, 0.1, 0.2]));
    expect(slices.at(-1)).toEqual({ key: 'other', label: 'Other', value: 0.3 });
  });
  it('leaves out zero and negative amounts', () => {
    expect(expenseBreakdown(plWith([0, -5, 12]))).toEqual([{ key: 'e2', label: 'Cat 2', value: 12 }]);
    expect(expenseBreakdown(plWith([]))).toEqual([]);
  });
});

describe('the CSV files', () => {
  const year: Period = { from: '2026-01', to: '2026-12' };
  const rows = (csv: string) => csv.replace(/^﻿/, '').split('\r\n').filter(Boolean);

  it('puts profit and loss in a header, one row per line and the totals', () => {
    const csv = profitAndLossCsv(profitAndLoss(ACCOUNTS, TOTALS, year), year);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(rows(csv)).toEqual([
      'Period,Section,Code,Account,Amount',
      'January to December 2026,Income,4000,Sales,1000',
      'January to December 2026,Income,,Total income,1000',
      'January to December 2026,Expenses,5000,Purchases,400',
      'January to December 2026,Expenses,6300,Utilities,150.5',
      'January to December 2026,Expenses,,Total expenses,550.5',
      'January to December 2026,,,Net profit,449.5',
    ]);
  });
  it('puts the balance sheet in a header, its lines, current earnings and the totals', () => {
    const csv = balanceSheetCsv(balanceSheet(ACCOUNTS, TOTALS, only('2026-03')));
    expect(rows(csv)).toEqual([
      'As at,Section,Code,Account,Amount',
      '31 March 2026,Assets,1100,Main Bank,10509.5',
      '31 March 2026,Assets,1200,Trade Receivables,530',
      '31 March 2026,Assets,,Total assets,11039.5',
      '31 March 2026,Liabilities,2000,Trade Payables,0',
      '31 March 2026,Liabilities,2100,SST Payable,90',
      '31 March 2026,Liabilities,,Total liabilities,90',
      '31 March 2026,Equity,3000,Owner’s Capital,10000',
      '31 March 2026,Equity,,Current earnings,949.5',
      '31 March 2026,Equity,,Total equity,10949.5',
      '31 March 2026,,,Total liabilities and equity,11039.5',
    ]);
  });
  it('puts the trial balance in a header, its rows and the totals', () => {
    const csv = trialBalanceCsv(trialBalance(ACCOUNTS, TOTALS, only('2026-04')), only('2026-04'));
    expect(rows(csv)).toEqual([
      'Period,Code,Account,Type,Debit,Credit',
      'April 2026,1200,Trade Receivables,Asset,0,530',
      'April 2026,2100,SST Payable,Liability,30,0',
      'April 2026,4000,Sales,Income,500,0',
      'April 2026,,Total,,530,530',
    ]);
  });
  it('escapes names that start with = + - or @, as the other exports do', () => {
    const nasty = ['=SUM(A1)', '+1', '-2', '@x'].map((name, i) => ({ ...account(`40${i}0`, name, 'income') }));
    const { totals } = monthlyTotals(
      nasty.flatMap((a, i) => entry(`n${i}`, '2026-03-01', [[BANK, 10, 0], [a, 0, 10]])),
    );
    const csv = profitAndLossCsv(profitAndLoss([BANK, ...nasty], totals, only('2026-03')), only('2026-03'));
    expect(csv).toContain(",'=SUM(A1),10");
    expect(csv).toContain(",'+1,10");
    expect(csv).toContain(",'-2,10");
    expect(csv).toContain(",'@x,10");
    expect(csv).not.toMatch(/,=SUM/);
  });
  it('writes a negative amount as a number, not as a formula', () => {
    const pl = profitAndLoss(ACCOUNTS, TOTALS, only('2026-04'));
    expect(profitAndLossCsv(pl, only('2026-04'))).toContain(',Sales,-500\r\n');
  });
});
