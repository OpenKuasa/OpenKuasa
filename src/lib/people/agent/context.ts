import type { SupabaseClient } from '@supabase/supabase-js';
import { describeCheck, validatePlan, type FocusPlan } from '@/lib/agents/focus/plan';
import { PEOPLE_FOCUS } from '@/lib/agents/types';
import { PEOPLE_FOCUS_MENU } from '@/lib/people/agent/checks';
import { scanPeople } from '@/lib/people/agent/scan';
import { addDays, todayInMalaysia } from '@/lib/people/dates';

/**
 * Everything Lekiu's scan needs, read once per run with the service client: a reduced projection
 * of the HR tables (spec §5). Names and goal titles are plain data for the notes HR reads; they
 * never reach the model (the scan's titles and the context string carry none).
 */
export type PeopleAgentRaw = {
  /** Null unless HR confirmed a focus (`focus_confirmed_at` is set). */
  plan: FocusPlan | null;
  /** Every employee, active or not; the scan skips anyone inactive. */
  employees: { id: string; name: string; active: boolean }[];
  /** Documents with an expiry date. */
  documents: { id: string; employeeId: string; docType: string; expiresOn: string | null }[];
  /** Goals not marked done. */
  goals: { id: string; employeeId: string; title: string; progress: number; dueDate: string | null }[];
  /** Leave requests waiting for a decision. */
  leaves: { id: string; employeeId: string; createdAt: string; startDate: string; endDate: string }[];
  /** Claims waiting for a decision. */
  claims: { id: string; employeeId: string; createdAt: string; claimDate: string }[];
  /** Overtime waiting for a decision. */
  overtime: { id: string; employeeId: string; createdAt: string; workDate: string }[];
  /** Draft letters. */
  letters: { id: string; employeeId: string; createdAt: string }[];
  /** Recent attendance days (a few more than the scan's 14-day window). */
  attendance: { employeeId: string; workDate: string; status: string }[];
  /** Every payroll month's status. */
  payrollRuns: { periodMonth: string; status: string }[];
};

/** PostgREST returns at most this many rows per request. */
const PAGE = 1000;
/** Attendance read back this many days; the pure scan applies its strict 14-day window. */
const ATTENDANCE_READ_DAYS = 20;

type Rows = { data: unknown[] | null; error: unknown };

/** Throws on any read error, so a run never works from a partial snapshot. */
function rowsOf(result: Rows): Record<string, unknown>[] {
  if (result.error) throw result.error;
  return (result.data ?? []) as Record<string, unknown>[];
}

/** Reads every page of a query, so the 1000-row response cap cannot hide rows. */
async function readAll(page: (from: number, to: number) => PromiseLike<Rows>): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const rows = rowsOf(await page(from, from + PAGE - 1));
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const day = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, 10) : null);
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Service-role read of the workspace for Lekiu's agent. Reads ONLY the columns `service_role`
 * was granted for it (20261125200200_people_agent_service_reads.sql), in selects, filters and
 * ordering alike; add a grant before adding a column here. `service` MUST be the service-role
 * client.
 */
