import type { Candidate } from '@/lib/agents/definition';
import type { FinanceAgentRaw, FinanceAgentTaxType } from '@/lib/finance/agent/context';
import { money, rm } from '@/lib/finance/format';
import { sstPeriodFor, sstPeriodLabel } from '@/lib/finance/sst';
import { formatDate, todayInMalaysia } from '@/lib/people/dates';

/** The audit trail's names for what a note is about. */
export const FINANCE_NOTE_ENTITY_TYPES = [
  'finance_invoice',
  'finance_supplier_bill',
  'finance_expense',
  'finance_quotation',
  'finance_bank_account',
  'finance_sst_period',
] as const;
export type FinanceNoteEntityType = (typeof FINANCE_NOTE_ENTITY_TYPES)[number];

/** The input of a `createAgentNote` proposal; the note RPC reads it back from the stored proposal. */
export type FinanceNoteInput = {
  entityType: FinanceNoteEntityType;
  /** Null only for an SST period. */
  entityId: string | null;
  entityLabel: string;
  body: string;
  /** The document id, the bank account id, or `sst:<period start>`. */
  target: string;
  /** When it is raised again: a doubling bucket, `due_soon`/`overdue`, or a date (spec §4.2). */
  stage: string;
  /** invoice_overdue only: the check's minimum unpaid amount, so approval can tell it fell below. */
  minAmount?: number;
};

const DAY_MS = 86_400_000;
/** Longest name put into a label or body. */
const NAME_MAX = 80;

/** Cuts a name to about {@link NAME_MAX} characters with "…" (by code point, never splitting one). */
function cut(name: string): string {
  const chars = Array.from(name);
  return chars.length <= NAME_MAX ? name : `${chars.slice(0, NAME_MAX - 1).join('').trimEnd()}…`;
}

/** Whole days from day `a` to day `b` (`YYYY-MM-DD`); negative when `b` is earlier. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The Malaysian day an ISO timestamp falls on; null when it does not parse. */
function klDayOf(iso: string): string | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : todayInMalaysia(new Date(t));
}

const isDay = (v: string | null): v is string => v !== null && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * The doubling bucket a count of days is in, past the threshold `n`: n, 2n, 4n, 8n… So a check
 * with a 14-day threshold is raised at 14 days, again at 28, then 56, 112. Null below `n`.
 */
export function doublingStage(days: number, n: number): number | null {
  if (n < 1 || days < n) return null;
  let stage = n;
  while (stage * 2 <= days) stage *= 2;
  return stage;
}

const TAX_NAMES: Record<FinanceAgentTaxType, string> = { service: 'service tax', sales: 'sales tax' };

/**
 * Pure: turns the snapshot into suggested notes, one rule per confirmed check (spec §4.1).
 * Every body is a fixed template ending "(as of DD Mon YYYY)", the scan's Malaysian day.
 * No confirmed plan, no suggestions.
 */
