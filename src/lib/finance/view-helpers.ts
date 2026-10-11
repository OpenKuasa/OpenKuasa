/**
 * What the purchase and sales screens' figures share: dates, sums that do not
 * drift, the month window of a trend chart, and how payment methods are
 * grouped and coloured. Pure, with no server imports. `today` and every date
 * here is a YYYY-MM-DD string.
 */
import type { PaymentMethod } from './money';

export type Stat = {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: 'up' | 'down' | 'flat';
};

/** Rows a table shows before "View all" is pressed. */
export const LATEST_ROWS = 10;

/** Months a trend chart covers, the current one included. */
export const TREND_MONTHS = 8;

/** Money that moved without a note or a cheque changing hands. */
export const ELECTRONIC: ReadonlySet<PaymentMethod> = new Set(['bank_transfer', 'fpx', 'duitnow', 'card', 'ewallet']);

/** Seven methods, five chart colours: Cash and Cheque get a fixed green and a fixed brown. */
export const METHOD_COLORS: Record<PaymentMethod, string> = {
  bank_transfer: 'var(--chart-1)',
  fpx: 'var(--chart-2)',
  duitnow: 'var(--chart-5)',
  card: 'var(--chart-3)',
  ewallet: 'var(--chart-4)',
  cash: 'oklch(0.7 0.13 130)',
  cheque: 'oklch(0.6 0.09 55)',
};

// Fixed names: Intl's short months vary by ICU version ('Sep' vs 'Sept').
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-10-08 → 08 Oct 2026 */
export function displayDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Today's date in UTC, the date the database uses to decide what is overdue. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 1 bill, 2 bills */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** A total in ringgit, rounded to the sen so 0.1 + 0.2 is 0.3. */
export function sum<T>(rows: T[], pick: (row: T) => number): number {
  return round2(rows.reduce((total, row) => total + pick(row), 0));
}

/** An amount in RM thousands with one decimal, for a trend chart's axis. */
export function thousands(amount: number): number {
  return Math.round(amount / 100) / 10;
}

/** The YYYY-MM a date falls in. */
export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

/** The last `months` months up to and including today's, oldest first: its YYYY-MM key and its short name. */
export function lastMonths(today: string, months: number = TREND_MONTHS): { key: string; label: string }[] {
  const [y, m] = monthOf(today).split('-').map(Number);
  return Array.from({ length: months }, (_, i) => {
    const start = new Date(Date.UTC(y, m - months + i, 1));
    return { key: start.toISOString().slice(0, 7), label: MONTHS[start.getUTCMonth()] };
  });
}

/** How many payments the rows belong to: a payment split across documents is one payment. */
export function paymentCount(rows: { transaction_id: string }[]): number {
  return new Set(rows.map((row) => row.transaction_id)).size;
}
