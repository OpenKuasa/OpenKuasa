/**
 * What a payroll form field holds and what it sends. Pure: no clock, no network.
 * Ringgit exists only here and in the formatters: a field's text is converted to
 * integer cents once, by string handling and never by floating-point arithmetic,
 * and everything after that is cents.
 */
import { monthYearLabel } from './dates';
import { STATUTORY_FIELDS } from './statutory-fields';
import type { PayrollRun, StatutoryField } from './types';

type Converted<T> = { ok: true; input: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** The app's own limit on one typed amount: RM 9,999,999.99. */
const MAX_CENTS = 999_999_999;

/**
 * Digits with optional thousands commas (in groups of three) and at most two decimals, after an optional `RM`.
 * A grouped number starts with 1 to 9 (`0,500` is not an amount). `1,200`, `1200.5`, `RM 1200` and ` 1200.50 ` are all fine; `1,20`, `.5`, `1.`, `1e3` and `-5` are not.
 */
const AMOUNT = /^(?:rm\s*)?([1-9]\d{0,2}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/i;

/** Cents for the text, zero included, or null when it is not an amount of money or is above the app's limit. */
function parseCents(text: string): number | null {
  const match = AMOUNT.exec(text.trim());
  if (!match) return null;
  const whole = match[1].replace(/,/g, '');
  // More than 7 whole digits is already above the limit; this also keeps Number() exact.
  if (whole.replace(/^0+(?=\d)/, '').length > 7) return null;
  const sen = (match[2] ?? '').padEnd(2, '0');
  const cents = Number(whole) * 100 + Number(sen);
  return cents <= MAX_CENTS ? cents : null;
}

/** A positive amount in ringgit as integer cents; null for anything else (empty, zero, negative, over two decimals, above RM 9,999,999.99). */
export function ringgitToCents(text: string): number | null {
  const cents = parseCents(text);
  return cents === null || cents === 0 ? null : cents;
}

/** `RM 1,200.50`. Integer arithmetic only. */
export function centsToRinggit(cents: number): string {
  if (!Number.isFinite(cents) || !Number.isInteger(cents)) return 'RM —';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}RM ${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** `2026-10` as `October 2026`. */
export function monthLabel(month: string): string {
  return monthYearLabel(`${month}-01`);
}

/**
 * The month "Run payroll" starts on: the month after the latest run on record, never after this month, and this
 * month when there are no runs. After a workspace's first run the database accepts only this one month (the one
 * right after the latest run); a gap earlier than the latest run can no longer be filled.
 * `YYYY-MM`, or null when the latest run is already this month or later: there is nothing the database would accept.
 */
export function nextRunMonth(runs: Pick<PayrollRun, 'period_month'>[], today: string): string | null {
  const current = today.slice(0, 7);
  const latest = runs.reduce<string | null>(
    (best, run) => (best === null || run.period_month > best ? run.period_month : best),
    null,
  );
  if (!latest) return current;
  const year = Number(latest.slice(0, 4));
  const monthIndex = Number(latest.slice(5, 7)); // the month after, counted from 1 below
  const next = monthIndex === 12 ? `${year + 1}-01` : `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
  return next > current ? null : next;
}

const LABEL_MAX = 80;

/** What the add-or-edit line form sends. The name is trimmed; the amount is in cents. */
export function toLineInput(values: {
  kind: string;
  label: string;
  amount: string;
}): Converted<{ kind: 'earning' | 'deduction'; label: string; amount_cents: number }> {
  if (values.kind !== 'earning' && values.kind !== 'deduction') return bad('Choose whether it is an earning or a deduction.');
  const label = values.label.trim();
  if (label === '') return bad('Give the line a name.');
  if (label.length > LABEL_MAX) return bad(`Keep the name to ${LABEL_MAX} characters.`);
  const amount = ringgitToCents(values.amount);
  if (amount === null) return bad('Enter an amount above zero, like 1,200.50. It can be up to RM 9,999,999.99.');
  return { ok: true, input: { kind: values.kind, label, amount_cents: amount } };
}

const FIELDS: readonly string[] = STATUTORY_FIELDS;

/** What the statutory-figure form sends. An empty amount puts the figure back to the proposed amount; zero is a figure. */
export function toStatutoryInput(values: {
  field: string;
  amount: string;
}): Converted<{ field: StatutoryField; amount_cents: number | null }> {
  if (!FIELDS.includes(values.field)) return bad('Choose EPF, SOCSO, EIS or PCB.');
  const field = values.field as StatutoryField;
  if (values.amount.trim() === '') return { ok: true, input: { field, amount_cents: null } };
  const amount = parseCents(values.amount);
  if (amount === null) return bad('Enter an amount like 110.50, or leave it empty to use the proposed amount.');
  return { ok: true, input: { field, amount_cents: amount } };
}