export function scanFinance(raw: FinanceAgentRaw, now: Date): Candidate[] {
  if (!raw.plan) return [];
  const today = todayInMalaysia(now);
  const asOf = ` (as of ${formatDate(today)})`;
  const out: Candidate[] = [];
  const note = (checkKey: string, input: FinanceNoteInput, title: string) =>
    out.push({ action: 'createAgentNote', input: { ...input, body: input.body + asOf }, title, detail: null, checkKey });

  for (const check of raw.plan.checks) {
    const days = check.params.days;

    if (check.key === 'invoice_overdue') {
      const minAmount = check.params.min_amount ?? 0;
      const rows = raw.invoices
        .filter((i) => isDay(i.dueDate) && i.balance > 0 && i.balance >= minAmount)
        .map((i) => ({ i, late: daysBetween(i.dueDate as string, today) }))
        .filter(({ late }) => late >= days)
        .sort((a, b) => b.late - a.late);
      for (const { i, late } of rows) {
        const stage = doublingStage(late, days) as number;
        const label = i.invoiceNo ?? 'An invoice';
        const to = i.customer ? ` to ${cut(i.customer)}` : '';
        note(
          check.key,
          {
            entityType: 'finance_invoice',
            entityId: i.id,
            entityLabel: cut(label),
            body: `${label}${to} is ${late} days overdue: ${rm(i.balance)} unpaid.`,
            target: i.id,
            stage: String(stage),
            minAmount,
          },
          `${label}${to} — ${late} days overdue`,
        );
      }
    } else if (check.key === 'bill_due_soon') {
      const last = addDays(today, days);
      const rows = raw.bills
        .filter((b) => isDay(b.dueDate) && b.balance > 0 && (b.dueDate as string) <= last)
        .sort((a, b) => (a.dueDate as string).localeCompare(b.dueDate as string));
      for (const b of rows) {
        const due = b.dueDate as string;
        const overdue = due < today;
        const label = b.billNo ?? 'A bill';
        const from = b.supplier ? ` from ${cut(b.supplier)}` : '';
        note(
          check.key,
          {
            entityType: 'finance_supplier_bill',
            entityId: b.id,
            entityLabel: cut(label),
            body: `${label}${from} ${overdue ? 'was' : 'is'} due ${formatDate(due)}: ${rm(b.balance)} to pay.`,
            target: b.id,
            stage: overdue ? 'overdue' : 'due_soon',
          },
          `${label}${from} — ${overdue ? 'was' : 'is'} due ${formatDate(due)}`,
        );
      }
    } else if (check.key === 'expense_waiting') {
      const rows = raw.expenses
        .map((e) => ({ e, day: klDayOf(e.createdAt) }))
        .filter((r): r is { e: (typeof raw.expenses)[number]; day: string } => r.day !== null)
        .map(({ e, day }) => ({ e, waited: daysBetween(day, today) }))
        .filter(({ waited }) => waited >= days)
        .sort((a, b) => b.waited - a.waited);
      for (const { e, waited } of rows) {
        const to = e.vendor ? ` to ${cut(e.vendor)}` : '';
        note(
          check.key,
          {
            entityType: 'finance_expense',
            entityId: e.id,
            entityLabel: cut(`Expense${to}`),
            body: `Expense of ${rm(e.amount)}${to} has waited ${waited} days for approval.`,
            target: e.id,
            stage: String(doublingStage(waited, days)),
          },
          `Expense of ${rm(e.amount)}${to} — waiting ${waited} days`,
        );
      }
    } else if (check.key === 'quotation_expiring') {
      const last = addDays(today, days);
      const rows = raw.quotations
        .filter((q) => isDay(q.validUntil) && (q.validUntil as string) >= today && (q.validUntil as string) <= last)
        .sort((a, b) => (a.validUntil as string).localeCompare(b.validUntil as string));
      for (const q of rows) {
        const until = q.validUntil as string;
        const label = q.quotationNo ?? 'A quotation';
        const to = q.customer ? ` to ${cut(q.customer)}` : '';
        note(
          check.key,
          {
            entityType: 'finance_quotation',
            entityId: q.id,
            entityLabel: cut(label),
            body: `${label}${to} expires ${formatDate(until)} with no answer.`,
            target: q.id,
            stage: until,
          },
          `${label}${to} — expires ${formatDate(until)}`,
        );
      }
    } else if (check.key === 'draft_stale') {
      const rows = raw.drafts
        .map((d) => ({ d, day: klDayOf(d.updatedAt) }))
        .filter((r): r is { d: (typeof raw.drafts)[number]; day: string } => r.day !== null)
        .map(({ d, day }) => ({ d, idle: daysBetween(day, today) }))
        .filter(({ idle }) => idle >= days)
        .sort((a, b) => b.idle - a.idle);
      for (const { d, idle } of rows) {
        const kind = d.kind === 'invoice' ? 'invoice' : 'bill';
        const party = d.party ? ` ${d.kind === 'invoice' ? 'to' : 'from'} ${cut(d.party)}` : '';
        note(
          check.key,
          {
            entityType: d.kind === 'invoice' ? 'finance_invoice' : 'finance_supplier_bill',
            entityId: d.id,
            entityLabel: cut(`Draft ${kind}${party}`),
            body: `Draft ${kind}${party} hasn't been touched for ${idle} days.`,
            target: d.id,
            stage: String(doublingStage(idle, days)),
          },
          `Draft ${kind}${party} — untouched ${idle} days`,
        );
      }
    } else if (check.key === 'bank_unmatched') {
      const cutoff = addDays(today, -days);
      const byAccount = new Map<string, { account: string; currency: string; count: number; total: number; oldest: string }>();
      for (const line of raw.bankLines) {
        if (!isDay(line.lineDate) || line.lineDate > cutoff) continue;
        const seen = byAccount.get(line.accountId);
        if (seen) {
          seen.count += 1;
          seen.total += line.amount;
          if (line.lineDate < seen.oldest) seen.oldest = line.lineDate;
        } else {
          byAccount.set(line.accountId, {
            account: line.account,
            currency: line.currency,
            count: 1,
            total: line.amount,
            oldest: line.lineDate,
          });
        }
      }
      const rows = [...byAccount.entries()].sort((a, b) => a[1].oldest.localeCompare(b[1].oldest));
      for (const [accountId, a] of rows) {
        const age = daysBetween(a.oldest, today);
        const lines = a.count === 1 ? '1 statement line' : `${a.count} statement lines`;
        note(
          check.key,
          {
            entityType: 'finance_bank_account',
            entityId: accountId,
            entityLabel: cut(a.account),
            body: `${cut(a.account)} has ${lines} older than ${days} days with nothing matched (${money(Math.round(a.total * 100) / 100, a.currency)}).`,
            target: accountId,
            stage: String(doublingStage(age, days)),
          },
          `${cut(a.account)} — ${lines} unmatched`,
        );
      }
    } else if (check.key === 'sst_period_closing') {
      if (!raw.sst) continue;
      const period = sstPeriodFor(today, raw.sst.periodStartMonth);
      const left = daysBetween(today, period.end);
      if (left < 0 || left > days) continue;
      const filed = new Set(raw.sst.filed.filter((f) => f.periodStart === period.start).map((f) => f.taxType));
      const open = raw.sst.taxes.filter((t) => !filed.has(t));
      if (open.length === 0) continue;
      const tax = open.map((t) => TAX_NAMES[t]).join(' and ');
      const label = sstPeriodLabel(period);
      const returns = open.length === 1 ? "its return isn't" : "their returns aren't";
      note(
        check.key,
        {
          entityType: 'finance_sst_period',
          entityId: null,
          entityLabel: `SST ${label}`,
          body: `The ${tax} period ${label} ends ${formatDate(period.end)}; ${returns} marked filed.`,
          target: `sst:${period.start}`,
          stage: period.start,
        },
        `SST period ${label} — ends ${formatDate(period.end)}`,
      );
    }
  }
  return out;
}
