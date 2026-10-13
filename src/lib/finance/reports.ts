/**
 * What the Reports screen shows, worked out from the ledger: the profit and loss, the balance sheet and the
 * trial balance for a period, the month-by-month series, the expense breakdown and the CSV files. Pure, with no
 * server imports, so the client view and the tests both use it.
 *
 * Every sum is made in whole sen (integers) and turned back into ringgit at the edge, so 0.10 + 0.20 is 0.30
 * and a thousand lines of 0.01 are 10.00 on every machine. The books are read as monthly totals per account
 * (monthlyTotals), which the server works out once; the view never holds the ledger's lines.
 *
 * Signs: an asset or expense account is debit-normal (debits less credits); a liability, equity or income
 * account is credit-normal (credits less debits). Every entry balances, so the trial balance does too.
 */
import { toCsv } from './csv';
import type { AccountType, LedgerAccount, LedgerLine, LedgerSource } from './ledger';
import { ACCOUNT_TYPE_LABELS } from './ledger-views';

/** 'YYYY-MM' */
export type Month = string;

export type MonthlyTotals = { account_id: string; month: Month; debit: number; credit: number }[];

/** The part of an account the statements need: the screen sends no more. */
export type ReportAccount = Pick<LedgerAccount, 'id' | 'code' | 'name' | 'type'>;

/** From the first month to the last, both inclusive; from is not after to. */
export type Period = { from: Month; to: Month };

export type PeriodKey = 'this_month' | 'last_month' | 'this_quarter' | 'this_year' | 'last_year' | 'all_time' | 'custom';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** The most months the month-by-month chart draws: the last of them when the period is longer. */
export const SERIES_MONTHS_MAX = 24;
/** The most slices the expense chart draws, "Other" included. */
export const BREAKDOWN_SLICES_MAX = 6;

const toSen = (amount: number) => Math.round(amount * 100);
const fromSen = (sen: number) => sen / 100;

/* ---- months ----------------------------------------------------------- */

/** Years 1900 to 2999: a typed year outside them is not a month, and the arithmetic below never leaves them. */
const MONTH_PATTERN = /^(19\d\d|2\d\d\d)-(0[1-9]|1[0-2])$/;

function parts(month: Month): { year: number; index: number } {
  const [year, number] = month.split('-').map(Number);
  return { year, index: number - 1 };
}

/** The month `by` months after (or, negative, before) the given one, in whole numbers: no Date, so no year limit or two-digit-year rule. */
function shiftMonth(month: Month, by: number): Month {
  const { year, index } = parts(month);
  const n = year * 12 + index + by;
  return `${String(Math.floor(n / 12)).padStart(4, '0')}-${String((n % 12) + 1).padStart(2, '0')}`;
}

/** A month is real when it reads YYYY-MM, the year 1900 to 2999 and the month 01 to 12. */
function isMonth(value: string): boolean {
  return MONTH_PATTERN.test(value);
}

export function isValidPeriod(period: Period): boolean {
  return isMonth(period.from) && isMonth(period.to) && period.from <= period.to;
}

export const RANGE_MESSAGES = {
  both: 'Enter both months.',
  order: 'Choose a From month that is not after the To month.',
} as const;

/** What is wrong with a typed range, in a sentence, or null when it is fine. */
export function rangeMessage(period: Period): string | null {
  if (!isMonth(period.from) || !isMonth(period.to)) return RANGE_MESSAGES.both;
  return period.from <= period.to ? null : RANGE_MESSAGES.order;
}

/** Every month of the period, oldest first; none for an invalid period. */
export function monthsIn(period: Period): Month[] {
  if (!isValidPeriod(period)) return [];
  const months: Month[] = [];
  for (let month = period.from; month <= period.to; month = shiftMonth(month, 1)) months.push(month);
  return months;
}

