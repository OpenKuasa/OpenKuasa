import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PEOPLE_NO_LONGER_APPLIES,
  peopleAgentNoteInput,
  peopleCreateAgentNote,
  type PeopleAgentNoteInput,
} from '@/lib/people/agent/actions';

const ORG = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const PROPOSAL = '55555555-5555-4555-8555-555555555555';
const NOTE = '66666666-6666-4666-8666-666666666666';
const EMP = 'e1111111-1111-4111-8111-111111111111';
const OTHER_EMP = 'e2222222-2222-4222-8222-222222222222';
const REC = 'a1111111-1111-4111-8111-111111111111';

// 12:00 on Fri 23 Oct 2026 in Kuala Lumpur.
const NOW = new Date('2026-10-23T04:00:00.000Z');

type Reply = { data: unknown; error: unknown };

/** A client whose reads answer per table, recording each read's filters; rpc is a spy. */
function fake(tables: Record<string, Reply>, rpcReply: Reply = { data: NOTE, error: null }) {
  const reads: { table: string; columns: string; filters: [string, unknown][]; orders: string[] }[] = [];
  const rpc = vi.fn(async () => rpcReply);
  const client = {
    rpc,
    from(table: string) {
      const read = { table, columns: '', filters: [] as [string, unknown][], orders: [] as string[] };
      reads.push(read);
      const reply = async () => tables[table] ?? { data: null, error: null };
      const chain: Record<string, unknown> = {
        select: (cols: string) => {
          read.columns = cols;
          return chain;
        },
        eq: (c: string, v: unknown) => {
          read.filters.push([c, v]);
          return chain;
        },
        order: (c: string) => {
          read.orders.push(c);
          return chain;
        },
        maybeSingle: reply,
        limit: reply,
        then: (res: (v: unknown) => unknown) => reply().then(res),
      };
      return chain;
    },
  };
  return { ctx: { client: client as never, orgId: ORG, userId: USER, proposalId: PROPOSAL }, rpc, reads };
}

const proposal = (check_key: string): Reply => ({ data: { check_key, created_at: '2026-10-23T00:00:00Z' }, error: null });
const activeEmployee: Reply = { data: { status: 'active' }, error: null };
const row = (data: Record<string, unknown>): Reply => ({ data: { employee_id: EMP, ...data }, error: null });

const note = (over: Partial<PeopleAgentNoteInput>): PeopleAgentNoteInput => ({
  entityType: 'hr_leave_request',
  entityId: REC,
  employeeId: EMP,
  entityLabel: 'Aisyah Rahman',
  body: "Aisyah Rahman's leave request for 02 Nov 2026 has waited 6 days for a decision. (as of 23 Oct 2026)",
  target: REC,
  stage: '6',
  ...over,
});
const leaveNote = note({});
const payrollNote = note({
  entityType: 'hr_payroll_month',
  entityId: null,
  employeeId: null,
  entityLabel: 'Payroll Oct 2026',
  body: "Payroll for October 2026 isn't marked paid yet. (as of 23 Oct 2026)",
  target: 'payroll:2026-10',
  stage: '2026-10',
});
const streakNote = note({ entityType: 'hr_employee', entityId: EMP, target: EMP, stage: '2026-10-16' });
const docNote = note({ entityType: 'hr_document', stage: 'soon:2026-11-04', days: 30 });

