import type { Candidate } from '@/lib/agents/definition';
import { doublingStage } from '@/lib/agents/focus/stage';
import type { PeopleAgentRaw } from '@/lib/people/agent/context';
import {
  addDays,
  addMonths,
  daysBetween,
  formatDate,
  formatDay,
  isRealDate,
  malaysiaDate,
  monthLabel,
  monthStart,
  monthYearLabel,
  todayInMalaysia,
} from '@/lib/people/dates';

/** What a note can be about; the `hr_agent_notes.entity_type` values. */
export const PEOPLE_NOTE_ENTITY_TYPES = [
  'hr_employee',
  'hr_document',
  'hr_goal',
  'hr_leave_request',
  'hr_claim',
  'hr_overtime_record',
  'hr_letter',
  'hr_payroll_month',
] as const;
export type PeopleNoteEntityType = (typeof PEOPLE_NOTE_ENTITY_TYPES)[number];

/** The input of a `createAgentNote` proposal; the note RPC reads it back from the stored proposal. */
export type PeopleNoteInput = {
  entityType: PeopleNoteEntityType;
  /** The record's id (the employee's for `hr_employee`); null only for a payroll month. */
  entityId: string | null;
  /** The record's own employee, so the note goes with them; null only for a payroll month. */
  employeeId: string | null;
  /** The employee's name, or `Payroll Oct 2026`. Shown to HR only, never to the model. */
  entityLabel: string;
  body: string;
  /** The record id, or `payroll:YYYY-MM`. */
  target: string;
  /** When it is raised again: a doubling bucket, `soon`/`expired`, a date or a month (spec §4.2). */
  stage: string;
  /** document_expiring only: the check's N, so approval can tell the document was renewed past it. */
  days?: number;
};

/** Longest name or goal title put into a label or body. */
const NAME_MAX = 80;
/** absent_streak looks at this many calendar days, today included. */
const STREAK_WINDOW_DAYS = 14;

/** Cuts text to about {@link NAME_MAX} characters with "…" (by code point, never splitting one). */
function cut(text: string): string {
  const chars = Array.from(text);
  return chars.length <= NAME_MAX ? text : `${chars.slice(0, NAME_MAX - 1).join('').trimEnd()}…`;
}

const daysText = (n: number): string => (n === 1 ? '1 day' : `${n} days`);
const isDay = (v: string | null): v is string => v !== null && isRealDate(v);

/**
 * How a document is named at the start of a note (spec §12.2): "{name}'s contract" for a named
 * type; a medical document is only ever "A confidential document for {name}", and `other` or any
 * unknown type is "A document for {name}". Never the document's own title.
 */
function docPhrase(docType: string, name: string): string {
  const named: Record<string, string> = {
    contract: 'contract',
    tax: 'tax document',
    benefits: 'benefits document',
    identity: 'identity document',
    certificate: 'certificate',
  };
  if (Object.hasOwn(named, docType)) return `${name}'s ${named[docType]}`;
  return docType === 'medical' ? `A confidential document for ${name}` : `A document for ${name}`;
}

/** `02 Nov 2026`, `02 Nov–04 Nov 2026` or `31 Dec 2026–02 Jan 2027`. */
function dateRange(start: string, end: string): string {
  if (start === end) return formatDate(start);
  if (start.slice(0, 4) === end.slice(0, 4)) return `${formatDay(start)}–${formatDate(end)}`;
  return `${formatDate(start)}–${formatDate(end)}`;
}

/**
 * Pure: turns the snapshot into suggested notes, one rule per confirmed check (spec §4.1, §12).
 * Only active employees count; a row whose employee is inactive or unknown is skipped. Every body
 * is a fixed template ending "(as of DD Mon YYYY)", the scan's Malaysian day. Titles (what the
 * model sees) carry only the check's label and numbers: never a name, title, date or id.
 * No confirmed plan, no suggestions.
 */