/** 2026-02 gives 2026-02-28 (and 2028-02 gives 2028-02-29). */
export function lastDayOfMonth(month: Month): string {
  const { year, index } = parts(month);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const day = index === 1 ? (leap ? 29 : 28) : [3, 5, 8, 10].includes(index) ? 30 : 31;
  return `${month}-${String(day).padStart(2, '0')}`;
}

/** 2026-10-10 gives "10 October 2026": a date in words, for the "As at" of a statement worked out for one day. */
export function dateLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

/** 2026-10 gives "31 October 2026": the date a balance sheet for that month is as at. */
export function monthEndLabel(month: Month): string {
  const { year, index } = parts(month);
  return `${lastDayOfMonth(month).slice(8)} ${MONTH_NAMES[index]} ${year}`;
}

/** "October 2026", "January to October 2026" or "July 2025 to June 2026". */
export function periodLabel(period: Period): string {
  const from = parts(period.from);
  const to = parts(period.to);
  if (period.from === period.to) return `${MONTH_NAMES[to.index]} ${to.year}`;
  if (from.year === to.year) return `${MONTH_NAMES[from.index]} to ${MONTH_NAMES[to.index]} ${to.year}`;
  return `${MONTH_NAMES[from.index]} ${from.year} to ${MONTH_NAMES[to.index]} ${to.year}`;
}

/* ---- the books by month ----------------------------------------------- */

/**
 * One row per account and month that has any line, ordered by account then month. A line with no account
 * (one whose account could not be found) is left out and counted, so the screen can say so.
 */
export function monthlyTotals(lines: LedgerLine[]): { totals: MonthlyTotals; unassigned: number } {
  const sums = new Map<string, { account_id: string; month: Month; debit: number; credit: number }>();
  let unassigned = 0;
  for (const line of lines) {
    if (!line.account_id) {
      unassigned += 1;
      continue;
    }
    const month = line.entry_date.slice(0, 7);
    const key = `${line.account_id}|${month}`;
    const row = sums.get(key) ?? { account_id: line.account_id, month, debit: 0, credit: 0 };
    row.debit += toSen(line.debit);
    row.credit += toSen(line.credit);
    sums.set(key, row);
  }
  const totals = [...sums.values()]
    .map((row) => ({ ...row, debit: fromSen(row.debit), credit: fromSen(row.credit) }))
    .sort((a, b) => (a.account_id === b.account_id ? a.month.localeCompare(b.month) : a.account_id < b.account_id ? -1 : 1));
  return { totals, unassigned };
}

/**
 * The period a choice stands for, from the person's date (YYYY-MM-DD). Quarters are calendar quarters and the
 * year is the calendar year, and the quarter and the year run only to this month: a statement for next month
 * would be empty. All time runs from the earliest month with any line (or this month when there is none) to the later of this month and the latest month with any line.
 */
export function periodFor(key: Exclude<PeriodKey, 'custom'>, today: string, totals: MonthlyTotals): Period {
  const now = today.slice(0, 7);
  const { year, index } = parts(now);
  switch (key) {
    case 'this_month':
      return { from: now, to: now };
    case 'last_month': {
      const last = shiftMonth(now, -1);
      return { from: last, to: last };
    }
    case 'this_quarter':
      return { from: `${year}-${String(index - (index % 3) + 1).padStart(2, '0')}`, to: now };
    case 'this_year':
      return { from: `${year}-01`, to: now };
    case 'last_year':
      return { from: `${year - 1}-01`, to: `${year - 1}-12` };
    case 'all_time': {
      const earliest = totals.reduce<Month | null>((min, t) => (min === null || t.month < min ? t.month : min), null);
      const latest = totals.reduce<Month | null>((max, t) => (max === null || t.month > max ? t.month : max), null);
      // An entry dated after this month is in the books, so all time runs on to it.
      return { from: earliest !== null && earliest < now ? earliest : now, to: latest !== null && latest > now ? latest : now };
    }
  }
}

/* ---- adding up -------------------------------------------------------- */

type Movement = { debit: number; credit: number; active: boolean };

