import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HIRE_NO_LONGER_APPLIES,
  hireAgentNoteInput,
  hireCreateAgentNote,
  type HireAgentNoteInput,
} from '@/lib/hire/agent/actions';

const ORG = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const PROPOSAL = '55555555-5555-4555-8555-555555555555';
const A = '11111111-1111-4111-8111-111111111111';
const NOTE = '66666666-6666-4666-8666-666666666666';
const APP = '77777777-7777-4777-8777-777777777777';

type Reply = { data: unknown; error: unknown };

// 12:00 on Fri 23 Oct 2026 in Kuala Lumpur: "today" for the approval checks.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T04:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

/** A client whose reads answer per table (single row or rows), and whose rpc is a spy. */
function fake(tables: Record<string, Reply>, rpcReply: Reply = { data: NOTE, error: null }) {
  const reads: { table: string; filters: [string, unknown][] }[] = [];
  const rpc = vi.fn(async () => rpcReply);
  const client = {
    rpc,
    from(table: string) {
      const read = { table, filters: [] as [string, unknown][] };
      reads.push(read);
      const reply = async () => tables[table] ?? { data: null, error: null };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => {
          read.filters.push([c, v]);
          return chain;
        },
        gte: (c: string, v: unknown) => {
          read.filters.push([c, v]);
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

const PROPOSED_AT = '2026-10-23T04:00:00.000Z';
const proposal = (check_key: string): Reply => ({ data: { check_key, created_at: PROPOSED_AT }, error: null });
const row = (data: unknown): Reply => ({ data, error: null });

const appNote: HireAgentNoteInput = {
  target: A,
  entity_type: 'hire_application',
  label: 'Aisyah · Events Executive',
  body: 'Aisyah applied for Events Executive 5 days ago and is still at Applied. (as of 23 Oct 2026)',
  stage: '1',
};
const as = (entity_type: HireAgentNoteInput['entity_type'], stage = '1'): HireAgentNoteInput => ({ ...appNote, entity_type, stage });
const stale = { ok: false, error: HIRE_NO_LONGER_APPLIES, stale: true };

describe('hireAgentNoteInput', () => {
  it('accepts a note on each kind of record', () => {
    for (const t of ['hire_application', 'hire_interview', 'hire_job', 'hire_candidate'] as const) {
      expect(hireAgentNoteInput.safeParse(as(t)).success).toBe(true);
    }
  });

  it('refuses a non-uuid target, unknown types, long or blank bodies, long labels and long stages', () => {
    expect(hireAgentNoteInput.safeParse({ ...appNote, target: 'sst:2026-09-01' }).success).toBe(false);
    expect(hireAgentNoteInput.safeParse({ ...appNote, entity_type: 'hire_offer' }).success).toBe(false);
    expect(hireAgentNoteInput.safeParse({ ...appNote, body: 'x'.repeat(501) }).success).toBe(false);
    expect(hireAgentNoteInput.safeParse({ ...appNote, body: '   ' }).success).toBe(false);
    expect(hireAgentNoteInput.safeParse({ ...appNote, label: 'x'.repeat(201) }).success).toBe(false);
    expect(hireAgentNoteInput.safeParse({ ...appNote, stage: 'x'.repeat(65) }).success).toBe(false);
  });

  it('allows the optional window and minimum of job_few_applicants, as whole numbers in range', () => {
    expect(hireAgentNoteInput.parse({ ...appNote, window_days: 14, min_count: 2 })).toMatchObject({ window_days: 14, min_count: 2 });
    expect(hireAgentNoteInput.safeParse({ ...appNote, window_days: 0, min_count: 2 }).success).toBe(false);
    expect(hireAgentNoteInput.safeParse({ ...appNote, window_days: 14, min_count: 1.5 }).success).toBe(false);
    expect(hireAgentNoteInput.safeParse({ ...appNote, window_days: 14, min_count: 51 }).success).toBe(false);
  });
});

describe('hireCreateAgentNote', () => {
  it('adds the note through the RPC with the workspace and the claimed proposal when the target still matches', async () => {
    const { ctx, rpc, reads } = fake({
      agent_proposals: proposal('application_unscreened'),
      hire_applications: row({ stage: 'applied', outcome: 'active', offered_at: null }),
    });
    expect(await hireCreateAgentNote(ctx, appNote)).toEqual({ ok: true, data: { id: NOTE } });
    expect(rpc).toHaveBeenCalledWith('hire_add_agent_note', { target_org: ORG, proposal_id: PROPOSAL });
    expect(reads.find((r) => r.table === 'hire_applications')!.filters).toEqual([
      ['org_id', ORG],
      ['id', A],
    ]);
  });

  it('an application whose stage moved on no longer applies, and writes nothing', async () => {
    const { ctx, rpc } = fake({
      agent_proposals: proposal('application_unscreened'),
      hire_applications: row({ stage: 'screening', outcome: 'active', offered_at: null }),
    });
    expect(await hireCreateAgentNote(ctx, appNote)).toEqual(stale);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([['rejected'], ['withdrawn']])('a %s application no longer applies, for every application check', async (outcome) => {
    for (const [check, stage] of [
      ['application_unscreened', 'applied'],
      ['screening_no_interview', 'screening'],
      ['application_quiet', 'interview'],
      ['offer_waiting', 'offer'],
    ]) {
      const { ctx, rpc } = fake({
        agent_proposals: proposal(check),
        hire_applications: row({ stage, outcome, offered_at: null }),
      });
      expect(await hireCreateAgentNote(ctx, appNote)).toEqual(stale);
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it('an application that is gone no longer applies', async () => {
    const { ctx, rpc } = fake({ agent_proposals: proposal('offer_waiting') });
    expect(await hireCreateAgentNote(ctx, appNote)).toEqual(stale);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('screening_no_interview no longer applies once an interview is booked', async () => {
    const booked = fake({
      agent_proposals: proposal('screening_no_interview'),
      hire_applications: row({ stage: 'screening', outcome: 'active', offered_at: null }),
      hire_interviews: row([{ id: 'i1' }]),
    });
    expect(await hireCreateAgentNote(booked.ctx, appNote)).toEqual(stale);
    expect(booked.reads.find((r) => r.table === 'hire_interviews')!.filters).toContainEqual(['application_id', A]);
    const none = fake({
      agent_proposals: proposal('screening_no_interview'),
      hire_applications: row({ stage: 'screening', outcome: 'active', offered_at: null }),
      hire_interviews: row([]),
    });
    expect((await hireCreateAgentNote(none.ctx, appNote)).ok).toBe(true);
  });

  it('application_quiet no longer applies after any interview activity or an offer since the suggestion', async () => {
    const live = { stage: 'interview', outcome: 'active', offered_at: null };
    const updated = fake({
      agent_proposals: proposal('application_quiet'),
      hire_applications: row(live),
      hire_interviews: row([{ created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-23T05:00:00Z', feedback_at: null }]),
    });
    expect(await hireCreateAgentNote(updated.ctx, appNote)).toEqual(stale);
    const offered = fake({
      agent_proposals: proposal('application_quiet'),
      hire_applications: row({ ...live, stage: 'offer', offered_at: '2026-10-23T06:00:00Z' }),
      hire_interviews: row([]),
    });
    expect(await hireCreateAgentNote(offered.ctx, appNote)).toEqual(stale);
    const quiet = fake({
      agent_proposals: proposal('application_quiet'),
      hire_applications: row(live),
      hire_interviews: row([{ created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', feedback_at: null }]),
    });
    expect((await hireCreateAgentNote(quiet.ctx, appNote)).ok).toBe(true);
  });

  it('feedback_missing no longer applies once the interview has feedback', async () => {
    const input = as('hire_interview', 'once');
    const given = fake({
      agent_proposals: proposal('feedback_missing'),
      hire_interviews: row({ status: 'completed', updated_at: '2026-10-23T05:00:00Z', feedback_at: '2026-10-23T05:00:00Z' }),
    });
    expect(await hireCreateAgentNote(given.ctx, input)).toEqual(stale);
    const missing = fake({
      agent_proposals: proposal('feedback_missing'),
      hire_interviews: row({ status: 'completed', application_id: APP, updated_at: '2026-10-20T05:00:00Z', feedback_at: null }),
      hire_applications: row({ outcome: 'active' }),
    });
    expect((await hireCreateAgentNote(missing.ctx, input)).ok).toBe(true);
  });

  it('interview_not_updated no longer applies once it is completed, cancelled or edited since', async () => {
    const input = as('hire_interview', 'once');
    for (const data of [
      { status: 'completed', updated_at: '2026-10-23T05:00:00Z', feedback_at: null },
      { status: 'cancelled', updated_at: '2026-10-01T00:00:00Z', feedback_at: null },
      { status: 'scheduled', updated_at: '2026-10-23T05:00:00Z', feedback_at: null },
    ]) {
      const { ctx } = fake({ agent_proposals: proposal('interview_not_updated'), hire_interviews: row(data) });
      expect(await hireCreateAgentNote(ctx, input)).toEqual(stale);
    }
    const untouched = fake({
      agent_proposals: proposal('interview_not_updated'),
      hire_interviews: row({ status: 'scheduled', application_id: APP, updated_at: '2026-10-01T00:00:00Z', feedback_at: null }),
      hire_applications: row({ outcome: 'active' }),
    });
    expect((await hireCreateAgentNote(untouched.ctx, input)).ok).toBe(true);
    expect(untouched.reads.find((r) => r.table === 'hire_applications')!.filters).toEqual([
      ['org_id', ORG],
      ['id', APP],
    ]);
  });

  it.each([['interview_not_updated', 'scheduled'], ['feedback_missing', 'completed']])(
    '%s no longer applies once its application is withdrawn, rejected or gone',
    async (check, status) => {
      const input = as('hire_interview', 'once');
      const interview = row({ status, application_id: APP, updated_at: '2026-10-01T00:00:00Z', feedback_at: null });
      for (const application of [row({ outcome: 'withdrawn' }), row({ outcome: 'rejected' }), row(null)]) {
        const { ctx, rpc } = fake({ agent_proposals: proposal(check), hire_interviews: interview, hire_applications: application });
        expect(await hireCreateAgentNote(ctx, input)).toEqual(stale);
        expect(rpc).not.toHaveBeenCalled();
      }
    },
  );

  it('job_few_applicants recounts applications in the window and no longer applies once it reached the minimum', async () => {
    const input = { ...as('hire_job', '14'), window_days: 14, min_count: 2 };
    const job = row({ status: 'open', closes_on: null, headcount: 1 });
    const enough = fake({ agent_proposals: proposal('job_few_applicants'), hire_jobs: job, hire_applications: row([{ id: 'a' }, { id: 'b' }]) });
    expect(await hireCreateAgentNote(enough.ctx, input)).toEqual(stale);
    expect(enough.rpc).not.toHaveBeenCalled();
    const filters = enough.reads.find((r) => r.table === 'hire_applications')!.filters;
    expect(filters.slice(0, 2)).toEqual([
      ['org_id', ORG],
      ['job_id', A],
    ]);
    const since = filters.find((f) => f[0] === 'applied_at')![1] as string;
    // The window starts at Malaysian midnight, 13 days before today (14 days counting today).
    const expected = new Date(Date.now() + 8 * 3_600_000);
    expected.setUTCDate(expected.getUTCDate() - 13);
    expect(since).toBe(`${expected.toISOString().slice(0, 10)}T00:00:00+08:00`);
    const few = fake({ agent_proposals: proposal('job_few_applicants'), hire_jobs: job, hire_applications: row([{ id: 'a' }]) });
    expect((await hireCreateAgentNote(few.ctx, input)).ok).toBe(true);
  });

  it.each([['job_open_long'], ['job_few_applicants'], ['job_closing_soon']])('%s no longer applies once the job is closed', async (check) => {
    const input = as('hire_job', check === 'job_closing_soon' ? '2026-10-30' : '1');
    const closed = fake({ agent_proposals: proposal(check), hire_jobs: row({ status: 'closed', closes_on: '2026-10-30', headcount: 1 }) });
    expect(await hireCreateAgentNote(closed.ctx, input)).toEqual(stale);
    expect(closed.rpc).not.toHaveBeenCalled();
    const open = fake({
      agent_proposals: proposal(check),
      hire_jobs: row({ status: 'open', closes_on: '2026-10-30', headcount: 1 }),
      hire_applications: row([]),
    });
    expect((await hireCreateAgentNote(open.ctx, input)).ok).toBe(true);
  });

  it('job_open_long no longer applies once filled (null headcount = 1)', async () => {
    const input = as('hire_job');
    const filled = fake({
      agent_proposals: proposal('job_open_long'),
      hire_jobs: row({ status: 'open', closes_on: null, headcount: null }),
      hire_applications: row([{ id: 'h1' }]),
    });
    expect(await hireCreateAgentNote(filled.ctx, input)).toEqual(stale);
    expect(filled.reads.find((r) => r.table === 'hire_applications')!.filters).toEqual([
      ['org_id', ORG],
      ['job_id', A],
      ['stage', 'hired'],
      ['outcome', 'active'],
    ]);
  });

  it('job_closing_soon no longer applies once the closing date changed', async () => {
    const { ctx } = fake({
      agent_proposals: proposal('job_closing_soon'),
      hire_jobs: row({ status: 'open', closes_on: '2026-11-30', headcount: 1 }),
    });
    expect(await hireCreateAgentNote(ctx, as('hire_job', '2026-10-30'))).toEqual(stale);
  });

  it('job_closing_soon no longer applies once its closing date has passed in Malaysia', async () => {
    const past = fake({
      agent_proposals: proposal('job_closing_soon'),
      hire_jobs: row({ status: 'open', closes_on: '2026-10-22', headcount: 1 }),
    });
    expect(await hireCreateAgentNote(past.ctx, as('hire_job', '2026-10-22'))).toEqual(stale);
    expect(past.rpc).not.toHaveBeenCalled();
    const today = fake({
      agent_proposals: proposal('job_closing_soon'),
      hire_jobs: row({ status: 'open', closes_on: '2026-10-23', headcount: 1 }),
    });
    expect((await hireCreateAgentNote(today.ctx, as('hire_job', '2026-10-23'))).ok).toBe(true);
  });

  it("pool_idle no longer applies once the candidate is out of the pool or in a current application", async () => {
    const input = as('hire_candidate');
    const out = fake({ agent_proposals: proposal('pool_idle'), hire_candidates: row({ pool_status: 'none' }) });
    expect(await hireCreateAgentNote(out.ctx, input)).toEqual(stale);
    expect(out.rpc).not.toHaveBeenCalled();
    const gone = fake({ agent_proposals: proposal('pool_idle') });
    expect(await hireCreateAgentNote(gone.ctx, input)).toEqual(stale);
    const busy = fake({
      agent_proposals: proposal('pool_idle'),
      hire_candidates: row({ pool_status: 'available' }),
      hire_applications: row([{ id: 'a1' }]),
    });
    expect(await hireCreateAgentNote(busy.ctx, input)).toEqual(stale);
    expect(busy.reads.find((r) => r.table === 'hire_applications')!.filters).toEqual([
      ['org_id', ORG],
      ['candidate_id', A],
      ['outcome', 'active'],
    ]);
    const idle = fake({
      agent_proposals: proposal('pool_idle'),
      hire_candidates: row({ pool_status: 'passive' }),
      hire_applications: row([]),
    });
    expect((await hireCreateAgentNote(idle.ctx, input)).ok).toBe(true);
  });

  it('a note on the wrong kind of record for its check is refused, not written', async () => {
    const { ctx, rpc } = fake({
      agent_proposals: proposal('pool_idle'),
      hire_candidates: row({ pool_status: 'available' }),
      hire_applications: row([]),
    });
    expect(await hireCreateAgentNote(ctx, appNote)).toEqual({ ok: false, error: 'That note could not be added.' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a read error is a plain failure, not "no longer applies"', async () => {
    const { ctx, rpc } = fake({
      agent_proposals: proposal('application_unscreened'),
      hire_applications: { data: null, error: { code: '42501' } },
    });
    expect(await hireCreateAgentNote(ctx, appNote)).toEqual({ ok: false, error: 'That note could not be added.' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses without a proposal id, or when the proposal cannot be read', async () => {
    const { ctx, rpc } = fake({});
    expect(await hireCreateAgentNote({ ...ctx, proposalId: undefined }, appNote)).toEqual({
      ok: false,
      error: 'That note could not be added.',
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await hireCreateAgentNote(ctx, appNote)).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('returns a plain message and logs only the code when the RPC refuses', async () => {
    const { ctx } = fake(
      {
        agent_proposals: proposal('application_unscreened'),
        hire_applications: row({ stage: 'applied', outcome: 'active', offered_at: null }),
      },
      { data: null, error: { code: 'HIR02', message: 'secret detail' } },
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await hireCreateAgentNote(ctx, appNote)).toEqual({ ok: false, error: 'That note could not be added.' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret detail');
    log.mockRestore();
  });
});