export function scanPeople(raw: PeopleAgentRaw, now: Date): Candidate[] {
  if (!raw.plan) return [];
  const today = todayInMalaysia(now);
  const asOf = ` (as of ${formatDate(today)})`;
  const active = new Map(raw.employees.filter((e) => e.active).map((e) => [e.id, cut(e.name)]));
  const out: Candidate[] = [];
  const note = (checkKey: string, input: PeopleNoteInput, title: string) =>
    out.push({ action: 'createAgentNote', input: { ...input, body: input.body + asOf }, title, detail: null, checkKey });
  /** A record of an active employee, with that employee's name. */
  const ofActive = <T extends { employeeId: string }>(rows: T[]) =>
    rows.flatMap((row) => {
      const name = active.get(row.employeeId);
      return name === undefined ? [] : [{ row, name }];
    });
  /** Whole Malaysian days since an ISO timestamp; null when it does not parse. */
  const daysSince = (iso: string): number | null => {
    const day = malaysiaDate(iso);
    return day === '' ? null : daysBetween(day, today);
  };
  /** A record waiting since `createdAt`, at least `days` days, worst first. */
  const waiting = <T extends { employeeId: string; createdAt: string }>(rows: T[], days: number) =>
    ofActive(rows)
      .map((r) => ({ ...r, waited: daysSince(r.row.createdAt) }))
      .filter((r): r is typeof r & { waited: number } => r.waited !== null && r.waited >= days)
      .sort((a, b) => b.waited - a.waited);

  for (const check of raw.plan.checks) {
    const days = check.params.days;

    if (check.key === 'document_expiring') {
      const last = addDays(today, days);
      const rows = ofActive(raw.documents)
        .filter(({ row }) => isDay(row.expiresOn) && (row.expiresOn as string) <= last)
        .sort((a, b) => (a.row.expiresOn as string).localeCompare(b.row.expiresOn as string));
      for (const { row, name } of rows) {
        const on = row.expiresOn as string;
        const expired = on < today;
        const left = daysBetween(today, on);
        const title = expired
          ? `Document expired · ${daysText(-left)} ago`
          : left === 0
            ? 'Document expiring · today'
            : `Document expiring · in ${daysText(left)}`;
        note(
          check.key,
          {
            entityType: 'hr_document',
            entityId: row.id,
            employeeId: row.employeeId,
            entityLabel: name,
            body: `${docPhrase(row.docType, name)} ${expired ? 'expired' : 'expires'} ${formatDate(on)}.`,
            target: row.id,
            stage: expired ? 'expired' : 'soon',
            days,
          },
          title,
        );
      }
    } else if (check.key === 'goal_overdue') {
      // N = 0 means any day late: buckets of 1, 2, 4… days.
      const n = Math.max(days, 1);
      const rows = ofActive(raw.goals)
        .filter(({ row }) => isDay(row.dueDate))
        .map((r) => ({ ...r, late: daysBetween(r.row.dueDate as string, today) }))
        .filter(({ late }) => late >= n)
        .sort((a, b) => b.late - a.late);
      for (const { row, name, late } of rows) {
        const progress = Math.round(Math.min(100, Math.max(0, row.progress)));
        note(
          check.key,
          {
            entityType: 'hr_goal',
            entityId: row.id,
            employeeId: row.employeeId,
            entityLabel: name,
            body: `${name}'s goal "${cut(row.title)}" was due ${formatDate(row.dueDate as string)} and is ${progress}% done.`,
            target: row.id,
            stage: String(doublingStage(late, n)),
          },
          `Goal overdue · ${progress}% done · ${daysText(late)} late`,
        );
      }
    } else if (check.key === 'leave_waiting') {
      for (const { row, name, waited } of waiting(raw.leaves, days)) {
        if (!isDay(row.startDate) || !isDay(row.endDate)) continue;
        note(
          check.key,
          {
            entityType: 'hr_leave_request',
            entityId: row.id,
            employeeId: row.employeeId,
            entityLabel: name,
            body: `${name}'s leave request for ${dateRange(row.startDate, row.endDate)} has waited ${daysText(waited)} for a decision.`,
            target: row.id,
            stage: String(doublingStage(waited, days)),
          },
          `Leave waiting · ${daysText(waited)}`,
        );
      }
    } else if (check.key === 'leave_starts_soon') {
      const last = addDays(today, days);
      const rows = ofActive(raw.leaves)
        .filter(({ row }) => isDay(row.startDate) && row.startDate <= last)
        .sort((a, b) => a.row.startDate.localeCompare(b.row.startDate));
      for (const { row, name } of rows) {
        const left = daysBetween(today, row.startDate);
        const title =
          left < 0
            ? `Leave started · ${daysText(-left)} ago · still waiting`
            : left === 0
              ? 'Leave starts today · still waiting'
              : `Leave starts soon · in ${daysText(left)}`;
        note(
          check.key,
          {
            entityType: 'hr_leave_request',
            entityId: row.id,
            employeeId: row.employeeId,
            entityLabel: name,
            body: `${name}'s leave from ${formatDate(row.startDate)} is still waiting for a decision.`,
            target: row.id,
            stage: row.startDate,
          },
          title,
        );
      }
    } else if (check.key === 'claim_waiting') {
      for (const { row, name, waited } of waiting(raw.claims, days)) {
        if (!isDay(row.claimDate)) continue;
        note(
          check.key,
          {
            entityType: 'hr_claim',
            entityId: row.id,
            employeeId: row.employeeId,
            entityLabel: name,
            body: `${name}'s claim dated ${formatDate(row.claimDate)} has waited ${daysText(waited)} for a decision.`,
            target: row.id,
            stage: String(doublingStage(waited, days)),
          },
          `Claim waiting · ${daysText(waited)}`,
        );
      }
    } else if (check.key === 'overtime_waiting') {
      for (const { row, name, waited } of waiting(raw.overtime, days)) {
        if (!isDay(row.workDate)) continue;
        note(
          check.key,
          {
            entityType: 'hr_overtime_record',
            entityId: row.id,
            employeeId: row.employeeId,
            entityLabel: name,
            body: `${name}'s overtime on ${formatDate(row.workDate)} has waited ${daysText(waited)} for a decision.`,
            target: row.id,
            stage: String(doublingStage(waited, days)),
          },
          `Overtime waiting · ${daysText(waited)}`,
        );
      }
    } else if (check.key === 'letter_draft_stale') {
      for (const { row, name, waited } of waiting(raw.letters, days)) {
        note(
          check.key,
          {
            entityType: 'hr_letter',
            entityId: row.id,
            employeeId: row.employeeId,
            entityLabel: name,
            body: `A draft letter for ${name} has waited ${daysText(waited)} to be issued.`,
            target: row.id,
            stage: String(doublingStage(waited, days)),
          },
          `Draft letter waiting · ${daysText(waited)}`,
        );
      }
    } else if (check.key === 'absent_streak') {
      // Consecutive attendance rows (working days), not calendar days (spec §12.5).
      const since = addDays(today, -(STREAK_WINDOW_DAYS - 1));
      const byEmployee = new Map<string, { workDate: string; status: string }[]>();
      for (const a of raw.attendance) {
        if (!active.has(a.employeeId) || !isDay(a.workDate) || a.workDate < since || a.workDate > today) continue;
        const rows = byEmployee.get(a.employeeId) ?? [];
        rows.push(a);
        byEmployee.set(a.employeeId, rows);
      }
      const streaks: { employeeId: string; name: string; count: number; first: string }[] = [];
      for (const [employeeId, rows] of byEmployee) {
        rows.sort((a, b) => a.workDate.localeCompare(b.workDate));
        let count = 0;
        let first = '';
        for (let i = rows.length - 1; i >= 0 && rows[i].status === 'absent'; i -= 1) {
          count += 1;
          first = rows[i].workDate;
        }
        if (count >= days) streaks.push({ employeeId, name: active.get(employeeId) as string, count, first });
      }
      streaks.sort((a, b) => b.count - a.count || a.first.localeCompare(b.first));
      for (const s of streaks) {
        const run = s.count === 1 ? '1 working day' : `${s.count} working days`;
        note(
          check.key,
          {
            entityType: 'hr_employee',
            entityId: s.employeeId,
            employeeId: s.employeeId,
            entityLabel: s.name,
            body: `${s.name} has been marked absent ${run} in a row (since ${formatDate(s.first)}).`,
            target: s.employeeId,
            stage: s.first,
          },
          `Absent ${run} in a row`,
        );
      }
    } else if (check.key === 'payroll_unpaid') {
      // A workspace with nobody active has no payroll to chase.
      if (active.size === 0) continue;
      const start = monthStart(today);
      // Day 31 in a 30-day month means its last day.
      const lastDay = daysBetween(start, addMonths(today, 1));
      if (Number(today.slice(8, 10)) < Math.min(check.params.day, lastDay)) continue;
      const run = raw.payrollRuns.find((r) => r.periodMonth === start);
      if (run?.status === 'paid') continue;
      const month = today.slice(0, 7);
      const label = `Payroll ${monthLabel(today)} ${today.slice(0, 4)}`;
      note(
        check.key,
        {
          entityType: 'hr_payroll_month',
          entityId: null,
          employeeId: null,
          entityLabel: label,
          body: `Payroll for ${monthYearLabel(today)} isn't marked paid yet.`,
          target: `payroll:${month}`,
          stage: month,
        },
        `${label} not marked paid`,
      );
    }
  }
  return out;
}