/** Each account's debits and credits (in sen) over the months that pass `inRange`. */
function movements(totals: MonthlyTotals, inRange: (month: Month) => boolean): Map<string, Movement> {
  const byAccount = new Map<string, Movement>();
  for (const t of totals) {
    if (!inRange(t.month)) continue;
    const m = byAccount.get(t.account_id) ?? { debit: 0, credit: 0, active: false };
    m.debit += toSen(t.debit);
    m.credit += toSen(t.credit);
    if (t.debit !== 0 || t.credit !== 0) m.active = true;
    byAccount.set(t.account_id, m);
  }
  return byAccount;
}

const inPeriod = (period: Period) => (month: Month) => month >= period.from && month <= period.to;

const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code, 'en', { numeric: true });

/** Debit-normal accounts read debits less credits; the others credits less debits. */
const isDebitNormal = (type: AccountType) => type === 'asset' || type === 'expense';
const signedSen = (type: AccountType, m: Movement) => (isDebitNormal(type) ? m.debit - m.credit : m.credit - m.debit);

export type StatementLine = { account_id: string; code: string; name: string; amount: number };

type SenLine = StatementLine & { sen: number };

/** The accounts of the given kinds that have a movement, each with its signed amount, by code. */
function linesOf(accounts: ReportAccount[], moves: Map<string, Movement>, types: AccountType[], keep: (m: Movement, sen: number) => boolean): SenLine[] {
  return accounts
    .filter((a) => types.includes(a.type))
    .flatMap((a) => {
      const m = moves.get(a.id);
      if (!m) return [];
      const sen = signedSen(a.type, m);
      return keep(m, sen) ? [{ account_id: a.id, code: a.code, name: a.name, amount: fromSen(sen), sen }] : [];
    })
    .sort(byCode);
}

const strip = (l: SenLine): StatementLine => ({ account_id: l.account_id, code: l.code, name: l.name, amount: l.amount });
const total = (lines: SenLine[]) => lines.reduce((t, l) => t + l.sen, 0);

/* ---- profit and loss -------------------------------------------------- */

export type ProfitAndLoss = {
  income: StatementLine[];
  expenses: StatementLine[];
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
  /** Net profit as a share of income, or null when there is no income to be a share of. */
  margin: number | null;
};

/**
 * Movement within the period. Income is credits less debits, an expense debits less credits; an account with
 * no movement in the period is left out. A void's reversal in a later month shows as a negative line there.
 */
export function profitAndLoss(accounts: ReportAccount[], totals: MonthlyTotals, period: Period): ProfitAndLoss {
  const moves = movements(totals, inPeriod(period));
  const active = (m: Movement) => m.active;
  const income = linesOf(accounts, moves, ['income'], active);
  const expenses = linesOf(accounts, moves, ['expense'], active);
  const totalIncome = total(income);
  const totalExpenses = total(expenses);
  const net = totalIncome - totalExpenses;
  return {
    income: income.map(strip),
    expenses: expenses.map(strip),
    totalIncome: fromSen(totalIncome),
    totalExpenses: fromSen(totalExpenses),
    netProfit: fromSen(net),
    // A share of income that is nothing, or below nothing after a void, would be a meaningless number.
    margin: totalIncome > 0 ? net / totalIncome : null,
  };
}

/* ---- balance sheet ---------------------------------------------------- */

export type BalanceSheet = {
  asAt: Month;
  assets: StatementLine[];
  liabilities: StatementLine[];
  equity: StatementLine[];
  currentEarnings: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  balanced: boolean;
};

/**
 * Everything from the beginning of the books to the end of period.to (period.from is ignored). An asset is
 * debits less credits, a liability or equity credits less debits. An asset in credit, an overdrawn bank
 * for one, stays a negative asset: it is not moved to the liabilities, so each account is on the side of its
 * own type and the sheet shows what the books say. An account with a zero balance and no activity is left out.
 *
 * Nothing closes a year into Retained Earnings yet, so all the income less all the expenses up to the date
 * is shown as its own line, Current earnings, and counted in the equity.
 */
