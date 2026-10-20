import { describe, expect, it } from 'vitest';
import type { AccountType, LedgerAccount, LedgerLine, LedgerSource } from '@/lib/finance/ledger';
import {
  AGE_BUCKETS,
  aged,
  agedCsv,
  balanceSheet,
  balanceSheetCsv,
  bucketFor,
  cashFlow,
  cashFlowCsv,
  cashMovements,
  chartState,
  countUnassigned,
  creditSummary,
  dateLabel,
  daysOverdue,
  expenseBreakdown,
  isValidPeriod,
  lastDayOfMonth,
  monthEndLabel,
  monthlySeries,
  monthlyTotals,
  monthsIn,
  openPayables,
  openReceivables,
  periodFor,
  periodLabel,
  profitAndLoss,
  profitAndLossCsv,
  rangeMessage,
  sliceTotal,
  trialBalance,
  trialBalanceCsv,
  type MonthlyTotals,
  type OpenDocument,
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

/* ---- aged receivables and payables ------------------------------------ */

const csvRows = (csv: string) => csv.replace(/^﻿/, '').split('\r\n').filter(Boolean);

describe('daysOverdue', () => {
  it('counts whole calendar days from the due date to today', () => {
    expect(daysOverdue('2026-10-10', '2026-10-10')).toBe(0);
    expect(daysOverdue('2026-10-09', '2026-10-10')).toBe(1);
    expect(daysOverdue('2026-09-10', '2026-10-10')).toBe(30);
    expect(daysOverdue('2026-09-09', '2026-10-10')).toBe(31);
  });
  it('is zero or below for a due date in the future', () => {
    expect(daysOverdue('2026-10-11', '2026-10-10')).toBe(-1);
    expect(daysOverdue('2026-12-31', '2026-10-10')).toBe(-82);
  });
  it('crosses a month end, a year end and 29 February', () => {
    expect(daysOverdue('2026-01-31', '2026-02-01')).toBe(1);
    expect(daysOverdue('2025-12-31', '2026-01-01')).toBe(1);
    expect(daysOverdue('2025-12-01', '2026-01-01')).toBe(31);
    expect(daysOverdue('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysOverdue('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysOverdue('2028-02-29', '2028-03-01')).toBe(1);
    expect(daysOverdue('2027-03-01', '2028-03-01')).toBe(366);
  });
  it('treats a date that is not a real date as not yet due, and does not throw', () => {
    for (const bad of ['', 'soon', '2026-02-30', '2026-13-01', '2026-1-5', '2026-10-10T00:00:00Z']) {
      expect(daysOverdue(bad, '2026-10-10'), bad).toBe(0);
    }
    expect(daysOverdue('2026-09-01', 'nonsense')).toBe(0);
  });
});

describe('bucketFor', () => {
  it('puts each boundary day in its bucket', () => {
    const at = (days: number) => bucketFor(days);
    expect([at(-30), at(-1), at(0)]).toEqual(['current', 'current', 'current']);
    expect([at(1), at(30)]).toEqual(['d1_30', 'd1_30']);
    expect([at(31), at(60)]).toEqual(['d31_60', 'd31_60']);
    expect([at(61), at(90)]).toEqual(['d61_90', 'd61_90']);
    expect([at(91), at(1000)]).toEqual(['d90_plus', 'd90_plus']);
  });
  it('has the five buckets in order, with their labels', () => {
    expect(AGE_BUCKETS).toEqual([
      { key: 'current', label: 'Not yet due' },
      { key: 'd1_30', label: '1–30 days' },
      { key: 'd31_60', label: '31–60 days' },
      { key: 'd61_90', label: '61–90 days' },
      { key: 'd90_plus', label: 'Over 90 days' },
    ]);
  });
});

describe('aged', () => {
  const TODAY = '2026-10-10';
  const doc = (party_id: string, party_name: string, due_date: string, balance: number): OpenDocument => ({ party_id, party_name, due_date, balance });
  const DOCS: OpenDocument[] = [
    doc('c1', 'Aisyah Trading', '2026-11-01', 100), // not yet due
    doc('c1', 'Aisyah Trading', '2026-10-10', 50.5), // due today: current
    doc('c1', 'Aisyah Trading', '2026-10-09', 20), // 1 day
    doc('c2', 'Bunga Raya Cafe', '2026-09-10', 300), // 30 days
    doc('c2', 'Bunga Raya Cafe', '2026-09-09', 40), // 31 days
    doc('c2', 'Bunga Raya Cafe', '2026-08-11', 10), // 60 days
    doc('c3', 'Cahaya Sdn Bhd', '2026-08-10', 5.25), // 61 days
    doc('c3', 'Cahaya Sdn Bhd', '2026-07-12', 0.1), // 90 days
    doc('c3', 'Cahaya Sdn Bhd', '2026-07-11', 0.2), // 91 days
    doc('c4', 'Dalia Enterprise', '2026-10-01', 0), // nothing owed: left out
    doc('c5', 'Eman Stores', '2026-10-01', -75), // in credit: left out
  ];

  it('makes one row per party with a balance, with the buckets in whole sen', () => {
    const a = aged(DOCS, TODAY);
    expect(a.rows.map((r) => r.party_id)).toEqual(['c2', 'c1', 'c3']);
    expect(a.rows[0]).toEqual({
      party_id: 'c2', party_name: 'Bunga Raya Cafe', total: 350,
      buckets: { current: 0, d1_30: 300, d31_60: 50, d61_90: 0, d90_plus: 0 },
    });
    expect(a.rows[1].buckets).toEqual({ current: 150.5, d1_30: 20, d31_60: 0, d61_90: 0, d90_plus: 0 });
    expect(a.rows[1].total).toBe(170.5);
    // 5.25 (61 days) + 0.10 (90 days) in 61–90, 0.20 (91 days) over 90; no float drift
    expect(a.rows[2].buckets).toEqual({ current: 0, d1_30: 0, d31_60: 0, d61_90: 5.35, d90_plus: 0.2 });
    expect(a.rows[2].total).toBe(5.55);
  });
  it('counts a document 90 days over in 61–90 and one 91 days over in Over 90 days', () => {
    const a = aged(DOCS, TODAY);
    const cahaya = a.rows.find((r) => r.party_id === 'c3')!;
    expect(cahaya.buckets.d61_90).toBe(5.35);
    expect(cahaya.buckets.d90_plus).toBe(0.2);
  });
  it('adds the columns up, and says how much is overdue (everything but Not yet due)', () => {
    const a = aged(DOCS, TODAY);
    expect(a.totals).toEqual({ current: 150.5, d1_30: 320, d31_60: 50, d61_90: 5.35, d90_plus: 0.2 });
    expect(a.total).toBe(526.05);
    expect(a.overdue).toBe(375.55);
  });
  it('sorts the largest total first, and equal totals by name', () => {
    const a = aged([doc('z', 'Zed', '2026-10-01', 10), doc('a', 'Alif', '2026-10-01', 10), doc('m', 'Mim', '2026-10-01', 20)], TODAY);
    expect(a.rows.map((r) => r.party_name)).toEqual(['Mim', 'Alif', 'Zed']);
  });
  it('is empty for no documents, or for none with a balance', () => {
    const empty = { rows: [], totals: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 }, total: 0, overdue: 0 };
    expect(aged([], TODAY)).toEqual(empty);
    expect(aged([doc('c', 'C', '2026-10-01', 0), doc('d', 'D', '2026-10-01', -5)], TODAY)).toEqual(empty);
  });
  it('puts a document with an invalid due date in Not yet due', () => {
    const a = aged([doc('c', 'C', 'not a date', 10)], TODAY);
    expect(a.rows[0].buckets.current).toBe(10);
    expect(a.overdue).toBe(0);
  });
  it('groups by party id, not by name, so two customers with one name stay apart', () => {
    const a = aged([doc('1', 'Ali', '2026-10-01', 10), doc('2', 'Ali', '2026-10-01', 5)], TODAY);
    expect(a.rows).toHaveLength(2);
  });
});

describe('creditSummary', () => {
  const d = (party_id: string, balance: number) => ({ party_id, balance });
  it('counts the parties with a negative balance and adds up what they are owed', () => {
    expect(creditSummary([d('a', -75), d('a', -25.5), d('b', -0.1), d('c', 50), d('d', 0)])).toEqual({ count: 2, total: 100.6 });
  });
  it('is nothing when nobody is in credit', () => {
    expect(creditSummary([d('a', 10), d('b', 0)])).toEqual({ count: 0, total: 0 });
    expect(creditSummary([])).toEqual({ count: 0, total: 0 });
  });
});

describe('dateLabel', () => {
  it('writes a date in words', () => {
    expect(dateLabel('2026-10-10')).toBe('10 October 2026');
    expect(dateLabel('2028-02-29')).toBe('29 February 2028');
    expect(dateLabel('2026-01-05')).toBe('5 January 2026');
  });
});

describe('agedCsv', () => {
  it('writes a header, a row per party and a totals row, as numbers', () => {
    const a = aged([
      { party_id: 'c1', party_name: 'Aisyah, Trading', due_date: '2026-10-20', balance: 100 },
      { party_id: 'c2', party_name: '=Evil', due_date: '2026-09-01', balance: 40.5 },
    ], '2026-10-10');
    expect(csvRows(agedCsv(a, '2026-10-10', 'Customer'))).toEqual([
      'As at,Customer,Not yet due,1–30 days,31–60 days,61–90 days,Over 90 days,Total',
      '10 October 2026,"Aisyah, Trading",100,0,0,0,0,100',
      "10 October 2026,'=Evil,0,0,40.5,0,0,40.5",
      '10 October 2026,Total,100,0,40.5,0,0,140.5',
    ]);
  });
  it('names the supplier column for payables', () => {
    expect(csvRows(agedCsv(aged([], '2026-10-10'), '2026-10-10', 'Supplier'))[0]).toBe(
      'As at,Supplier,Not yet due,1–30 days,31–60 days,61–90 days,Over 90 days,Total',
    );
  });
});

/* ---- cash flow --------------------------------------------------------- */

describe('cash flow', () => {
  const bank = (code: string, name: string): LedgerAccount => ({ ...account(code, name, 'asset'), stands_for: 'bank' });
  const MAIN = bank('1100', 'Main Bank');
  const CASH = bank('1000', 'Cash in Hand');
  const CARD = bank('1150', 'Card Account');
  const ACCRUED = account('2050', 'Accrued Expenses', 'liability');
  const BOOK = [CASH, MAIN, CARD, AR, AP, ACCRUED, CAPITAL, SALES, PURCHASES, UTILITIES];
  const src = (key: string, date: string, source: LedgerSource, sides: Side[]): LedgerLine[] =>
    entry(key, date, sides).map((l) => ({ ...l, source }));

  /**
   * Hand-made books. Bank and cash accounts are 1100 and 1000.
   *   Jan  opening balances: bank 10,000.00, cash 500.00 and a card account overdrawn by 200.00 (a negative opening balance); an invoice of 1,060.00 (no cash)
   *   Feb  receipt of 1,060.00; a transfer of 300.00 from the bank to the cash tin; a bill of 400.00 (no cash)
   *   Mar  the bill is paid (400.00); an expense of 150.50 is approved (against Accrued Expenses, no cash) and then paid from the bank (a payment out);
   *        a second receipt of 530.00; a transfer of 100.00 from the bank to the cash tin
   *   Apr  that transfer is voided (its reversal is dated April); the second receipt is voided (its reversal, 530.00 out, is dated April);
   *        a refund of 100.00; a manual journal puts 75.00 in the bank; another moves 40.00 from the bank to the cash tin
   * Cash in each month: Jan +10,300.00 (10,500.00 in, 200.00 out); Feb +1,060.00 (the transfer nets to nothing); Mar +(-400 - 150.50 + 530) = -20.50;
   * Apr +(-530 - 100 + 75 + 40 - 40) = -555.00. The cumulative balance of the three accounts: 10,300.00; 11,360.00; 11,339.50; 10,784.50.
   */
  const CASH_LINES: LedgerLine[] = [
    ...src('opening:bank', '2026-01-02', 'opening', [[MAIN, 10000, 0], [CAPITAL, 0, 10000]]),
    ...src('opening:cash', '2026-01-02', 'opening', [[CASH, 500, 0], [CAPITAL, 0, 500]]),
    ...src('opening:card', '2026-01-02', 'opening', [[CAPITAL, 200, 0], [CARD, 0, 200]]),
    ...src('invoice:1', '2026-01-15', 'invoice', [[AR, 1060, 0], [SALES, 0, 1060]]),
    ...src('payment_in:1', '2026-02-10', 'payment_in', [[MAIN, 1060, 0], [AR, 0, 1060]]),
    ...src('transfer:1', '2026-02-15', 'transfer', [[CASH, 300, 0], [MAIN, 0, 300]]),
    ...src('bill:1', '2026-02-20', 'bill', [[PURCHASES, 400, 0], [AP, 0, 400]]),
    ...src('payment_out:1', '2026-03-05', 'payment_out', [[AP, 400, 0], [MAIN, 0, 400]]),
    ...src('expense:1', '2026-03-12', 'expense', [[UTILITIES, 150.5, 0], [ACCRUED, 0, 150.5]]),
    ...src('payment_out:2', '2026-03-12', 'payment_out', [[ACCRUED, 150.5, 0], [MAIN, 0, 150.5]]),
    ...src('transfer:2', '2026-03-14', 'transfer', [[CASH, 100, 0], [MAIN, 0, 100]]),
    ...src('invoice:2', '2026-03-15', 'invoice', [[AR, 530, 0], [SALES, 0, 530]]),
    ...src('payment_in:2', '2026-03-20', 'payment_in', [[MAIN, 530, 0], [AR, 0, 530]]),
    ...src('payment_in:2:void', '2026-04-03', 'payment_in', [[AR, 530, 0], [MAIN, 0, 530]]),
    ...src('transfer:2:void', '2026-04-05', 'transfer', [[MAIN, 100, 0], [CASH, 0, 100]]),
    ...src('refund:1', '2026-04-08', 'refund', [[AR, 100, 0], [MAIN, 0, 100]]),
    ...src('journal:1', '2026-04-20', 'journal', [[MAIN, 75, 0], [SALES, 0, 75]]),
    ...src('journal:2', '2026-04-25', 'journal', [[CASH, 40, 0], [MAIN, 0, 40]]),
  ];

  describe('cashMovements', () => {
    it('adds the bank and cash lines up by month and source, leaving transfers out', () => {
      expect(cashMovements(CASH_LINES, BOOK)).toEqual([
        { month: '2026-01', source: 'opening', in: 10500, out: 200 },
        { month: '2026-02', source: 'payment_in', in: 1060, out: 0 },
        { month: '2026-03', source: 'payment_in', in: 530, out: 0 },
        { month: '2026-03', source: 'payment_out', in: 0, out: 550.5 },
        { month: '2026-04', source: 'journal', in: 115, out: 40 },
        { month: '2026-04', source: 'payment_in', in: 0, out: 530 },
        { month: '2026-04', source: 'refund', in: 0, out: 100 },
      ]);
    });
    it('keeps a voided receipt’s reversal in its own source and month, as money out, not netted against the original', () => {
      const rows = cashMovements(CASH_LINES, BOOK).filter((r) => r.source === 'payment_in');
      expect(rows.find((r) => r.month === '2026-03')).toMatchObject({ in: 530, out: 0 });
      expect(rows.find((r) => r.month === '2026-04')).toMatchObject({ in: 0, out: 530 });
    });
    it('leaves out a transfer and its void, which net to nothing, but keeps a journal between two bank accounts (in and out)', () => {
      const rows = cashMovements(CASH_LINES, BOOK);
      expect(rows.some((r) => r.source === 'transfer')).toBe(false);
      expect(rows.find((r) => r.month === '2026-04' && r.source === 'journal')).toMatchObject({ in: 115, out: 40 });
    });
    it('does not count an approved expense, which accrues and never touches a bank account', () => {
      expect(cashMovements(CASH_LINES, BOOK).some((r) => r.source === 'expense')).toBe(false);
    });
    it('ignores accounts that are not bank or cash, and lines with no account', () => {
      expect(cashMovements(src('x', '2026-01-01', 'journal', [[AR, 5, 0], [null, 0, 5]]), BOOK)).toEqual([]);
      expect(cashMovements([], BOOK)).toEqual([]);
    });
    it('is exact to the sen', () => {
      const lines = [
        ...src('a', '2026-03-01', 'payment_in', [[MAIN, 0.1, 0], [AR, 0, 0.1]]),
        ...src('b', '2026-03-02', 'payment_in', [[MAIN, 0.2, 0], [AR, 0, 0.2]]),
      ];
      expect(cashMovements(lines, BOOK)).toEqual([{ month: '2026-03', source: 'payment_in', in: 0.3, out: 0 }]);
    });
  });

  describe('cashFlow', () => {
    const MOVES = cashMovements(CASH_LINES, BOOK);
    const per = (from: string, to: string): Period => ({ from, to });

    it('brings the opening cash forward, groups the period and ends on the closing cash (March to April)', () => {
      expect(cashFlow(MOVES, per('2026-03', '2026-04'))).toEqual({
        opening: 11360,
        lines: [
          { key: 'payment_in', label: 'Received from customers and other income', in: 530, out: 530, net: 0 },
          { key: 'refund', label: 'Refunds to customers', in: 0, out: 100, net: -100 },
          { key: 'payment_out', label: 'Paid to suppliers and for expenses', in: 0, out: 550.5, net: -550.5 },
          { key: 'journal', label: 'Manual journals', in: 115, out: 40, net: 75 },
        ],
        totalIn: 645,
        totalOut: 1220.5,
        net: -575.5,
        closing: 10784.5,
      });
    });
    it('shows opening balances brought in as a line of the month they were dated', () => {
      const cf = cashFlow(MOVES, per('2026-01', '2026-01'));
      expect(cf.opening).toBe(0);
      expect(cf.lines).toEqual([{ key: 'opening', label: 'Opening balances brought in', in: 10500, out: 200, net: 10300 }]);
      expect(cf.closing).toBe(10300);
    });
    it('has no lines for a quiet period, but still the opening and closing cash', () => {
      const cf = cashFlow(MOVES, per('2026-06', '2026-07'));
      expect(cf).toEqual({ opening: 10784.5, lines: [], totalIn: 0, totalOut: 0, net: 0, closing: 10784.5 });
    });
    it('counts nothing from after the period', () => {
      expect(cashFlow(MOVES, per('2026-02', '2026-02')).closing).toBe(11360);
    });
    it('puts a source that should not touch a bank in Other, last', () => {
      // an invoice or an expense on a bank account does not occur in the live ledger; if one did, it would be seen
      const odd = [...MOVES, { month: '2026-04', source: 'invoice' as const, in: 10, out: 0 }, { month: '2026-04', source: 'expense' as const, in: 0, out: 3 }];
      const cf = cashFlow(odd, per('2026-04', '2026-04'));
      expect(cf.lines[cf.lines.length - 1]).toEqual({ key: 'other', label: 'Other', in: 10, out: 3, net: 7 });
    });
    it('is empty for an invalid period rather than throwing', () => {
      expect(() => cashFlow(MOVES, per('2026-05', '2026-04'))).not.toThrow();
    });

    it('closes on the sum of the bank and cash balances the balance sheet shows, for every month', () => {
      const { totals } = monthlyTotals(CASH_LINES);
      const bankIds = new Set([MAIN.id, CASH.id, CARD.id]);
      const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2025-12'];
      const sheetOf = (month: string) => {
        const bs = balanceSheet(BOOK, totals, only(month));
        return bs.assets.filter((l) => bankIds.has(l.account_id)).reduce((t, l) => t + Math.round(l.amount * 100), 0);
      };
      // three periods that are not a single month, each ending where the sheet is read
      for (const [from, to] of [['2026-01', '2026-04'], ['2026-02', '2026-03'], ['2026-03', '2026-05']]) {
        expect(Math.round(cashFlow(MOVES, per(from, to)).closing * 100), `${from}..${to}`).toBe(sheetOf(to));
      }
      for (const month of months) {
        const bs = balanceSheet(BOOK, totals, only(month));
        const sheet = Math.round(bs.assets.filter((l) => bankIds.has(l.account_id)).reduce((t, l) => t + Math.round(l.amount * 100), 0));
        // any starting month: the identity holds whatever period.from is
        for (const from of ['2025-01', month]) {
          expect(Math.round(cashFlow(MOVES, per(from, month)).closing * 100), `${from}..${month}`).toBe(sheet);
        }
      }
      expect(cashFlow(MOVES, per('2026-04', '2026-04')).closing).toBe(10784.5);
    });

    // Stage 6a (20261123100000), worked example R3: a USD account opened at RM 44,620.00, USD 1,000.00 of it sold for
    // RM 4,380.00 into the ringgit bank (a transfer, no cash flow), revalued at the month end: Dr USD account 80.00,
    // Cr Unrealised 80.00, reversed on 1 November.
    it('shows the revaluation of foreign cash on its own line, and still closes on the balance sheet at the month end (R3)', () => {
      const USD = bank('1110', 'USD Account');
      const UNREALISED = account('4910', 'Unrealised Exchange Gain or Loss', 'income');
      const book = [...BOOK, USD, UNREALISED];
      const lines: LedgerLine[] = [
        ...src('opening:usd', '2026-10-01', 'opening', [[USD, 44620, 0], [CAPITAL, 0, 44620]]),
        ...src('transfer:c52', '2026-10-15', 'transfer', [[MAIN, 4380, 0], [USD, 0, 4380]]),
        ...src('fx_revaluation:r', '2026-10-31', 'fx_revaluation', [[USD, 80, 0], [UNREALISED, 0, 80]]),
        ...src('fx_revaluation:r:reverse', '2026-11-01', 'fx_revaluation', [[UNREALISED, 80, 0], [USD, 0, 80]]),
      ];
      const moves = cashMovements(lines, book);
      const october = cashFlow(moves, per('2026-10', '2026-10'));
      expect(october.lines).toEqual([
        { key: 'opening', label: 'Opening balances brought in', in: 44620, out: 0, net: 44620 },
        { key: 'fx_revaluation', label: 'Exchange rate changes on foreign cash (no money moved)', in: 80, out: 0, net: 80 },
      ]);
      // USD account 40,320.00 (its revalued figure) + Main Bank 4,380.00.
      expect(october.closing).toBe(44700);
      const { totals } = monthlyTotals(lines);
      const bankIds = new Set([USD.id, MAIN.id]);
      for (const month of ['2026-10', '2026-11']) {
        const sheet = balanceSheet(book, totals, only(month))
          .assets.filter((l) => bankIds.has(l.account_id))
          .reduce((t, l) => t + Math.round(l.amount * 100), 0);
        expect(Math.round(cashFlow(moves, per('2026-10', month)).closing * 100), month).toBe(sheet);
      }
      // November: the reversal, as money out on the same line; the cash is back at its booked 44,620.00.
      const november = cashFlow(moves, per('2026-11', '2026-11'));
      expect(november.lines).toEqual([
        { key: 'fx_revaluation', label: 'Exchange rate changes on foreign cash (no money moved)', in: 0, out: 80, net: -80 },
      ]);
      expect(november.closing).toBe(44620);
    });
  });

  describe('cashFlowCsv', () => {
    it('writes the opening cash, a row per group, the total and the closing cash', () => {
      const cf = cashFlow(cashMovements(CASH_LINES, BOOK), { from: '2026-03', to: '2026-04' });
      expect(csvRows(cashFlowCsv(cf, { from: '2026-03', to: '2026-04' }))).toEqual([
        'Period,Line,In,Out,Net',
        'March to April 2026,Opening cash,,,11360',
        'March to April 2026,Received from customers and other income,530,530,0',
        'March to April 2026,Refunds to customers,0,100,-100',
        'March to April 2026,Paid to suppliers and for expenses,0,550.5,-550.5',
        'March to April 2026,Manual journals,115,40,75',
        'March to April 2026,Total,645,1220.5,-575.5',
        'March to April 2026,Closing cash,,,10784.5',
      ]);
    });
  });
});

/* ---- which documents are open ------------------------------------------ */

describe('openReceivables', () => {
  const invoice = (display_status: string, balance: number) => ({
    customer_id: 'c1', customer_name: 'Aisyah Trading', due_date: '2026-10-01', balance, display_status,
  });
  const statuses = ['draft', 'sent', 'overdue', 'paid', 'void'];
  const kept = (status: string, balance: number) => openReceivables([invoice(status, balance)]).length;

  it('keeps a posted invoice (sent, overdue or paid) with any nonzero balance, and nothing else', () => {
    expect(statuses.map((s) => [s, kept(s, 100), kept(s, 0), kept(s, -50)])).toEqual([
      ['draft', 0, 0, 0],
      ['sent', 1, 0, 1],
      ['overdue', 1, 0, 1],
      ['paid', 1, 0, 1],
      ['void', 0, 0, 0],
    ]);
  });
  it('turns a row into an open document, with the customer as the party', () => {
    expect(openReceivables([invoice('sent', 12.5)])).toEqual([
      { party_id: 'c1', party_name: 'Aisyah Trading', due_date: '2026-10-01', balance: 12.5 },
    ]);
  });
  it('leaves out a status it does not know', () => {
    expect(kept('mystery', 10)).toBe(0);
  });
});

describe('openPayables', () => {
  const bill = (display_status: string, balance: number) => ({
    supplier_id: 's1', supplier_name: 'Kopi Hulu Supplies', due_date: '2026-09-04', balance, display_status,
  });
  const statuses = ['draft', 'pending', 'overdue', 'paid', 'void'];
  const kept = (status: string, balance: number) => openPayables([bill(status, balance)]).length;

  it('keeps a pending or overdue bill with a balance above zero, and nothing else', () => {
    expect(statuses.map((s) => [s, kept(s, 100), kept(s, 0), kept(s, -50)])).toEqual([
      ['draft', 0, 0, 0],
      ['pending', 1, 0, 0],
      ['overdue', 1, 0, 0],
      ['paid', 0, 0, 0],
      ['void', 0, 0, 0],
    ]);
  });
  it('turns a row into an open document, with the supplier as the party', () => {
    expect(openPayables([bill('overdue', 700)])).toEqual([
      { party_id: 's1', party_name: 'Kopi Hulu Supplies', due_date: '2026-09-04', balance: 700 },
    ]);
  });
});
