import type { BankAccountRow, BankTransactionRow } from './banking';
import { cashBookRinggit } from './cash-book';
import { invoicePaidRinggit, invoiceRinggit, type InvoiceListRow } from './invoices';
import type { LedgerAccount, LedgerLine } from './ledger';
import {
  aged,
  cashFlow,
  cashMovements,
  expenseBreakdown,
  monthlySeries,
  monthlyTotals,
  periodFor,
  profitAndLoss,
  type Aged,
  type Month,
  type MonthSeries,
  type OpenDocument,
  type Period,
  type ProfitAndLoss,
} from './reports';

/** What the Dashboard and Overview read. A null is a read that failed; the ledger reads never are. */
export type DashboardInputs = {
  lines: LedgerLine[];
  accounts: LedgerAccount[];
  receivables: OpenDocument[] | null;
  payables: OpenDocument[] | null;
  bankAccounts: BankAccountRow[] | null;
  bankTransactions: BankTransactionRow[] | null;
};

/* ---- the period the Dashboard shows ----------------------------------- */

export type DashboardPeriodKey = 'this_month' | 'this_quarter' | 'this_year';

export const DASHBOARD_PERIODS: { key: DashboardPeriodKey; label: string }[] = [
  { key: 'this_month', label: 'This month' },
  { key: 'this_quarter', label: 'This quarter' },
  { key: 'this_year', label: 'This year' },
];

/** How many months the trend charts draw, ending with this month. */
export const TREND_MONTHS = 8;

/** How many movements "Recent cash" lists. */
export const RECENT_CASH_ROWS = 8;

/** The period from the page's search params: anything unknown (or repeated) reads as this month. */
export function parseDashboardPeriod(raw: string | string[] | undefined): DashboardPeriodKey {
  return DASHBOARD_PERIODS.find((p) => p.key === raw)?.key ?? 'this_month';
}

const toSen = (amount: number) => Math.round(amount * 100);
const fromSen = (sen: number) => sen / 100;

const monthNumber = (month: Month) => Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1);
const monthAt = (n: number): Month => `${String(Math.floor(n / 12)).padStart(4, '0')}-${String((n % 12) + 1).padStart(2, '0')}`;

/** The period just before this one, the same number of months long and ending the month before it starts. */
export function previousPeriod(period: Period): Period {
  const length = monthNumber(period.to) - monthNumber(period.from) + 1;
  const start = monthNumber(period.from);
  return { from: monthAt(start - length), to: monthAt(start - 1) };
}

/** The months the trend charts draw: TREND_MONTHS of them, ending with today's month. */
export function trendPeriod(today: string): Period {
  const end = monthNumber(today.slice(0, 7));
  return { from: monthAt(end - (TREND_MONTHS - 1)), to: monthAt(end) };
}

/** How much higher (or lower) `current` is than `previous`, in whole percent; null when there is nothing to compare to. */
export function percentChange(current: number, previous: number): number | null {
  if (toSen(previous) === 0) return null;
  return Math.round(((toSen(current) - toSen(previous)) / Math.abs(toSen(previous))) * 100);
}

/* ---- the model -------------------------------------------------------- */

export type CashPoint = { label: string; balance: number; net: number };

export type RecentCash = {
  id: string;
  date: string;
  party: string;
  documents: string | null;
  direction: 'in' | 'out';
  amount: number;
  status: string;
  accountName: string;
};

export type DashboardModel = {
  periodKey: DashboardPeriodKey;
  period: Period;
  pl: ProfitAndLoss;
  deltas: { revenue: number | null; expenses: number | null; net: number | null };
  series: MonthSeries;
  breakdown: { key: string; label: string; value: number }[];
  cashTrend: CashPoint[];
  /** Ringgit across the active accounts; null when the accounts could not be read. */
  cashPosition: number | null;
  bankAccounts: { id: string; name: string; kind: 'bank' | 'cash'; balance: number }[] | null;
  receivable: Aged | null;
  payable: Aged | null;
  recentCash: RecentCash[] | null;
  /** Nothing has been recorded yet: no ledger lines, no bank accounts and no open documents. */
  isEmpty: boolean;
};

/** Posted money in or out that is not a transfer between the workspace's own accounts. */
const isCashMovement = (t: BankTransactionRow) => t.status === 'posted' && t.kind !== 'transfer';

/**
 * Everything the Dashboard shows, worked out from the reads with the Reports screen's own functions, so the two
 * never disagree. Sums are in sen; a read that failed stays null instead of becoming zero.
 */