export function balanceSheet(accounts: ReportAccount[], totals: MonthlyTotals, period: Period): BalanceSheet {
  const moves = movements(totals, (month) => month <= period.to);
  const shown = (m: Movement, sen: number) => m.active || sen !== 0;
  const assets = linesOf(accounts, moves, ['asset'], shown);
  const liabilities = linesOf(accounts, moves, ['liability'], shown);
  const equity = linesOf(accounts, moves, ['equity'], shown);
  const earnings = total(linesOf(accounts, moves, ['income'], () => true)) - total(linesOf(accounts, moves, ['expense'], () => true));
  const totalAssets = total(assets);
  const totalLiabilities = total(liabilities);
  const totalEquity = total(equity) + earnings;
  return {
    asAt: period.to,
    assets: assets.map(strip),
    liabilities: liabilities.map(strip),
    equity: equity.map(strip),
    currentEarnings: fromSen(earnings),
    totalAssets: fromSen(totalAssets),
    totalLiabilities: fromSen(totalLiabilities),
    totalEquity: fromSen(totalEquity),
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
}

/* ---- trial balance ---------------------------------------------------- */

export type TrialBalanceRow = { account_id: string; code: string; name: string; type: AccountType; debit: number; credit: number };
export type TrialBalance = { rows: TrialBalanceRow[]; totalDebit: number; totalCredit: number; balanced: boolean };

/** Each account's debits and credits within the period (the movement, not the net), by code; an account with none is left out. */
export function trialBalance(accounts: ReportAccount[], totals: MonthlyTotals, period: Period): TrialBalance {
  const moves = movements(totals, inPeriod(period));
  const rows = accounts
    .flatMap((a) => {
      const m = moves.get(a.id);
      return m && m.active
        ? [{ account_id: a.id, code: a.code, name: a.name, type: a.type, debit: fromSen(m.debit), credit: fromSen(m.credit) }]
        : [];
    })
    .sort(byCode);
  const debit = rows.reduce((t, r) => t + toSen(r.debit), 0);
  const credit = rows.reduce((t, r) => t + toSen(r.credit), 0);
  return { rows, totalDebit: fromSen(debit), totalCredit: fromSen(credit), balanced: debit === credit };
}

/* ---- charts ----------------------------------------------------------- */

export type MonthSeries = { month: Month; label: string; revenue: number; expenses: number; net: number }[];

/**
 * One point per month of the period, empty months included, and the last 24 of them when the period is longer.
 * The label is the month's short name, with the two-digit year added when the points span more than one year.
 */
export function monthlySeries(accounts: ReportAccount[], totals: MonthlyTotals, period: Period): MonthSeries {
  const months = monthsIn(period).slice(-SERIES_MONTHS_MAX);
  if (months.length === 0) return [];
  const type = new Map(accounts.map((a) => [a.id, a.type]));
  const sums = new Map<Month, { revenue: number; expenses: number }>(months.map((m) => [m, { revenue: 0, expenses: 0 }]));
  for (const t of totals) {
    const sum = sums.get(t.month);
    const kind = type.get(t.account_id);
    if (!sum) continue;
    if (kind === 'income') sum.revenue += toSen(t.credit) - toSen(t.debit);
    else if (kind === 'expense') sum.expenses += toSen(t.debit) - toSen(t.credit);
  }
  const spansYears = months[0].slice(0, 4) !== months[months.length - 1].slice(0, 4);
  return months.map((month) => {
    const { revenue, expenses } = sums.get(month)!;
    const name = MONTH_NAMES[parts(month).index].slice(0, 3);
    return {
      month,
      label: spansYears ? `${name} ${month.slice(2, 4)}` : name,
      revenue: fromSen(revenue),
      expenses: fromSen(expenses),
      net: fromSen(revenue - expenses),
    };
  });
}

/**
 * The period's expense accounts, largest first. With more than six, the five largest stay and the rest are
 * summed into "Other", so a chart never has more than six slices. Zero and negative amounts are left out.
 */
export function expenseBreakdown(pl: ProfitAndLoss): { key: string; label: string; value: number }[] {
  const ranked = pl.expenses
    .filter((l) => toSen(l.amount) > 0)
    .map((l) => ({ key: l.account_id, label: l.name, value: l.amount }))
    // Array.prototype.sort is stable, so equal amounts keep the order of their codes.
    .sort((a, b) => b.value - a.value);
  if (ranked.length <= BREAKDOWN_SLICES_MAX) return ranked;
  const kept = ranked.slice(0, BREAKDOWN_SLICES_MAX - 1);
  const rest = ranked.slice(BREAKDOWN_SLICES_MAX - 1).reduce((t, s) => t + toSen(s.value), 0);
  return [...kept, { key: 'other', label: 'Other', value: fromSen(rest) }];
}

/* ---- CSV files -------------------------------------------------------- */

/** The profit and loss as a CSV file: a line per account, then each total. Amounts are numbers. */
export function profitAndLossCsv(pl: ProfitAndLoss, period: Period): string {
  const label = periodLabel(period);
  const line = (section: string, l: StatementLine) => [label, section, l.code, l.name, l.amount];
  return toCsv(
    ['Period', 'Section', 'Code', 'Account', 'Amount'],
    [
      ...pl.income.map((l) => line('Income', l)),
      [label, 'Income', null, 'Total income', pl.totalIncome],
      ...pl.expenses.map((l) => line('Expenses', l)),
      [label, 'Expenses', null, 'Total expenses', pl.totalExpenses],
      [label, null, null, 'Net profit', pl.netProfit],
    ],
  );
}

/** The balance sheet as a CSV file: each section's accounts and total, current earnings under equity, then the grand total. */
export function balanceSheetCsv(bs: BalanceSheet): string {
  const asAt = monthEndLabel(bs.asAt);
  const line = (section: string, l: StatementLine) => [asAt, section, l.code, l.name, l.amount];
  return toCsv(
    ['As at', 'Section', 'Code', 'Account', 'Amount'],
    [
      ...bs.assets.map((l) => line('Assets', l)),
      [asAt, 'Assets', null, 'Total assets', bs.totalAssets],
      ...bs.liabilities.map((l) => line('Liabilities', l)),
      [asAt, 'Liabilities', null, 'Total liabilities', bs.totalLiabilities],
      ...bs.equity.map((l) => line('Equity', l)),
      [asAt, 'Equity', null, 'Current earnings', bs.currentEarnings],
      [asAt, 'Equity', null, 'Total equity', bs.totalEquity],
      [asAt, null, null, 'Total liabilities and equity', fromSen(toSen(bs.totalLiabilities) + toSen(bs.totalEquity))],
    ],
  );
}

/** The trial balance as a CSV file: a row per account and a totals row. Amounts are numbers (0 on the side with none). */
export function trialBalanceCsv(tb: TrialBalance, period: Period): string {
  const label = periodLabel(period);
  return toCsv(
    ['Period', 'Code', 'Account', 'Type', 'Debit', 'Credit'],
    [
      ...tb.rows.map((r) => [label, r.code, r.name, ACCOUNT_TYPE_LABELS[r.type], r.debit, r.credit]),
      [label, null, 'Total', null, tb.totalDebit, tb.totalCredit],
    ],
  );
}

/* ---- what the screen decides ------------------------------------------ */

/**
 * Whether the month chart has nothing to draw, and what its subtitle says. It is decided from the statement,
 * not from the series, which is cut to the last 24 months: income or expenses further back are still in the
 * figures. A period longer than the cut says the chart shows only the last 24 months.
 */
export function chartState(pl: ProfitAndLoss, period: Period): { quiet: boolean; subtitle: string } {
  return {
    quiet: pl.income.length === 0 && pl.expenses.length === 0,
    subtitle: monthsIn(period).length > SERIES_MONTHS_MAX ? `Last ${SERIES_MONTHS_MAX} months` : 'By month',
  };
}

/** Ledger lines the statements cannot place: no account, or an account that is not in the list (the two reads raced). */
export function countUnassigned(lines: LedgerLine[], accounts: Pick<LedgerAccount, 'id'>[]): number {
  const known = new Set(accounts.map((a) => a.id));
  return lines.filter((l) => !l.account_id || !known.has(l.account_id)).length;
}

/** What the donut's centre shows: the slices added up, so it agrees with the ring even when a negative line was left out of it. */
export function sliceTotal(slices: { value: number }[]): number {
  return fromSen(slices.reduce((t, s) => t + toSen(s.value), 0));
}

/* ---- aged receivables and payables ------------------------------------ */

export type AgeBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus';

export const AGE_BUCKETS: { key: AgeBucket; label: string }[] = [
  { key: 'current', label: 'Not yet due' },
  { key: 'd1_30', label: '1–30 days' },
  { key: 'd31_60', label: '31–60 days' },
  { key: 'd61_90', label: '61–90 days' },
  { key: 'd90_plus', label: 'Over 90 days' },
];

/** What is still owed on one posted document, and by or to whom. */
export type OpenDocument = { party_id: string; party_name: string; due_date: string; balance: number };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** The day number of a YYYY-MM-DD date, counted as a calendar date in UTC (no time zone, no daylight saving); null when it is not a real date. */
function dayNumber(date: string): number | null {
  if (!DATE_PATTERN.test(date)) return null;
  const ms = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  // 2026-02-30 rolls over to March, and a year below 100 is read as 19xx: neither comes back as the same text.
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date ? null : ms / MS_PER_DAY;
}

/**
 * Whole days from the due date to today, both YYYY-MM-DD, compared as calendar dates. Zero or below is not yet
 * due. A date that is not a real date cannot be aged, so it counts as not yet due (0) rather than throwing or
 * being left out: what is owed stays in the total, and the document shows up under Not yet due.
 */
export function daysOverdue(dueDate: string, today: string): number {
  const due = dayNumber(dueDate);
  const now = dayNumber(today);
  return due === null || now === null ? 0 : now - due;
}

export function bucketFor(days: number): AgeBucket {
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90_plus';
}

export type AgedRow = { party_id: string; party_name: string; buckets: Record<AgeBucket, number>; total: number };
export type Aged = { rows: AgedRow[]; totals: Record<AgeBucket, number>; total: number; overdue: number };

const emptyBuckets = (): Record<AgeBucket, number> => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 });

