import type { Candidate } from '@/lib/agents/definition';
import { doublingStage } from '@/lib/agents/focus/stage';
import type { HireAgentRaw } from '@/lib/hire/agent/context';
import { STAGE_LABEL } from '@/lib/hire/applications-view';
import { POOL_LABEL, type InPool } from '@/lib/hire/pool';
import { addDays, daysBetween, formatDate, malaysiaDate, todayInMalaysia } from '@/lib/people/dates';

/** What a note can be about. */
export const HIRE_NOTE_ENTITY_TYPES = ['hire_application', 'hire_interview', 'hire_job', 'hire_candidate'] as const;
export type HireNoteEntityType = (typeof HIRE_NOTE_ENTITY_TYPES)[number];

/**
 * The input of a `createAgentNote` proposal; the note RPC (`hire_add_agent_note`) reads
 * `target`, `entity_type`, `label` and `body` back from the stored proposal.
 */
export type HireNoteInput = {
  /** The record's id. */
  target: string;
  entity_type: HireNoteEntityType;
  label: string;
  body: string;
  /** When it is raised again: a doubling bucket number, `once`, or a closing date (spec §4.2). */
  stage: string;
};

/** Longest name put into a label or body. */
const NAME_MAX = 80;

/** Cuts a name to about {@link NAME_MAX} characters with "…" (by code point, never splitting one). */
function cut(name: string): string {
  const chars = Array.from(name);
  return chars.length <= NAME_MAX ? name : `${chars.slice(0, NAME_MAX - 1).join('').trimEnd()}…`;
}

/** The Malaysian day an instant falls on; null when it does not parse. */
function dayOf(iso: string | null): string | null {
  if (!iso) return null;
  const day = malaysiaDate(iso);
  return day === '' ? null : day;
}

/** Whole Malaysian days from an instant to today; null when it does not parse. */
function daysSince(iso: string | null, today: string): number | null {
  const day = dayOf(iso);
  return day === null ? null : daysBetween(day, today);
}

/**
 * The bucket number for "raised again only when it gets worse": 1 at n to 2n-1 days, 2 at 2n to
 * 4n-1, 3 at 4n… Null below n.
 */