export async function buildPeopleAgentContext(
  service: SupabaseClient,
  orgId: string,
): Promise<{ context: string; raw: PeopleAgentRaw }> {
  const config = await service
    .from('agent_configs')
    .select('focus_plan,focus_confirmed_at')
    .eq('org_id', orgId)
    .eq('agent_key', PEOPLE_FOCUS)
    .maybeSingle();
  if (config.error) throw config.error;
  const row = config.data as { focus_plan: unknown; focus_confirmed_at: string | null } | null;
  // Re-validated on every read: the stored plan is never trusted as-is.
  const plan = row?.focus_confirmed_at ? validatePlan(PEOPLE_FOCUS_MENU, row.focus_plan).plan : null;

  const now = new Date();
  const since = addDays(todayInMalaysia(now), -ATTENDANCE_READ_DAYS);

  const [employeeRows, documentRows, goalRows, leaveRows, claimRows, overtimeRows, letterRows, attendanceRows, payrollRows] =
    await Promise.all([
      readAll((from, to) =>
        service.from('hr_employees').select('id,name,status').eq('org_id', orgId).order('id', { ascending: true }).range(from, to),
      ),
      readAll((from, to) =>
        service
          .from('hr_documents')
          .select('id,employee_id,doc_type,expires_on')
          .eq('org_id', orgId)
          .not('expires_on', 'is', null)
          .order('expires_on', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
      readAll((from, to) =>
        service
          .from('hr_goals')
          .select('id,employee_id,title,progress,due_date')
          .eq('org_id', orgId)
          .in('status', ['on_track', 'at_risk'])
          .order('id', { ascending: true })
          .range(from, to),
      ),
      readAll((from, to) =>
        service
          .from('hr_leave_requests')
          .select('id,employee_id,created_at,start_date,end_date')
          .eq('org_id', orgId)
          .eq('status', 'pending')
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
      readAll((from, to) =>
        service
          .from('hr_claims')
          .select('id,employee_id,created_at,claim_date')
          .eq('org_id', orgId)
          .eq('status', 'pending')
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
      readAll((from, to) =>
        service
          .from('hr_overtime_records')
          .select('id,employee_id,created_at,work_date')
          .eq('org_id', orgId)
          .eq('status', 'pending')
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
      readAll((from, to) =>
        service
          .from('hr_letters')
          .select('id,employee_id,created_at')
          .eq('org_id', orgId)
          .eq('status', 'draft')
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
      readAll((from, to) =>
        service
          .from('hr_attendance_days')
          .select('employee_id,work_date,status')
          .eq('org_id', orgId)
          .gte('work_date', since)
          // No id column is granted here: (employee_id, work_date) is unique.
          .order('employee_id', { ascending: true })
          .order('work_date', { ascending: true })
          .range(from, to),
      ),
      readAll((from, to) =>
        service
          .from('hr_payroll_runs')
          .select('period_month,status')
          .eq('org_id', orgId)
          .order('period_month', { ascending: true })
          .range(from, to),
      ),
    ]);

  const raw: PeopleAgentRaw = {
    plan,
    employees: employeeRows.map((r) => ({ id: String(r.id), name: str(r.name) || 'An employee', active: r.status === 'active' })),
    documents: documentRows.map((r) => ({
      id: String(r.id),
      employeeId: String(r.employee_id),
      docType: str(r.doc_type),
      expiresOn: day(r.expires_on),
    })),
    goals: goalRows.map((r) => ({
      id: String(r.id),
      employeeId: String(r.employee_id),
      title: str(r.title) || 'Untitled goal',
      progress: num(r.progress),
      dueDate: day(r.due_date),
    })),
    leaves: leaveRows.map((r) => ({
      id: String(r.id),
      employeeId: String(r.employee_id),
      createdAt: String(r.created_at),
      startDate: day(r.start_date) ?? '',
      endDate: day(r.end_date) ?? '',
    })),
    claims: claimRows.map((r) => ({
      id: String(r.id),
      employeeId: String(r.employee_id),
      createdAt: String(r.created_at),
      claimDate: day(r.claim_date) ?? '',
    })),
    overtime: overtimeRows.map((r) => ({
      id: String(r.id),
      employeeId: String(r.employee_id),
      createdAt: String(r.created_at),
      workDate: day(r.work_date) ?? '',
    })),
    letters: letterRows.map((r) => ({ id: String(r.id), employeeId: String(r.employee_id), createdAt: String(r.created_at) })),
    attendance: attendanceRows.map((r) => ({
      employeeId: String(r.employee_id),
      workDate: day(r.work_date) ?? '',
      status: str(r.status),
    })),
    payrollRuns: payrollRows.map((r) => ({ periodMonth: day(r.period_month) ?? '', status: str(r.status) })),
  };

  // Counts and the read-back only: no names, no titles, no ids, never the focus text.
  let context = `Active employees: ${raw.employees.filter((e) => e.active).length}.`;
  if (plan) {
    const found = new Map<string, number>();
    for (const c of scanPeople(raw, now)) found.set(c.checkKey as string, (found.get(c.checkKey as string) ?? 0) + 1);
    const lines = plan.checks.flatMap((c) => {
      const line = describeCheck(PEOPLE_FOCUS_MENU, c.key, c.params);
      return line === null ? [] : [`- ${line} (${found.get(c.key) ?? 0} found)`];
    });
    context += `\nWhat HR asked to watch:\n${lines.join('\n')}`;
  }
  return { context, raw };
}