/**
 * One row per party that is owed or owes something, the largest total first and the name as the tie-break.
 * A document with a balance of zero or below is left out (a negative one is a party in credit: creditSummary
 * counts those). `overdue` is everything except Not yet due. Sums are made in whole sen.
 */
export function aged(documents: OpenDocument[], today: string): Aged {
  const byParty = new Map<string, { party_name: string; buckets: Record<AgeBucket, number> }>();
  const totals = emptyBuckets();
  for (const d of documents) {
    const sen = toSen(d.balance);
    if (sen <= 0) continue;
    const bucket = bucketFor(daysOverdue(d.due_date, today));
    const row = byParty.get(d.party_id) ?? { party_name: d.party_name, buckets: emptyBuckets() };
    row.buckets[bucket] += sen;
    totals[bucket] += sen;
    byParty.set(d.party_id, row);
  }
  const sum = (b: Record<AgeBucket, number>) => AGE_BUCKETS.reduce((t, { key }) => t + b[key], 0);
  const scale = (b: Record<AgeBucket, number>) => Object.fromEntries(AGE_BUCKETS.map(({ key }) => [key, fromSen(b[key])])) as Record<AgeBucket, number>;
  const rows = [...byParty.entries()]
    .map(([party_id, r]) => ({ party_id, party_name: r.party_name, sen: sum(r.buckets), buckets: scale(r.buckets) }))
    .sort((a, b) => b.sen - a.sen || a.party_name.localeCompare(b.party_name, 'en'))
    .map(({ sen, ...row }) => ({ ...row, total: fromSen(sen) }));
  const total = sum(totals);
  return { rows, totals: scale(totals), total: fromSen(total), overdue: fromSen(total - totals.current) };
}