const stale = { ok: false, error: PEOPLE_NO_LONGER_APPLIES, stale: true };
const NOT_ADDED = { ok: false, error: 'That note could not be added.' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('peopleAgentNoteInput', () => {
  it('accepts a record note, an employee note and a payroll note', () => {
    expect(peopleAgentNoteInput.safeParse(leaveNote).success).toBe(true);
    expect(peopleAgentNoteInput.safeParse(streakNote).success).toBe(true);
    expect(peopleAgentNoteInput.safeParse(payrollNote).success).toBe(true);
    expect(peopleAgentNoteInput.safeParse(docNote).success).toBe(true);
  });

  it('refuses a note it could not leave', () => {
    const bad: unknown[] = [
      { ...leaveNote, target: 'other' },
      { ...leaveNote, entityId: null },
      { ...leaveNote, employeeId: null },
      { ...leaveNote, entityType: 'hr_payslip' },
      { ...leaveNote, body: 'x'.repeat(501) },
      { ...leaveNote, body: '   ' },
      { ...streakNote, employeeId: OTHER_EMP },
      { ...payrollNote, employeeId: EMP },
      { ...payrollNote, entityId: REC },
      { ...payrollNote, target: 'payroll:2026-10-01' },
      { ...payrollNote, target: REC },
      { ...docNote, days: 500 },
    ];
    for (const input of bad) expect(peopleAgentNoteInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });
});

describe('peopleCreateAgentNote', () => {
  it('adds the note through the RPC with the workspace and the claimed proposal id', async () => {
    const { ctx, rpc, reads } = fake({
      agent_proposals: proposal('leave_waiting'),
      hr_employees: activeEmployee,
      hr_leave_requests: row({ status: 'pending' }),
    });
    expect(await peopleCreateAgentNote(ctx, leaveNote)).toEqual({ ok: true, data: { id: NOTE } });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('hr_add_agent_note', { target_org: ORG, p_proposal: PROPOSAL });
    expect(reads.find((r) => r.table === 'hr_leave_requests')!.filters).toEqual([
      ['org_id', ORG],
      ['id', REC],
    ]);
    expect(reads.find((r) => r.table === 'hr_employees')!.filters).toEqual([
      ['org_id', ORG],
      ['id', EMP],
    ]);
  });

  // [check, input, table, a row that no longer matches, a row that still does]
  const cases: [string, PeopleAgentNoteInput, string, Record<string, unknown>, Record<string, unknown>][] = [
    ['document_expiring', docNote, 'hr_documents', { expires_on: '2027-10-01' }, { expires_on: '2026-11-04' }],
    ['document_expiring', docNote, 'hr_documents', { expires_on: null }, { expires_on: '2026-11-04' }],
    // Renewed, but still inside the check's N: a different expiry is still a different note.
    ['document_expiring', docNote, 'hr_documents', { expires_on: '2026-11-10' }, { expires_on: '2026-11-04' }],
    ['document_expiring', { ...docNote, stage: 'expired:2026-10-20' }, 'hr_documents', { expires_on: '2026-11-04' }, { expires_on: '2026-10-20' }],
    ['goal_overdue', note({ entityType: 'hr_goal', stage: '2026-10-14:8' }), 'hr_goals', { status: 'done' }, { status: 'at_risk' }],
    ['leave_waiting', leaveNote, 'hr_leave_requests', { status: 'approved' }, { status: 'pending' }],
    ['leave_starts_soon', note({ stage: '2026-10-25' }), 'hr_leave_requests', { status: 'rejected' }, { status: 'pending' }],
    ['claim_waiting', note({ entityType: 'hr_claim' }), 'hr_claims', { status: 'cancelled' }, { status: 'pending' }],
    ['overtime_waiting', note({ entityType: 'hr_overtime_record' }), 'hr_overtime_records', { status: 'approved' }, { status: 'pending' }],
    ['letter_draft_stale', note({ entityType: 'hr_letter' }), 'hr_letters', { status: 'issued' }, { status: 'draft' }],
  ];

  it.each(cases)('%s on %s.entityType re-reads its record and is stale once it no longer matches', async (check, input, table, gone, still) => {
    const staleRun = fake({ agent_proposals: proposal(check), hr_employees: activeEmployee, [table]: row(gone) });
    expect(await peopleCreateAgentNote(staleRun.ctx, input)).toEqual(stale);
    expect(staleRun.rpc).not.toHaveBeenCalled();
    const liveRun = fake({ agent_proposals: proposal(check), hr_employees: activeEmployee, [table]: row(still) });
    expect(await peopleCreateAgentNote(liveRun.ctx, input)).toEqual({ ok: true, data: { id: NOTE } });
  });

  it.each(cases)('%s: a record that is gone, or now belongs to someone else, no longer applies', async (check, input, table, _gone, still) => {
    const gone = fake({ agent_proposals: proposal(check), hr_employees: activeEmployee });
    expect(await peopleCreateAgentNote(gone.ctx, input)).toEqual(stale);
    const moved = fake({
      agent_proposals: proposal(check),
      hr_employees: activeEmployee,
      [table]: { data: { ...still, employee_id: OTHER_EMP }, error: null },
    });
    expect(await peopleCreateAgentNote(moved.ctx, input)).toEqual(stale);
    expect(gone.rpc).not.toHaveBeenCalled();
    expect(moved.rpc).not.toHaveBeenCalled();
  });

  it.each(cases)('%s: an inactive or deleted employee no longer applies', async (check, input, table, _gone, still) => {
    const inactive = fake({
      agent_proposals: proposal(check),
      hr_employees: { data: { status: 'inactive' }, error: null },
      [table]: row(still),
    });
    expect(await peopleCreateAgentNote(inactive.ctx, input)).toEqual(stale);
    const deleted = fake({ agent_proposals: proposal(check), [table]: row(still) });
    expect(await peopleCreateAgentNote(deleted.ctx, input)).toEqual(stale);
  });

  it('a soon-note approved after the document expired no longer applies (its text says "expires")', async () => {
    const input = { ...docNote, stage: 'soon:2026-10-20' };
    const { ctx, rpc } = fake({ agent_proposals: proposal('document_expiring'), hr_employees: activeEmployee, hr_documents: row({ expires_on: '2026-10-20' }) });
    expect(await peopleCreateAgentNote(ctx, input)).toEqual(stale);
    expect(rpc).not.toHaveBeenCalled();
    const today = fake({ agent_proposals: proposal('document_expiring'), hr_employees: activeEmployee, hr_documents: row({ expires_on: '2026-10-23' }) });
    expect((await peopleCreateAgentNote(today.ctx, { ...docNote, stage: 'soon:2026-10-23' })).ok).toBe(true);
  });

  it('approving a leave decided since the scan writes nothing and says it no longer applies', async () => {
    const { ctx, rpc } = fake({
      agent_proposals: proposal('leave_waiting'),
      hr_employees: activeEmployee,
      hr_leave_requests: row({ status: 'approved' }),
    });
    const out = await peopleCreateAgentNote(ctx, leaveNote);
    expect(out).toEqual(stale);
    expect(PEOPLE_NO_LONGER_APPLIES).toBe('This no longer applies.');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('absent_streak reads the employee latest attendance row: back at work is stale', async () => {
    const back = fake({
      agent_proposals: proposal('absent_streak'),
      hr_employees: activeEmployee,
      hr_attendance_days: { data: [{ work_date: '2026-10-22', status: 'present' }], error: null },
    });
    expect(await peopleCreateAgentNote(back.ctx, streakNote)).toEqual(stale);
    const read = back.reads.find((r) => r.table === 'hr_attendance_days')!;
    expect(read.filters).toEqual([
      ['org_id', ORG],
      ['employee_id', EMP],
    ]);
    expect(read.orders).toEqual(['work_date']);
    const onLeave = fake({
      agent_proposals: proposal('absent_streak'),
      hr_employees: activeEmployee,
      hr_attendance_days: { data: [{ work_date: '2026-10-22', status: 'on_leave' }], error: null },
    });
    expect(await peopleCreateAgentNote(onLeave.ctx, streakNote)).toEqual(stale);
    const none = fake({ agent_proposals: proposal('absent_streak'), hr_employees: activeEmployee, hr_attendance_days: { data: [], error: null } });
    expect(await peopleCreateAgentNote(none.ctx, streakNote)).toEqual(stale);
    const inactive = fake({
      agent_proposals: proposal('absent_streak'),
      hr_employees: { data: { status: 'inactive' }, error: null },
      hr_attendance_days: { data: [{ work_date: '2026-10-22', status: 'absent' }], error: null },
    });
    expect(await peopleCreateAgentNote(inactive.ctx, streakNote)).toEqual(stale);
    const still = fake({
      agent_proposals: proposal('absent_streak'),
      hr_employees: activeEmployee,
      hr_attendance_days: { data: [{ work_date: '2026-10-22', status: 'absent' }], error: null },
    });
    expect(await peopleCreateAgentNote(still.ctx, streakNote)).toEqual({ ok: true, data: { id: NOTE } });
  });

  it('payroll_unpaid is stale once the month is paid; a missing or draft run still applies', async () => {
    const paid = fake({ agent_proposals: proposal('payroll_unpaid'), hr_payroll_runs: { data: { status: 'paid' }, error: null } });
    expect(await peopleCreateAgentNote(paid.ctx, payrollNote)).toEqual(stale);
    expect(paid.reads.find((r) => r.table === 'hr_payroll_runs')!.filters).toEqual([
      ['org_id', ORG],
      ['period_month', '2026-10-01'],
    ]);
    expect(paid.reads.some((r) => r.table === 'hr_employees')).toBe(false);
    const draft = fake({ agent_proposals: proposal('payroll_unpaid'), hr_payroll_runs: { data: { status: 'draft' }, error: null } });
    expect((await peopleCreateAgentNote(draft.ctx, payrollNote)).ok).toBe(true);
    const missing = fake({ agent_proposals: proposal('payroll_unpaid') });
    expect((await peopleCreateAgentNote(missing.ctx, payrollNote)).ok).toBe(true);
    expect(missing.rpc).toHaveBeenCalledWith('hr_add_agent_note', { target_org: ORG, p_proposal: PROPOSAL });
  });

  it('a read error is a plain failure, not "no longer applies"', async () => {
    const recordError = fake({
      agent_proposals: proposal('leave_waiting'),
      hr_employees: activeEmployee,
      hr_leave_requests: { data: null, error: { code: '42501' } },
    });
    expect(await peopleCreateAgentNote(recordError.ctx, leaveNote)).toEqual(NOT_ADDED);
    const employeeError = fake({
      agent_proposals: proposal('leave_waiting'),
      hr_employees: { data: null, error: { code: '42501' } },
      hr_leave_requests: row({ status: 'pending' }),
    });
    expect(await peopleCreateAgentNote(employeeError.ctx, leaveNote)).toEqual(NOT_ADDED);
    expect(recordError.rpc).not.toHaveBeenCalled();
    expect(employeeError.rpc).not.toHaveBeenCalled();
  });

  it('refuses a check that does not fit the note, an unknown check, no proposal id, or an unreadable proposal', async () => {
    const mismatch = fake({ agent_proposals: proposal('claim_waiting'), hr_employees: activeEmployee, hr_claims: row({ status: 'pending' }) });
    expect(await peopleCreateAgentNote(mismatch.ctx, leaveNote)).toEqual(NOT_ADDED);
    const unknown = fake({ agent_proposals: proposal('approve_leave') });
    expect(await peopleCreateAgentNote(unknown.ctx, leaveNote)).toEqual(NOT_ADDED);
    const { ctx, rpc } = fake({});
    expect(await peopleCreateAgentNote({ ...ctx, proposalId: undefined }, leaveNote)).toEqual(NOT_ADDED);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await peopleCreateAgentNote(ctx, leaveNote)).toEqual(NOT_ADDED);
    log.mockRestore();
    expect(rpc).not.toHaveBeenCalled();
    expect(mismatch.rpc).not.toHaveBeenCalled();
    expect(unknown.rpc).not.toHaveBeenCalled();
  });

  it('returns a plain message and logs only the code when the RPC refuses', async () => {
    const { ctx } = fake(
      { agent_proposals: proposal('leave_waiting'), hr_employees: activeEmployee, hr_leave_requests: row({ status: 'pending' }) },
      { data: null, error: { code: 'P0001', message: 'HR_AGENT_NOTE_EXISTS Aisyah Rahman' } },
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await peopleCreateAgentNote(ctx, leaveNote)).toEqual(NOT_ADDED);
    expect(JSON.stringify(log.mock.calls)).not.toContain('Aisyah');
    log.mockRestore();
  });
});