export function buildDashboardModel(inputs: DashboardInputs, today: string, periodKey: DashboardPeriodKey): DashboardModel {
  const { totals } = monthlyTotals(inputs.lines);
  const period = periodFor(periodKey, today, totals);
  const pl = profitAndLoss(inputs.accounts, totals, period);
  const before = profitAndLoss(inputs.accounts, totals, previousPeriod(period));

  const series = monthlySeries(inputs.accounts, totals, trendPeriod(today));
  const movements = cashMovements(inputs.lines, inputs.accounts);
  const cashTrend = series.map((point) => {
    const flow = cashFlow(movements, { from: point.month, to: point.month });
    return { label: point.label, balance: flow.closing, net: fromSen(toSen(flow.totalIn) - toSen(flow.totalOut)) };
  });

  const active = inputs.bankAccounts === null ? null : inputs.bankAccounts.filter((a) => a.active);
  const cashPosition = active === null ? null : fromSen(active.reduce((t, a) => t + toSen(a.balance_myr), 0));

  const recentCash =
    inputs.bankTransactions === null
      ? null
      : inputs.bankTransactions
          .filter(isCashMovement)
          .sort((a, b) => b.txn_date.localeCompare(a.txn_date) || b.created_at.localeCompare(a.created_at))
          .slice(0, RECENT_CASH_ROWS)
          .map((t) => ({
            id: t.transaction_id,
            date: t.txn_date,
            party: t.party_name ?? t.category_name ?? '',
            documents: t.documents,
            direction: t.direction,
            amount: cashBookRinggit(t),
            status: t.status,
            accountName: t.account_name,
          }));

  return {
    periodKey,
    period,
    pl,
    deltas: {
      revenue: percentChange(pl.totalIncome, before.totalIncome),
      expenses: percentChange(pl.totalExpenses, before.totalExpenses),
      net: percentChange(pl.netProfit, before.netProfit),
    },
    series,
    breakdown: expenseBreakdown(pl),
    cashTrend,
    cashPosition,
    bankAccounts:
      active === null ? null : active.map((a) => ({ id: a.id, name: a.name, kind: a.kind, balance: a.balance_myr })),
    receivable: inputs.receivables === null ? null : aged(inputs.receivables, today),
    payable: inputs.payables === null ? null : aged(inputs.payables, today),
    recentCash,
    isEmpty:
      inputs.lines.length === 0 &&
      (inputs.bankAccounts?.length ?? 0) === 0 &&
      (inputs.receivables?.length ?? 0) === 0 &&
      (inputs.payables?.length ?? 0) === 0,
  };
}

/* ---- weekly cash and collection rate ---------------------------------- */

export type WeekCash = { weekStart: string; label: string; in: number; out: number };

const DAY_MS = 86_400_000;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const dayOf = (date: string) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The Monday of the week a date falls in. */
const mondayOf = (date: string) => {
  const ms = dayOf(date);
  return ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS;
};

/**
 * Money in and out per ISO week (Monday first), the last `weeks` weeks ending with today's, oldest first, empty
 * weeks included. Posted movements only, transfers left out, in ringgit.
 */
export function weeklyCash(txns: BankTransactionRow[], today: string, weeks = 8): WeekCash[] {
  const last = mondayOf(today);
  const rows = Array.from({ length: weeks }, (_, i) => {
    const weekStart = isoOf(last - (weeks - 1 - i) * 7 * DAY_MS);
    return { weekStart, label: `${weekStart.slice(8, 10)} ${SHORT_MONTHS[Number(weekStart.slice(5, 7)) - 1]}`, in: 0, out: 0 };
  });
  for (const t of txns) {
    if (!isCashMovement(t)) continue;
    const week = rows.find((r) => r.weekStart === isoOf(mondayOf(t.txn_date)));
    if (week) week[t.direction] += toSen(cashBookRinggit(t));
  }
  return rows.map((r) => ({ ...r, in: fromSen(r.in), out: fromSen(r.out) }));
}

/**
 * The share of what was invoiced in the last `days` days that has been paid, in whole percent, in ringgit. Drafts
 * and voids are not counted; null when nothing was invoiced.
 */
export function collectionRate(invoices: InvoiceListRow[], today: string, days = 90): number | null {
  const since = isoOf(dayOf(today) - days * DAY_MS);
  let paid = 0;
  let total = 0;
  for (const inv of invoices) {
    if (inv.display_status === 'draft' || inv.display_status === 'void') continue;
    if (inv.invoice_date <= since || inv.invoice_date > today) continue;
    paid += toSen(invoicePaidRinggit(inv));
    total += toSen(invoiceRinggit(inv).total);
  }
  return total === 0 ? null : Math.round((100 * paid) / total);
}