/**
 * How many parties have a document in credit (a balance below zero) and how much that is in all. A party is
 * counted once however many of its documents are in credit; a document of theirs that is still owed does not
 * cancel it, as the aged table shows what is owed document by document.
 */
export function creditSummary(documents: { party_id: string; balance: number }[]): { count: number; total: number } {
  const parties = new Set<string>();
  let sen = 0;
  for (const d of documents) {
    if (toSen(d.balance) >= 0) continue;
    parties.add(d.party_id);
    sen -= toSen(d.balance);
  }
  return { count: parties.size, total: fromSen(sen) };
}

/** The part of an invoice the receivables need (an InvoiceListRow, or the lighter row the screen reads, has it). */
export type InvoiceBalance = { customer_id: string; customer_name: string; due_date: string; balance: number; display_status: string };
/** The part of a supplier bill the payables need. */
export type BillBalance = { supplier_id: string; supplier_name: string; due_date: string; balance: number; display_status: string };

/**
 * What customers still owe, or are owed back: every posted invoice (sent, overdue, or paid, which holds a negative
 * balance for a customer in credit) with a balance that is not zero. A draft or void invoice is owed nothing. The
 * query that reads the rows filters the same way as an optimisation; this is the rule.
 */
export function openReceivables(invoices: InvoiceBalance[]): OpenDocument[] {
  return invoices
    .filter((i) => ['sent', 'overdue', 'paid'].includes(i.display_status) && toSen(i.balance) !== 0)
    .map((i) => ({ party_id: i.customer_id, party_name: i.customer_name, due_date: i.due_date, balance: i.balance }));
}