function bucket(days: number, n: number): string | null {
  const stage = doublingStage(days, n);
  return stage === null ? null : String(Math.round(Math.log2(stage / n)) + 1);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Latest of the instants given, by time; null when none parses. */
function latest(instants: (string | null)[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const i of instants) {
    if (!i) continue;
    const t = Date.parse(i);
    if (!Number.isNaN(t) && t > bestMs) {
      best = i;
      bestMs = t;
    }
  }
  return best;
}

type App = HireAgentRaw['applications'][number];
type Interview = HireAgentRaw['interviews'][number];

/**
 * Pure: turns the snapshot into suggested notes, one rule per confirmed check (spec §4.1). Only
 * active applications are raised. Every label, title and body names only the candidate, the job,
 * the stage, dates, day counts and counts, and every body is a fixed template ending
 * "(as of DD Mon YYYY)", the scan's Malaysian day. No confirmed plan, no suggestions.
 */
export function scanHire(raw: HireAgentRaw, now: Date): Candidate[] {
  if (!raw.plan) return [];
  const today = todayInMalaysia(now);
  const asOf = ` (as of ${formatDate(today)})`;
  const out: Candidate[] = [];
  const note = (checkKey: string, input: HireNoteInput, title: string) =>
    out.push({ action: 'createAgentNote', input: { ...input, body: input.body + asOf }, title, detail: null, checkKey });

  const active = raw.applications.filter((a) => a.outcome === 'active');
  const appById = new Map(raw.applications.map((a) => [a.id, a]));
  const interviewsOf = new Map<string, Interview[]>();
  for (const i of raw.interviews) {
    const list = interviewsOf.get(i.applicationId);
    if (list) list.push(i);
    else interviewsOf.set(i.applicationId, [i]);
  }
  const appLabel = (a: App) => `${cut(a.candidate)} · ${cut(a.job)}`;
  const opened = (j: HireAgentRaw['jobs'][number]) => j.openedAt ?? j.createdAt;
  const openJobs = raw.jobs.filter((j) => j.status === 'open');

  /** Active applications at `stages`, with their day count from `from`, past `days`, worst first. */
  const overdue = (stages: string[], from: (a: App) => string | null, days: number) =>
    active
      .filter((a) => stages.includes(a.stage))
      .map((a) => ({ a, n: daysSince(from(a), today) }))
      .filter((r): r is { a: App; n: number } => r.n !== null && r.n >= days)
      .sort((x, y) => y.n - x.n);

  /** Interviews in `status` held at least `days` ago, on an active application, oldest first. */
  const pastInterviews = (status: string, days: number, extra: (i: Interview) => boolean) =>
    raw.interviews
      .filter((i) => i.status === status && extra(i))
      .map((i) => ({ i, a: appById.get(i.applicationId), day: dayOf(i.scheduledAt) }))
      .filter((r): r is { i: Interview; a: App; day: string } => !!r.a && r.a.outcome === 'active' && r.day !== null)
      .filter((r) => daysBetween(r.day, today) >= days)
      .sort((x, y) => x.day.localeCompare(y.day));

  for (const check of raw.plan.checks) {
    const days = check.params.days;

    if (check.key === 'application_unscreened') {
      for (const { a, n } of overdue(['applied'], (x) => x.appliedAt, days)) {
        note(
          check.key,
          {
            target: a.id,
            entity_type: 'hire_application',
            label: appLabel(a),
            body: `${cut(a.candidate)} applied for ${cut(a.job)} ${n} days ago and is still at Applied.`,
            stage: bucket(n, days) as string,
          },
          `${appLabel(a)} — at Applied for ${n} days`,
        );
      }
    } else if (check.key === 'screening_no_interview') {
      for (const { a, n } of overdue(['screening'], (x) => x.appliedAt, days)) {
        if (interviewsOf.has(a.id)) continue;
        note(
          check.key,
          {
            target: a.id,
            entity_type: 'hire_application',
            label: appLabel(a),
            body: `${cut(a.candidate)} is at Screening for ${cut(a.job)} with no interview booked, ${n} days after applying.`,
            stage: bucket(n, days) as string,
          },
          `${appLabel(a)} — at Screening, no interview, ${n} days`,
        );
      }
    } else if (check.key === 'application_quiet') {
      // Last activity: the latest of applied, offered, and its interviews' created, updated and feedback times.
      const lastActivity = (a: App) =>
        latest([
          a.appliedAt,
          a.offeredAt,
          ...(interviewsOf.get(a.id) ?? []).flatMap((i) => [i.createdAt, i.updatedAt, i.feedbackAt]),
        ]);
      for (const { a, n } of overdue(['interview', 'offer'], lastActivity, days)) {
        note(
          check.key,
          {
            target: a.id,
            entity_type: 'hire_application',
            label: appLabel(a),
            body: `${cut(a.candidate)} (${cut(a.job)}, ${STAGE_LABEL[a.stage]}) has had no activity for ${n} days.`,
            stage: bucket(n, days) as string,
          },
          `${appLabel(a)} — no activity for ${n} days`,
        );
      }
    } else if (check.key === 'interview_not_updated') {
      for (const { i, a, day } of pastInterviews('scheduled', days, () => true)) {
        note(
          check.key,
          {
            target: i.id,
            entity_type: 'hire_interview',
            label: appLabel(a),
            body: `The interview with ${cut(a.candidate)} for ${cut(a.job)} on ${formatDate(day)} is still marked Scheduled.`,
            stage: 'once',
          },
          `${appLabel(a)} — interview on ${formatDate(day)} still Scheduled`,
        );
      }
    } else if (check.key === 'feedback_missing') {
      for (const { i, a, day } of pastInterviews('completed', days, (x) => x.feedbackAt === null)) {
        note(
          check.key,
          {
            target: i.id,
            entity_type: 'hire_interview',
            label: appLabel(a),
            body: `The interview with ${cut(a.candidate)} for ${cut(a.job)} on ${formatDate(day)} has no feedback yet.`,
            stage: 'once',
          },
          `${appLabel(a)} — no feedback for the interview on ${formatDate(day)}`,
        );
      }
    } else if (check.key === 'offer_waiting') {
      for (const { a, n } of overdue(['offer'], (x) => x.offeredAt, days)) {
        note(
          check.key,
          {
            target: a.id,
            entity_type: 'hire_application',
            label: appLabel(a),
            body: `The offer to ${cut(a.candidate)} for ${cut(a.job)} was made ${n} days ago and has no answer recorded.`,
            stage: bucket(n, days) as string,
          },
          `${appLabel(a)} — offer made ${n} days ago`,
        );
      }
    } else if (check.key === 'job_open_long') {
      const rows = openJobs
        .map((j) => ({ j, n: daysSince(opened(j), today) }))
        .filter((r): r is { j: HireAgentRaw['jobs'][number]; n: number } => r.n !== null && r.n >= days)
        .sort((x, y) => y.n - x.n);
      for (const { j, n } of rows) {
        const headcount = j.headcount ?? 1;
        const hired = active.filter((a) => a.jobId === j.id && a.stage === 'hired').length;
        if (hired >= headcount) continue;
        note(
          check.key,
          {
            target: j.id,
            entity_type: 'hire_job',
            label: cut(j.title),
            body: `${cut(j.title)} has been open ${n} days with ${hired} of ${headcount} hired.`,
            stage: bucket(n, days) as string,
          },
          `${cut(j.title)} — open ${n} days, ${hired} of ${headcount} hired`,
        );
      }
    } else if (check.key === 'job_few_applicants') {
      const min = check.params.min ?? 1;
      const rows = openJobs
        .map((j) => ({ j, n: daysSince(opened(j), today) }))
        .filter((r): r is { j: HireAgentRaw['jobs'][number]; n: number } => r.n !== null && r.n >= days)
        .sort((x, y) => y.n - x.n);
      for (const { j, n } of rows) {
        // Every application received in the window counts, whatever happened to it since.
        const k = raw.applications.filter((a) => {
          if (a.jobId !== j.id) return false;
          const since = daysSince(a.appliedAt, today);
          return since !== null && since < days;
        }).length;
        if (k >= min) continue;
        note(
          check.key,
          {
            target: j.id,
            entity_type: 'hire_job',
            label: cut(j.title),
            body: `${cut(j.title)} has had ${plural(k, 'new application', 'new applications')} in the last ${days} days.`,
            stage: bucket(n, days) as string,
          },
          `${cut(j.title)} — ${plural(k, 'new application', 'new applications')} in ${days} days`,
        );
      }
    } else if (check.key === 'job_closing_soon') {
      const last = addDays(today, days);
      const rows = openJobs
        .filter((j) => j.closesOn !== null && /^\d{4}-\d{2}-\d{2}$/.test(j.closesOn))
        .filter((j) => (j.closesOn as string) >= today && (j.closesOn as string) <= last)
        .sort((x, y) => (x.closesOn as string).localeCompare(y.closesOn as string));
      for (const j of rows) {
        const closes = j.closesOn as string;
        const count = active.filter((a) => a.jobId === j.id && a.stage !== 'hired').length;
        note(
          check.key,
          {
            target: j.id,
            entity_type: 'hire_job',
            label: cut(j.title),
            body: `${cut(j.title)} closes on ${formatDate(closes)} with ${plural(count, 'active application', 'active applications')}.`,
            stage: closes,
          },
          `${cut(j.title)} — closes ${formatDate(closes)}`,
        );
      }
    } else if (check.key === 'pool_idle') {
      const busy = new Set(active.map((a) => a.candidateId));
      const rows = raw.candidates
        .filter((c) => c.poolStatus !== 'none' && c.poolStatus in POOL_LABEL && !busy.has(c.id))
        .map((c) => ({ c, n: daysSince(c.createdAt, today) }))
        .filter((r): r is { c: HireAgentRaw['candidates'][number]; n: number } => r.n !== null && r.n >= days)
        .sort((x, y) => y.n - x.n);
      for (const { c, n } of rows) {
        const status = POOL_LABEL[c.poolStatus as InPool];
        note(
          check.key,
          {
            target: c.id,
            entity_type: 'hire_candidate',
            label: cut(c.name),
            body: `${cut(c.name)} has been on file ${n} days, is in the talent pool (${status}), and isn't in any current application.`,
            stage: bucket(n, days) as string,
          },
          `${cut(c.name)} — in the talent pool, idle ${n} days`,
        );
      }
    }
  }
  return out;
}