/** What is still owed on supplier bills: a pending or overdue bill with a balance above zero (draft, void and paid bills are not payable). */
export function openPayables(bills: BillBalance[]): OpenDocument[] {
  return bills
    .filter((b) => (b.display_status === 'pending' || b.display_status === 'overdue') && toSen(b.balance) > 0)
    .map((b) => ({ party_id: b.supplier_id, party_name: b.supplier_name, due_date: b.due_date, balance: b.balance }));
}

/** An aged table as a CSV file: a row per party, then the totals. Amounts are numbers. */
export function agedCsv(a: Aged, today: string, partyHeading: 'Customer' | 'Supplier'): string {
  const asAt = dateLabel(today);
  const amounts = (b: Record<AgeBucket, number>, total: number) => [...AGE_BUCKETS.map(({ key }) => b[key]), total];
  return toCsv(
    ['As at', partyHeading, ...AGE_BUCKETS.map(({ label }) => label), 'Total'],
    [
      ...a.rows.map((r) => [asAt, r.party_name, ...amounts(r.buckets, r.total)]),
      [asAt, 'Total', ...amounts(a.totals, a.total)],
    ],
  );
}

/* ---- cash flow --------------------------------------------------------- */

/** The money that went into (in) and out of the bank and cash accounts in a month, from one kind of entry. */
export type CashMovement = { month: Month; source: LedgerSource; in: number; out: number };

/**
 * The lines on bank and cash accounts (stands_for 'bank'), added up by month and source, oldest month first
 * and the source name within it. A transfer is left out: it moves money between the workspace's own accounts, so it is
 * no cash flow. A void is not undone in the month of the original: its reversal is a line dated the void date, and
 * it stays in its own source's row as money out (or in), so each month's figures are what happened to the books that month.
 */
export function cashMovements(lines: LedgerLine[], accounts: Pick<LedgerAccount, 'id' | 'stands_for'>[]): CashMovement[] {
  const bank = new Set(accounts.filter((a) => a.stands_for === 'bank').map((a) => a.id));
  const sums = new Map<string, { month: Month; source: LedgerSource; in: number; out: number }>();
  for (const line of lines) {
    if (!line.account_id || !bank.has(line.account_id) || line.source === 'transfer') continue;
    const month = line.entry_date.slice(0, 7);
    const key = `${month}|${line.source}`;
    const row = sums.get(key) ?? { month, source: line.source, in: 0, out: 0 };
    row.in += toSen(line.debit);
    row.out += toSen(line.credit);
    sums.set(key, row);
  }
  return [...sums.values()]
    .sort((a, b) => a.month.localeCompare(b.month) || a.source.localeCompare(b.source))
    .map((row) => ({ ...row, in: fromSen(row.in), out: fromSen(row.out) }));
}

export type CashFlowLine = { key: string; label: string; in: number; out: number; net: number };
export type CashFlow = {
  /** The cash at the start of the period: the net of every movement before it. */
  opening: number;
  /** One per group that moved in the period. */
  lines: CashFlowLine[];
  totalIn: number;
  totalOut: number;
  net: number;
  closing: number;
};

const CASH_GROUPS: { key: string; label: string; sources: LedgerSource[] }[] = [
  { key: 'payment_in', label: 'Received from customers and other income', sources: ['payment_in'] },
  { key: 'refund', label: 'Refunds to customers', sources: ['refund'] },
  // An approved expense accrues (its category against Accrued Expenses) and never touches a bank account; paying it is a payment out.
  { key: 'payment_out', label: 'Paid to suppliers and for expenses', sources: ['payment_out'] },
  { key: 'opening', label: 'Opening balances brought in', sources: ['opening'] },
  { key: 'journal', label: 'Manual journals', sources: ['journal'] },
];

/**
 * A direct-method cash summary for a period. The opening cash is the net of every movement before the first
 * month (opening balances are movements dated the account's opening date), so the closing cash equals the
 * bank and cash accounts' balances on the balance sheet at the end of the period.
 */
export function cashFlow(movements: CashMovement[], period: Period): CashFlow {
  const groups = new Map<string, { in: number; out: number }>();
  let opening = 0;
  for (const m of movements) {
    if (m.month < period.from) opening += toSen(m.in) - toSen(m.out);
    if (m.month < period.from || m.month > period.to) continue;
    const key = CASH_GROUPS.find((g) => g.sources.includes(m.source))?.key ?? 'other';
    const sum = groups.get(key) ?? { in: 0, out: 0 };
    sum.in += toSen(m.in);
    sum.out += toSen(m.out);
    groups.set(key, sum);
  }
  const lines = [...CASH_GROUPS, { key: 'other', label: 'Other' }].flatMap((g) => {
    const sum = groups.get(g.key);
    return sum && (sum.in !== 0 || sum.out !== 0)
      ? [{ key: g.key, label: g.label, in: fromSen(sum.in), out: fromSen(sum.out), net: fromSen(sum.in - sum.out) }]
      : [];
  });
  const totalIn = [...groups.values()].reduce((t, g) => t + g.in, 0);
  const totalOut = [...groups.values()].reduce((t, g) => t + g.out, 0);
  return {
    opening: fromSen(opening),
    lines,
    totalIn: fromSen(totalIn),
    totalOut: fromSen(totalOut),
    net: fromSen(totalIn - totalOut),
    closing: fromSen(opening + totalIn - totalOut),
  };
}

/** The cash flow as a CSV file: the opening cash, a row per group, the total and the closing cash. Amounts are numbers. */
export function cashFlowCsv(cf: CashFlow, period: Period): string {
  const label = periodLabel(period);
  return toCsv(
    ['Period', 'Line', 'In', 'Out', 'Net'],
    [
      [label, 'Opening cash', null, null, cf.opening],
      ...cf.lines.map((l) => [label, l.label, l.in, l.out, l.net]),
      [label, 'Total', cf.totalIn, cf.totalOut, cf.net],
      [label, 'Closing cash', null, null, cf.closing],
    ],
  );
}
