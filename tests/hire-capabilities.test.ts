// tests/hire-capabilities.test.ts
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  JOB_HAS_APPLICATIONS,
  JOB_LIVE_NEEDS_DESCRIPTION,
  JOB_NEEDS_DESCRIPTION,
  JOB_NOT_FOUND,
  CAREERS_DEMO,
  updateCareersPage,
  updateCareersPageInput,
  updateApplicationForm,
  updateApplicationFormInput,
  createJob,
  createJobInput,
  deleteJob,
  deleteJobInput,
  setJobStatus,
  setJobStatusInput,
  updateJob,
  updateJobInput,
  moveApplication,
  moveApplicationInput,
  closeApplication,
  closeApplicationInput,
  reopenApplication,
  reopenApplicationInput,
  rateApplication,
  rateApplicationInput,
  addCandidate,
  addCandidateInput,
  updateCandidate,
  updateCandidateInput,
  attachCandidateCv,
  deleteApplication, deleteApplicationInput, deleteCandidate, deleteCandidateInput, deletionSummary, deletionSummaryInput,
  setPoolStatus, setPoolStatusInput, moveToPipeline, moveToPipelineInput,
  NOT_AN_INTERVIEW_ID, scheduleInterview, scheduleInterviewInput, recordPastInterview, recordPastInterviewInput,
  rescheduleInterview, rescheduleInterviewInput, cancelInterview, cancelInterviewInput, setInterviewOutcome,
  setInterviewOutcomeInput, reopenInterview, reopenInterviewInput,
  type HireWriteContext,
} from '@/lib/hire/capabilities';
import type { Job } from '@/lib/hire/types';

const NOW = new Date('2026-10-11T04:00:00Z'); // 12:00 on 11 Oct in Kuala Lumpur
const ORG = '11111111-1111-4111-8111-111111111111';
/** The application form switches as a workspace has them until it changes one. */
const FORM_OFF = { require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false };
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';

const job = (over: Partial<Job & { org_id: string }> = {}): Job & { org_id: string } => ({
  id: ID, org_id: ORG, title: 'Barista', department: null, location: null,
  employment_type: 'full_time', status: 'draft', description: null,
  salary_min_cents: null, salary_max_cents: null, show_salary: false, closes_on: null,
  work_arrangement: null, headcount: 1, opened_at: null, closed_at: null,
  created_at: '2026-10-01T00:00:00Z', ...over,
});

/** An in-memory stand-in for the two tables the capabilities touch. */
function fake(rows: (Job & { org_id: string })[], applications: Record<string, number> = {}, failLookup = false) {
  const writes: { op: string; values?: Record<string, unknown> }[] = [];
  const strip = (row: Job & { org_id: string }) => {
    const copy: Record<string, unknown> = { ...row };
    delete copy.org_id;
    return copy as unknown as Job;
  };
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const match = () => rows.filter((r) => Object.entries(filters).every(([k, v]) => (r as Record<string, unknown>)[k] === v));
      if (table === 'hire_applications') {
        const chain = {
          select: () => chain,
          eq: (k: string, v: unknown) => { filters[k] = v; return chain; },
          then: (resolve: (v: unknown) => void) =>
            resolve({ count: applications[String(filters.job_id)] ?? 0, error: null }),
        };
        return chain;
      }
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let values: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        insert: (v: Record<string, unknown>) => { op = 'insert'; values = v; return chain; },
        update: (v: Record<string, unknown>) => { op = 'update'; values = v; return chain; },
        delete: () => { op = 'delete'; return chain; },
        eq: (k: string, v: unknown) => { filters[k] = v; return chain; },
        maybeSingle: async () => failLookup ? { data: null, error: { message: 'boom' } } : ({ data: match()[0] ? strip(match()[0]) : null, error: null }),
        single: async () => {
          if (op === 'insert') {
            const row = { ...job(), ...values, id: ID } as Job & { org_id: string };
            rows.push(row);
            writes.push({ op, values });
            return { data: strip(row), error: null };
          }
          const target = match()[0];
          if (!target) return { data: null, error: { message: 'no rows' } };
          Object.assign(target, values);
          writes.push({ op, values });
          return { data: strip(target), error: null };
        },
        then: (resolve: (v: unknown) => void) => {
          if (op === 'delete') {
            const target = match()[0];
            if (target) rows.splice(rows.indexOf(target), 1);
            writes.push({ op });
          }
          resolve({ error: null });
        },
      };
      return chain;
    },
  };
  const ctx = { client: client as never, orgId: ORG } satisfies HireWriteContext;
  return { ctx, rows, writes };
}

describe('createJob', () => {
  it('creates a draft in the caller\'s workspace, whatever the input says', async () => {
    const { ctx, writes } = fake([]);
    const result = await createJob(ctx, { title: '  Barista  ', org_id: OTHER_ORG, status: 'open' } as never, NOW);
    expect(result).toMatchObject({ ok: true, data: { title: 'Barista', status: 'draft', headcount: 1, show_salary: false } });
    expect(writes[0].values).toMatchObject({ org_id: ORG, status: 'draft', title: 'Barista' });
  });
  it('refuses an empty title, a long title and a headcount of zero', async () => {
    const { ctx, writes } = fake([]);
    for (const input of [{ title: ' ' }, { title: 'x'.repeat(121) }, { title: 'Barista', headcount: 0 }]) {
      expect((await createJob(ctx, input, NOW)).ok).toBe(false);
    }
    expect(writes).toHaveLength(0);
  });
  it('refuses a maximum salary below the minimum', async () => {
    const { ctx } = fake([]);
    const result = await createJob(ctx, { title: 'Barista', salary_min_cents: 300_000, salary_max_cents: 250_000 }, NOW);
    expect(result).toEqual({ ok: false, error: 'Maximum salary can\'t be lower than the minimum.' });
  });
  it('refuses a closing date in the past, by the date in Kuala Lumpur', async () => {
    const { ctx } = fake([]);
    expect((await createJob(ctx, { title: 'Barista', closes_on: '2026-10-10' }, NOW)).ok).toBe(false);
    expect((await createJob(ctx, { title: 'Barista', closes_on: '2026-10-11' }, NOW)).ok).toBe(true);
  });
  it('refuses a date that does not exist, and says so rather than failing at the database', async () => {
    const { ctx, writes } = fake([]);
    const realDate = { ok: false, error: 'Use a real date, like 2026-10-31.' };
    expect(await createJob(ctx, { title: 'Barista', closes_on: '2026-02-31' }, NOW)).toEqual(realDate);
    expect(await createJob(ctx, { title: 'Barista', closes_on: '2027-02-30' }, NOW)).toEqual(realDate);
    expect(await createJob(ctx, { title: 'Barista', closes_on: '2026-13-01' }, NOW)).toEqual(realDate);
    expect(writes).toHaveLength(0);
    expect(await createJob(ctx, { title: 'Barista', closes_on: '2026-10-31' }, NOW)).toMatchObject({ ok: true, data: { closes_on: '2026-10-31' } });
    expect(await createJob(ctx, { title: 'Barista', closes_on: '2028-02-29' }, NOW)).toMatchObject({ ok: true });
  });
  it('uses the Kuala Lumpur date when it is already the next day in UTC', async () => {
    const lateUtc = new Date('2026-10-10T17:00:00Z'); // 01:00 on 11 Oct in Kuala Lumpur
    const { ctx } = fake([]);
    expect((await createJob(ctx, { title: 'Barista', closes_on: '2026-10-10' }, lateUtc)).ok).toBe(false);
    expect((await createJob(ctx, { title: 'Barista', closes_on: '2026-10-11' }, lateUtc)).ok).toBe(true);
  });
});

describe('updateJob', () => {
  it('changes only the fields given and never the status', async () => {
    const { ctx, rows } = fake([job({ status: 'open', description: 'Make coffee.' })]);
    const result = await updateJob(ctx, { id: ID, location: 'Shah Alam', status: 'closed' } as never, NOW);
    expect(result).toMatchObject({ ok: true, data: { location: 'Shah Alam', status: 'open' } });
    expect(rows[0].title).toBe('Barista');
  });
  it('checks a new minimum against the stored maximum', async () => {
    const { ctx, writes } = fake([job({ salary_min_cents: 200_000, salary_max_cents: 300_000 })]);
    const result = await updateJob(ctx, { id: ID, salary_min_cents: 350_000 }, NOW);
    expect(result).toEqual({ ok: false, error: 'Maximum salary can\'t be lower than the minimum.' });
    expect(writes).toHaveLength(0);
    const lowered = await updateJob(ctx, { id: ID, salary_max_cents: 150_000 }, NOW);
    expect(lowered).toEqual({ ok: false, error: 'Maximum salary can\'t be lower than the minimum.' });
    expect(writes).toHaveLength(0);
  });
  it('will not clear the description of an open or paused job, but will for a draft or closed one', async () => {
    for (const status of ['open', 'paused'] as const) {
      const { ctx } = fake([job({ status, description: 'Make coffee.' })]);
      expect(await updateJob(ctx, { id: ID, description: '   ' }, NOW)).toEqual({ ok: false, error: JOB_LIVE_NEEDS_DESCRIPTION });
    }
    for (const status of ['draft', 'closed'] as const) {
      const { ctx } = fake([job({ status, description: 'Make coffee.' })]);
      expect(await updateJob(ctx, { id: ID, description: '' }, NOW)).toMatchObject({ ok: true, data: { description: null } });
    }
  });
  it('lets an open job with no stored description be edited without touching the description', async () => {
    const { ctx } = fake([job({ status: 'open', description: null })]);
    expect(await updateJob(ctx, { id: ID, location: 'Shah Alam' }, NOW)).toMatchObject({ ok: true, data: { location: 'Shah Alam' } });
  });
  it('checks the closing date only when it changes', async () => {
    const { ctx } = fake([job({ closes_on: '2026-10-01' })]);
    expect(await updateJob(ctx, { id: ID, closes_on: '2026-10-01', title: 'New title' }, NOW)).toMatchObject({ ok: true, data: { title: 'New title' } });
    expect((await updateJob(ctx, { id: ID, closes_on: '2026-10-05' }, NOW)).ok).toBe(false);
  });
  it('refuses changing the closing date to one that does not exist', async () => {
    const { ctx, writes } = fake([job({ closes_on: '2026-10-31' })]);
    expect(await updateJob(ctx, { id: ID, closes_on: '2026-11-31' }, NOW)).toEqual({ ok: false, error: 'Use a real date, like 2026-10-31.' });
    expect(writes).toHaveLength(0);
    expect(await updateJob(ctx, { id: ID, closes_on: '2026-11-30' }, NOW)).toMatchObject({ ok: true, data: { closes_on: '2026-11-30' } });
  });
  it('reports a failed lookup as a generic failure and writes nothing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, writes } = fake([job()], {}, true);
    expect(await updateJob(ctx, { id: ID, title: 'X' }, NOW)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(log).toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    log.mockRestore();
  });
  it('cannot find a job in another workspace', async () => {
    const { ctx, writes } = fake([job({ org_id: OTHER_ORG })]);
    expect(await updateJob(ctx, { id: ID, title: 'Mine now' }, NOW)).toEqual({ ok: false, error: JOB_NOT_FOUND });
    expect(writes).toHaveLength(0);
  });
});

describe('setJobStatus', () => {
  const move = async (from: Job['status'], to: 'open' | 'paused' | 'closed', over: Partial<Job> = {}) => {
    const state = fake([job({ status: from, description: 'Make coffee.', ...over })]);
    return { result: await setJobStatus(state.ctx, { id: ID, status: to }, NOW), ...state };
  };
  it('allows exactly the listed moves', async () => {
    const allowed: [Job['status'], 'open' | 'paused' | 'closed'][] = [
      ['draft', 'open'], ['open', 'paused'], ['open', 'closed'], ['paused', 'open'], ['paused', 'closed'], ['closed', 'open'],
    ];
    for (const [from, to] of allowed) expect((await move(from, to)).result.ok, `${from}->${to}`).toBe(true);
    const refused: [Job['status'], 'open' | 'paused' | 'closed'][] = [['draft', 'paused'], ['draft', 'closed'], ['closed', 'paused']];
    for (const [from, to] of refused) {
      const { result, writes } = await move(from, to);
      expect(result.ok, `${from}->${to}`).toBe(false);
      expect(writes).toHaveLength(0);
    }
  });
  it('will not open a job with no description', async () => {
    const { result, writes } = await move('draft', 'open', { description: '  ' });
    expect(result).toEqual({ ok: false, error: JOB_NEEDS_DESCRIPTION });
    expect(writes).toHaveLength(0);
  });
  it('sets opened_at once, sets closed_at on close and clears it on reopen', async () => {
    const first = await move('draft', 'open');
    expect(first.rows[0].opened_at).toBe(NOW.toISOString());
    const reopened = await move('closed', 'open', { opened_at: '2026-09-01T00:00:00.000Z', closed_at: '2026-10-01T00:00:00.000Z' });
    expect(reopened.rows[0].opened_at).toBe('2026-09-01T00:00:00.000Z');
    expect(reopened.rows[0].closed_at).toBeNull();
    const closed = await move('open', 'closed');
    expect(closed.rows[0].closed_at).toBe(NOW.toISOString());
  });
  it('succeeds without writing when the job already has that status', async () => {
    const { result, writes } = await move('open', 'open');
    expect(result.ok).toBe(true);
    expect(writes).toHaveLength(0);
  });
  it('cannot find a job in another workspace', async () => {
    const { ctx, writes } = fake([job({ org_id: OTHER_ORG, description: 'x' })]);
    expect(await setJobStatus(ctx, { id: ID, status: 'open' }, NOW)).toEqual({ ok: false, error: JOB_NOT_FOUND });
    expect(writes).toHaveLength(0);
  });
  it('reports a failed lookup as a generic failure and writes nothing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, writes } = fake([job({ description: 'x' })], {}, true);
    expect(await setJobStatus(ctx, { id: ID, status: 'open' }, NOW)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(log).toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    log.mockRestore();
  });
});

describe('deleteJob', () => {
  it('deletes a job with no applications and says which', async () => {
    const { ctx, rows } = fake([job()]);
    expect(await deleteJob(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID, title: 'Barista' } });
    expect(rows).toHaveLength(0);
  });
  it('refuses a job with applications', async () => {
    const { ctx, rows } = fake([job()], { [ID]: 3 });
    expect(await deleteJob(ctx, { id: ID })).toEqual({ ok: false, error: JOB_HAS_APPLICATIONS });
    expect(rows).toHaveLength(1);
  });
  it('cannot find a job in another workspace', async () => {
    const { ctx, rows } = fake([job({ org_id: OTHER_ORG })]);
    expect(await deleteJob(ctx, { id: ID })).toEqual({ ok: false, error: JOB_NOT_FOUND });
    expect(rows).toHaveLength(1);
  });
});

describe('deleteJob lookup failure', () => {
  it('reports a failed lookup as a generic failure and deletes nothing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, rows, writes } = fake([job()], {}, true);
    expect(await deleteJob(ctx, { id: ID })).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(log).toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(rows).toHaveLength(1);
    log.mockRestore();
  });
});

/** A stand-in for `orgs` (slug lookup) and `hire_settings` (update, then insert). */
function fakeSettings(opts: {
  slug?: string | null;
  existing?: Record<string, unknown> | null;
  insertError?: { code?: string; message: string } | null;
  updateError?: { message: string } | null;
  /** rows the update returns, per call, overriding `existing` (for the raced insert) */
  updateResults?: (Record<string, unknown> | null)[];
} = {}) {
  const calls: { table: string; op: string; values?: Record<string, unknown>; filters: Record<string, unknown> }[] = [];
  let updateCount = 0;
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let op = 'select';
      let values: Record<string, unknown> | undefined;
      const record = () => calls.push({ table, op, values, filters: { ...filters } });
      const chain = {
        select: () => chain,
        insert: (v: Record<string, unknown>) => { op = 'insert'; values = v; return chain; },
        update: (v: Record<string, unknown>) => { op = 'update'; values = v; return chain; },
        eq: (k: string, v: unknown) => { filters[k] = v; return chain; },
        maybeSingle: async () => {
          record();
          if (table === 'orgs') return { data: opts.slug === undefined ? null : { slug: opts.slug }, error: null };
          if (op === 'update') {
            if (opts.updateError) return { data: null, error: opts.updateError };
            // The real call selects only the settings columns, so updated_at is not returned.
            const patch = { ...values };
            delete patch.updated_at;
            const next = opts.updateResults ? (opts.updateResults[updateCount++] ?? null) : opts.existing ? { ...opts.existing, ...patch } : null;
            return { data: next, error: null };
          }
          return { data: opts.existing ?? null, error: null };
        },
        single: async () => {
          record();
          if (opts.insertError) return { data: null, error: opts.insertError };
          return { data: { ...values }, error: null };
        },
      };
      return chain;
    },
  };
  const ctx = { client: client as never, orgId: ORG } satisfies HireWriteContext;
  const writes = () => calls.filter((c) => c.table === 'hire_settings' && (c.op === 'update' || c.op === 'insert'));
  return { ctx, calls, writes };
}

describe('updateCareersPage', () => {
  it('1: updates the existing row with the sent fields and updated_at, filtered by the workspace', async () => {
    const { ctx, writes } = fakeSettings({ slug: 'acme', existing: { org_id: ORG, careers_enabled: false, careers_headline: null, careers_tagline: null, ...FORM_OFF } });
    const result = await updateCareersPage(ctx, { careers_enabled: true, careers_headline: 'Hi' }, NOW);
    expect(writes()).toEqual([{
      table: 'hire_settings', op: 'update',
      values: { careers_enabled: true, careers_headline: 'Hi', updated_at: NOW.toISOString() },
      filters: { org_id: ORG },
    }]);
    expect(result).toEqual({ ok: true, data: { org_id: ORG, careers_enabled: true, careers_headline: 'Hi', careers_tagline: null, ...FORM_OFF } });
  });
  it('2: inserts when there is no row yet, always with the workspace from the session', async () => {
    const { ctx, writes } = fakeSettings({ slug: 'acme', existing: null });
    const result = await updateCareersPage(ctx, { careers_enabled: true, org_id: 'evil' } as never, NOW);
    const inserts = writes().filter((w) => w.op === 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toEqual({ careers_enabled: true, org_id: ORG });
    expect(result).toMatchObject({ ok: true, data: { org_id: ORG, careers_enabled: true } });
  });
  it('3: when the insert loses a race (23505), updates the row that now exists', async () => {
    const { ctx, writes } = fakeSettings({
      slug: 'acme',
      insertError: { code: '23505', message: 'duplicate key' },
      updateResults: [null, { org_id: ORG, careers_enabled: true, careers_headline: null, careers_tagline: null, ...FORM_OFF }],
    });
    const result = await updateCareersPage(ctx, { careers_enabled: true }, NOW);
    expect(writes().map((w) => w.op)).toEqual(['update', 'insert', 'update']);
    expect(result).toEqual({ ok: true, data: { org_id: ORG, careers_enabled: true, careers_headline: null, careers_tagline: null, ...FORM_OFF } });
  });
  it('4: stores a blank headline or tagline as null, and leaves out a field that was not sent', async () => {
    const { ctx, writes } = fakeSettings({ slug: 'acme', existing: { org_id: ORG } });
    await updateCareersPage(ctx, { careers_headline: '   ', careers_tagline: '' }, NOW);
    expect(writes()[0].values).toEqual({ careers_headline: null, careers_tagline: null, updated_at: NOW.toISOString() });
    expect(writes()[0].values).not.toHaveProperty('careers_enabled');
  });
  it('5: refuses a headline over 80 characters and a tagline over 160, and writes nothing', async () => {
    const { ctx, writes } = fakeSettings({ slug: 'acme', existing: { org_id: ORG } });
    expect(await updateCareersPage(ctx, { careers_headline: 'x'.repeat(81) }, NOW))
      .toEqual({ ok: false, error: 'Keep the headline under 80 characters.' });
    expect(await updateCareersPage(ctx, { careers_tagline: 'x'.repeat(161) }, NOW))
      .toEqual({ ok: false, error: 'Keep the tagline under 160 characters.' });
    expect(writes()).toHaveLength(0);
    expect((await updateCareersPage(ctx, { careers_headline: 'x'.repeat(80), careers_tagline: 'y'.repeat(160) }, NOW)).ok).toBe(true);
    expect(writes()).toHaveLength(1);
  });
  it('6: writes nothing when nothing is sent, and returns the current settings or the defaults', async () => {
    const current = fakeSettings({ existing: { org_id: ORG, careers_enabled: true, careers_headline: 'Hi', careers_tagline: null, ...FORM_OFF } });
    expect(await updateCareersPage(current.ctx, {}, NOW)).toEqual({
      ok: true, data: { org_id: ORG, careers_enabled: true, careers_headline: 'Hi', careers_tagline: null, ...FORM_OFF },
    });
    expect(current.writes()).toHaveLength(0);
    const none = fakeSettings({ existing: null });
    expect(await updateCareersPage(none.ctx, {}, NOW)).toEqual({
      ok: true, data: { org_id: ORG, careers_enabled: false, careers_headline: null, careers_tagline: null, ...FORM_OFF },
    });
    expect(none.writes()).toHaveLength(0);
  });
  it('7: refuses to switch the board on in the demo workspace, but not to switch it off or edit text', async () => {
    const on = fakeSettings({ slug: 'rimba-ventures-demo', existing: { org_id: ORG } });
    expect(await updateCareersPage(on.ctx, { careers_enabled: true }, NOW)).toEqual({ ok: false, error: CAREERS_DEMO });
    expect(on.writes()).toHaveLength(0);
    const off = fakeSettings({ slug: 'rimba-ventures-demo', existing: { org_id: ORG, careers_enabled: true } });
    expect((await updateCareersPage(off.ctx, { careers_enabled: false }, NOW)).ok).toBe(true);
    expect(off.writes()).toHaveLength(1);
    const text = fakeSettings({ slug: 'rimba-ventures-demo', existing: { org_id: ORG } });
    expect((await updateCareersPage(text.ctx, { careers_headline: 'Join us' }, NOW)).ok).toBe(true);
    expect(text.writes()).toHaveLength(1);
  });
  it('7b: does not switch the board on when the workspace cannot be read', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    // No slug given: the orgs read comes back with no row.
    const unknown = fakeSettings({ existing: { org_id: ORG } });
    expect(await updateCareersPage(unknown.ctx, { careers_enabled: true }, NOW))
      .toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(unknown.writes()).toHaveLength(0);
    log.mockRestore();
  });
  it('8: a database error on the write gives the generic line and logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx } = fakeSettings({ slug: 'acme', updateError: { message: 'permission denied for table hire_settings' } });
    expect(await updateCareersPage(ctx, { careers_headline: 'Hi' }, NOW))
      .toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe('updateApplicationForm', () => {
  const row = { org_id: ORG, careers_enabled: true, careers_headline: 'Hi', careers_tagline: null, ...FORM_OFF, ask_portfolio: true };

  it('1: updates only the switches sent, with updated_at, filtered by the workspace', async () => {
    const { ctx, writes } = fakeSettings({ existing: row });
    const result = await updateApplicationForm(ctx, { require_cv: true }, NOW);
    expect(writes()).toEqual([{
      table: 'hire_settings', op: 'update',
      values: { require_cv: true, updated_at: NOW.toISOString() },
      filters: { org_id: ORG },
    }]);
    // One switch does not reset another, the careers switch or the branding.
    expect(result).toEqual({ ok: true, data: { ...row, require_cv: true } });
  });
  it('2: makes the row when there is none, without touching the careers switch', async () => {
    const { ctx, writes } = fakeSettings({ existing: null });
    const result = await updateApplicationForm(ctx, { require_cv: true }, NOW);
    const inserts = writes().filter((w) => w.op === 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toEqual({ require_cv: true, org_id: ORG });
    expect(result).toMatchObject({ ok: true, data: { org_id: ORG, require_cv: true, careers_enabled: false, ask_portfolio: false } });
  });
  it('3: lets nothing but the four switches and the session workspace reach the database', async () => {
    const { ctx, writes } = fakeSettings({ existing: null });
    await updateApplicationForm(ctx, { require_cv: true, org_id: 'evil', careers_enabled: true } as never, NOW);
    for (const write of writes()) {
      expect(write.values).not.toHaveProperty('careers_enabled');
      expect(write.values?.org_id ?? ORG).toBe(ORG);
    }
    expect(writes().at(-1)?.values).toEqual({ require_cv: true, org_id: ORG });
  });
  it('4: when the insert loses a race (23505), updates the row that now exists', async () => {
    const { ctx, writes } = fakeSettings({
      insertError: { code: '23505', message: 'duplicate key' },
      updateResults: [null, { ...row, require_cover_letter: true }],
    });
    const result = await updateApplicationForm(ctx, { require_cover_letter: true }, NOW);
    expect(writes().map((w) => w.op)).toEqual(['update', 'insert', 'update']);
    expect(result).toEqual({ ok: true, data: { ...row, require_cover_letter: true } });
  });
  it('5: writes nothing when nothing is sent, and returns the current settings or the defaults', async () => {
    const current = fakeSettings({ existing: row });
    expect(await updateApplicationForm(current.ctx, {}, NOW)).toEqual({ ok: true, data: row });
    expect(current.writes()).toHaveLength(0);
    const none = fakeSettings({ existing: null });
    expect(await updateApplicationForm(none.ctx, {}, NOW)).toEqual({
      ok: true, data: { org_id: ORG, careers_enabled: false, careers_headline: null, careers_tagline: null, ...FORM_OFF },
    });
    expect(none.writes()).toHaveLength(0);
  });
  it('6: refuses a value that is not true or false, and writes nothing', async () => {
    const { ctx, writes } = fakeSettings({ existing: row });
    const result = await updateApplicationForm(ctx, { require_cv: 'yes' } as never, NOW);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).not.toBe('');
    expect(writes()).toHaveLength(0);
  });
  it('7: a database error on the write gives the generic line and logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx } = fakeSettings({ updateError: { message: 'permission denied for table hire_settings' } });
    expect(await updateApplicationForm(ctx, { ask_portfolio: false }, NOW))
      .toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
  it('8: is not refused for the demo workspace, and never reads the workspace row', async () => {
    const { ctx, calls } = fakeSettings({ slug: 'rimba-ventures-demo', existing: row });
    expect((await updateApplicationForm(ctx, { ask_expected_salary: true }, NOW)).ok).toBe(true);
    expect(calls.some((c) => c.table === 'orgs')).toBe(false);
  });
  it('9: the careers page change never carries a form switch', async () => {
    const { ctx, writes } = fakeSettings({ slug: 'acme', existing: row });
    await updateCareersPage(ctx, { careers_headline: 'New', require_cv: true } as never, NOW);
    expect(writes()[0].values).toEqual({ careers_headline: 'New', updated_at: NOW.toISOString() });
  });
});

describe('input schemas', () => {
  it('convert to JSON Schema, so they can be tool input schemas', () => {
    for (const schema of [createJobInput, updateJobInput, setJobStatusInput, deleteJobInput, updateCareersPageInput, updateApplicationFormInput]) {
      expect(z.toJSONSchema(schema)).toMatchObject({ type: 'object' });
    }
  });
});

describe('database failures', () => {
  it('logs the error and gives a generic line', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'permission denied for table hire_jobs' } }) }) }) }),
    };
    const result = await createJob({ client: broken as never, orgId: ORG }, { title: 'Barista' }, NOW);
    expect(result).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

// ─── changing an application (four rpc capabilities) ─────────────────────────

describe('application change schemas', () => {
  it('refuse a non-UUID id', () => {
    for (const id of ['nope', '', 42]) {
      expect(moveApplicationInput.safeParse({ id, stage: 'offer' }).success).toBe(false);
      expect(closeApplicationInput.safeParse({ id, outcome: 'rejected' }).success).toBe(false);
      expect(reopenApplicationInput.safeParse({ id }).success).toBe(false);
      expect(rateApplicationInput.safeParse({ id, rating: 3 }).success).toBe(false);
    }
  });
  it('refuse an unknown stage, outcome or reason', () => {
    expect(moveApplicationInput.safeParse({ id: ID, stage: 'lunch' }).success).toBe(false);
    expect(closeApplicationInput.safeParse({ id: ID, outcome: 'active' }).success).toBe(false);
    expect(closeApplicationInput.safeParse({ id: ID, outcome: 'rejected', reason: 'vibes' }).success).toBe(false);
    expect(closeApplicationInput.safeParse({ id: ID, outcome: 'withdrawn' }).success).toBe(true);
    expect(closeApplicationInput.safeParse({ id: ID, outcome: 'rejected', reason: null }).success).toBe(true);
  });
  it('refuse a rating of 0, 6 or 2.5 but take null and 1 to 5', () => {
    for (const rating of [0, 6, 2.5]) expect(rateApplicationInput.safeParse({ id: ID, rating }).success).toBe(false);
    for (const rating of [null, 1, 5]) expect(rateApplicationInput.safeParse({ id: ID, rating }).success).toBe(true);
  });
  it('describe every field', () => {
    for (const schema of [moveApplicationInput, closeApplicationInput, reopenApplicationInput, rateApplicationInput]) {
      for (const field of Object.values(schema.shape)) expect((field as z.ZodType).description).toBeTruthy();
    }
  });
  it('take the grounds for a rating as an optional basis of at most 500 characters', () => {
    expect(rateApplicationInput.safeParse({ id: ID, rating: 3 }).success).toBe(true);
    const parsed = rateApplicationInput.safeParse({ id: ID, rating: 3, basis: '  Six years in B2B sales.  ' });
    expect(parsed.success && parsed.data.basis).toBe('Six years in B2B sales.');
    expect(rateApplicationInput.safeParse({ id: ID, rating: 3, basis: 'x'.repeat(500) }).success).toBe(true);
    expect(rateApplicationInput.safeParse({ id: ID, rating: 3, basis: 'x'.repeat(501) }).success).toBe(false);
    expect(rateApplicationInput.safeParse({ id: ID, rating: 3, basis: 7 }).success).toBe(false);
    expect(rateApplicationInput.shape.basis.description).toBe(
      'One or two sentences giving the grounds for this rating, in plain words, taken from the CV or from what the user said, naming specifics (an employer, the years, a number, a skill) and never general praise. Shown on the Approve card. Not stored.',
    );
    // Still a plain schema: it must convert, or it cannot be a tool's input.
    expect(() => z.toJSONSchema(rateApplicationInput)).not.toThrow();
  });
});

const ROW = {
  id: ID, stage: 'offer', outcome: 'active', rating: 4, reject_reason: null,
  candidate: { name: 'Aina' }, job: { title: 'Barista' },
};
/** A client whose rpc answers `word` and whose read-back answers `row`. */
function rpcFake(opts: { word?: unknown; error?: unknown; throws?: unknown; row?: unknown } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const reads: Record<string, unknown>[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (opts.throws) throw opts.throws;
      return { data: opts.word ?? 'ok', error: opts.error ?? null };
    },
    from: () => {
      const chain = {
        select: () => chain,
        eq: (k: string, v: unknown) => { reads.push({ [k]: v }); return chain; },
        maybeSingle: async () => ('row' in opts ? { data: opts.row, error: null } : { data: ROW, error: null }),
      };
      return chain;
    },
  };
  return { ctx: { client: client as never, orgId: ORG } satisfies HireWriteContext, calls, reads };
}

describe('application change capabilities', () => {
  it('call the right function with the right arguments and no org_id', async () => {
    const a = rpcFake();
    await moveApplication(a.ctx, { id: ID, stage: 'offer' });
    expect(a.calls).toEqual([{ fn: 'hire_move_application', args: { p_application_id: ID, p_stage: 'offer' } }]);
    const b = rpcFake();
    await closeApplication(b.ctx, { id: ID, outcome: 'rejected', reason: 'skills' });
    expect(b.calls).toEqual([{ fn: 'hire_close_application', args: { p_application_id: ID, p_outcome: 'rejected', p_reason: 'skills' } }]);
    const b2 = rpcFake();
    await closeApplication(b2.ctx, { id: ID, outcome: 'withdrawn' });
    expect(b2.calls[0].args).toEqual({ p_application_id: ID, p_outcome: 'withdrawn', p_reason: null });
    const c = rpcFake();
    await reopenApplication(c.ctx, { id: ID });
    expect(c.calls).toEqual([{ fn: 'hire_reopen_application', args: { p_application_id: ID } }]);
    const d = rpcFake();
    await rateApplication(d.ctx, { id: ID, rating: null });
    expect(d.calls).toEqual([{ fn: 'hire_rate_application', args: { p_application_id: ID, p_rating: null } }]);
    for (const x of [a, b, c, d]) expect(JSON.stringify(x.calls)).not.toContain('org_id');
  });
  it('accept a basis with a rating and send none of it to the database', async () => {
    const f = rpcFake();
    const result = await rateApplication(f.ctx, { id: ID, rating: 3, basis: 'Six years in B2B sales.' });
    expect(result.ok).toBe(true);
    expect(f.calls).toEqual([{ fn: 'hire_rate_application', args: { p_application_id: ID, p_rating: 3 } }]);
    expect(f.calls[0].args).not.toHaveProperty('basis');
    expect(JSON.stringify(f.calls)).not.toContain('Six years');
    // Not stored, so not in what comes back either.
    expect(JSON.stringify(result)).not.toContain('Six years');
  });
  it('do not call the database for invalid input', async () => {
    const f = rpcFake();
    expect((await moveApplication(f.ctx, { id: 'x', stage: 'offer' } as never)).ok).toBe(false);
    expect(f.calls).toEqual([]);
  });
  it('map each word to its sentence', async () => {
    const generic = 'That change could not be saved. Please try again.';
    const sentences: Record<string, string> = {
      not_found: 'That application could not be found.',
      forbidden: 'You do not have permission to make changes here.',
      not_active: 'This application is no longer active. Reopen it first.',
      not_closed: 'This application is already active.',
      same_stage: 'This application is already at that stage.',
      too_far_back: 'An application can move back one stage at a time.',
      invalid_stage: generic,
      invalid_outcome: generic,
      invalid_reason: generic,
      invalid_rating: generic,
      mystery: generic,
    };
    for (const [word, error] of Object.entries(sentences)) {
      expect(await moveApplication(rpcFake({ word }).ctx, { id: ID, stage: 'offer' })).toEqual({ ok: false, error });
    }
  });
  it('give the generic sentence and log only a code on an rpc error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = rpcFake({ error: { code: '42501', message: 'Aina secret', details: ID } });
    expect(await rateApplication(f.ctx, { id: ID, rating: 3 })).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(spy).toHaveBeenCalledWith('[hire-capability] rateApplication failed:', { code: '42501' });
    spy.mockRestore();
  });
  it('give the generic sentence and log only the name of a thrown value', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new TypeError('Aina fetch failed');
    expect((await reopenApplication(rpcFake({ throws: err }).ctx, { id: ID })).ok).toBe(false);
    expect(spy).toHaveBeenCalledWith('[hire-capability] reopenApplication failed:', { code: 'TypeError' });
    spy.mockRestore();
  });
  it('return the read-back row on ok, looked up by id and workspace', async () => {
    const f = rpcFake();
    expect(await moveApplication(f.ctx, { id: ID, stage: 'offer' })).toEqual({
      ok: true,
      data: { id: ID, candidate: 'Aina', job: 'Barista', stage: 'offer', outcome: 'active', rating: 4, reject_reason: null, confirmed: true },
    });
    expect(f.reads).toEqual([{ id: ID }, { org_id: ORG }]);
  });
  it('still answer ok when the read-back fails', async () => {
    const f = rpcFake({ row: null });
    expect(await closeApplication(f.ctx, { id: ID, outcome: 'rejected', reason: 'salary' })).toMatchObject({
      ok: true, data: { id: ID, candidate: '', job: '', outcome: 'rejected', reject_reason: 'salary' },
    });
    expect(await rateApplication(rpcFake({ row: null }).ctx, { id: ID, rating: 2 })).toMatchObject({ ok: true, data: { rating: 2 } });
    expect(await moveApplication(rpcFake({ row: null }).ctx, { id: ID, stage: 'hired' })).toMatchObject({ ok: true, data: { stage: 'hired' } });
  });

  it('says what it does not know when the read-back fails, and never guesses a stage, an outcome or a rating', async () => {
    const closed = await closeApplication(rpcFake({ row: null }).ctx, { id: ID, outcome: 'withdrawn' });
    expect(closed).toEqual({ ok: true, data: {
      id: ID, candidate: '', job: '', stage: null, outcome: 'withdrawn', rating: null, reject_reason: null, confirmed: false,
      note: 'Saved. The application could not be read back, so some details are not shown.',
      // The stand-in client cannot answer the count of interviews still ahead: a count that cannot be read is 0.
      scheduled_interviews: 0,
    } });
    const moved = await moveApplication(rpcFake({ row: null }).ctx, { id: ID, stage: 'offer' });
    expect(moved).toMatchObject({ ok: true, data: { stage: 'offer', outcome: 'active', confirmed: false } });
    const rated = await rateApplication(rpcFake({ row: null }).ctx, { id: ID, rating: 3 });
    expect(rated).toMatchObject({ ok: true, data: { stage: null, outcome: null, rating: 3, confirmed: false } });
    const reopened = await reopenApplication(rpcFake({ row: null }).ctx, { id: ID });
    expect(reopened).toMatchObject({ ok: true, data: { stage: null, outcome: 'active', reject_reason: null, confirmed: false } });
    for (const result of [moved, rated, reopened]) {
      expect(result).toMatchObject({ ok: true, data: { note: 'Saved. The application could not be read back, so some details are not shown.' } });
    }
  });

  it('marks a read-back row as confirmed', async () => {
    const f = rpcFake({ row: { id: ID, stage: 'offer', outcome: 'active', rating: 4, reject_reason: null, candidate: { name: 'Aina' }, job: { title: 'Barista' } } });
    expect(await rateApplication(f.ctx, { id: ID, rating: 4 })).toMatchObject({ ok: true, data: { stage: 'offer', confirmed: true } });
  });

  it('gives a confirmed row no note', async () => {
    const result = await moveApplication(rpcFake().ctx, { id: ID, stage: 'offer' });
    expect(result.ok && result.data.confirmed).toBe(true);
    expect(result.ok && result.data).not.toHaveProperty('note');
  });
});

// ─── hand-entered candidates ─────────────────────────────────────────────────

const JOB_ID = '44444444-4444-4444-8444-444444444444';
const CAND_ID = '55555555-5555-4555-8555-555555555555';
const APP_ID = '66666666-6666-4666-8666-666666666666';
const GENERIC_SENTENCE = 'That change could not be saved. Please try again.';

/** A client whose rpc answers `answer` and whose reads answer by table. */
function candFake(opts: { answer?: unknown; error?: unknown; throws?: unknown; name?: string | null; title?: string | null; readThrows?: boolean } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const reads: { table: string; filters: Record<string, unknown> }[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (opts.throws) throw opts.throws;
      return { data: 'answer' in opts ? opts.answer : { word: 'ok' }, error: opts.error ?? null };
    },
    from: (table: string) => {
      const entry = { table, filters: {} as Record<string, unknown> };
      reads.push(entry);
      const chain = {
        select: () => chain,
        eq: (k: string, v: unknown) => { entry.filters[k] = v; return chain; },
        maybeSingle: async () => {
          if (opts.readThrows) throw new Error('read failed');
          if (table === 'hire_candidates') return { data: opts.name === null ? null : { name: opts.name ?? 'Aina' }, error: null };
          return { data: opts.title === null ? null : { title: opts.title ?? 'Barista' }, error: null };
        },
      };
      return chain;
    },
  };
  return { ctx: { client: client as never, orgId: ORG } satisfies HireWriteContext, calls, reads };
}

const ADDED = { word: 'ok', candidate_id: CAND_ID, application_id: null, candidate: 'created', application: 'none' };

describe('candidate schemas', () => {
  it('refuse a blank name, a 121-character name, a non-UUID job and 21 skills', () => {
    expect(addCandidateInput.safeParse({ name: '   ' }).success).toBe(false);
    expect(addCandidateInput.safeParse({ name: 'x'.repeat(120) }).success).toBe(true);
    expect(addCandidateInput.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);
    expect(addCandidateInput.safeParse({ name: 'A', job_id: 'nope' }).success).toBe(false);
    expect(addCandidateInput.safeParse({ name: 'A', job_id: null }).success).toBe(true);
    const skills = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
    expect(addCandidateInput.safeParse({ name: 'A', skills: skills(20) }).success).toBe(true);
    expect(addCandidateInput.safeParse({ name: 'A', skills: skills(21) }).success).toBe(false);
    expect(addCandidateInput.safeParse({ name: 'A', skills: ['x'.repeat(41)] }).success).toBe(false);
    expect(addCandidateInput.safeParse({ name: 'A', cover_letter: 'x'.repeat(4001) }).success).toBe(false);
    expect(addCandidateInput.safeParse({ name: 'A', cv_url: 'x'.repeat(501) }).success).toBe(false);
    expect(updateCandidateInput.safeParse({ id: 'nope' }).success).toBe(false);
    expect(updateCandidateInput.safeParse({ id: CAND_ID, name: null }).success).toBe(false);
    expect(updateCandidateInput.safeParse({ id: CAND_ID, name: '  ' }).success).toBe(false);
    expect(updateCandidateInput.safeParse({ id: CAND_ID, email: null }).success).toBe(true);
  });
  it('refuse a skill that contains a comma, on an add and on an edit: the forms hold skills as one comma-separated line', () => {
    const NO_COMMA = 'A skill cannot contain a comma.';
    const add = addCandidateInput.safeParse({ name: 'A', skills: ['Excel', 'Sales, B2B'] });
    expect(add.success).toBe(false);
    expect(add.error?.issues[0]?.message).toBe(NO_COMMA);
    const edit = updateCandidateInput.safeParse({ id: CAND_ID, skills: ['Office (Word, Excel)'] });
    expect(edit.success).toBe(false);
    expect(edit.error?.issues[0]?.message).toBe(NO_COMMA);
    // The same skills, one to an entry, are taken.
    expect(addCandidateInput.safeParse({ name: 'A', skills: ['Excel', 'Sales', 'B2B'] }).success).toBe(true);
    expect(updateCandidateInput.safeParse({ id: CAND_ID, skills: ['Office (Word; Excel)'] }).success).toBe(true);
  });
  it('say nothing new about skills in the JSON Schema a model is given: the comma rule is not a pattern', () => {
    for (const schema of [addCandidateInput, updateCandidateInput]) {
      const { properties } = z.toJSONSchema(schema) as { properties: Record<string, { items?: unknown }> };
      expect(properties.skills.items).toEqual({ type: 'string', minLength: 1, maxLength: 40 });
    }
  });
  it('convert to JSON Schema, describe every field and carry no workspace key', () => {
    for (const schema of [addCandidateInput, updateCandidateInput]) {
      expect(() => z.toJSONSchema(schema)).not.toThrow();
      for (const [key, field] of Object.entries(schema.shape)) {
        expect(key).not.toMatch(/org|tenant|workspace/i);
        expect((field as z.ZodType).description, key).toBeTruthy();
      }
    }
  });
  it('tell an add to leave an unknown detail out, and only an edit that a blank clears it', () => {
    const optional = ['email', 'phone', 'headline', 'location', 'skills', 'source'] as const;
    for (const key of optional) {
      const onAdd = addCandidateInput.shape[key].description ?? '';
      const onEdit = updateCandidateInput.shape[key].description ?? '';
      expect(onAdd, key).toContain('Leave out when not known.');
      expect(onAdd, key).not.toMatch(/clears/);
      expect(onEdit, key).toMatch(/clears (it|them)\.$/);
      expect(onEdit, key).toContain('Leave out to keep');
    }
    for (const key of ['cover_letter', 'cv_url'] as const) {
      expect(addCandidateInput.shape[key].description, key).toContain('Leave out when there is none.');
    }
  });
});

describe('addCandidate', () => {
  it('sends the workspace from the context and exactly the SQL argument names', async () => {
    const f = candFake({ answer: ADDED });
    await addCandidate(f.ctx, { name: 'Aina', email: 'a@b.co', skills: ['Sales'], job_id: JOB_ID, cover_letter: 'Hi', cv_url: 'https://a.co/cv.pdf' });
    expect(f.calls).toEqual([{
      fn: 'hire_add_candidate',
      args: {
        p_org_id: ORG, p_name: 'Aina', p_email: 'a@b.co', p_phone: null, p_headline: null, p_location: null,
        p_skills: ['Sales'], p_source: null, p_job_id: JOB_ID, p_cover_letter: 'Hi', p_cv_url: 'https://a.co/cv.pdf',
      },
    }]);
  });
  it('sends nulls and an empty skills list for what was not given, and blanks as null', async () => {
    const f = candFake({ answer: ADDED });
    await addCandidate(f.ctx, { name: 'Aina', email: '', phone: '  ' });
    expect(f.calls[0].args).toEqual({
      p_org_id: ORG, p_name: 'Aina', p_email: null, p_phone: null, p_headline: null, p_location: null,
      p_skills: [], p_source: null, p_job_id: null, p_cover_letter: null, p_cv_url: null,
    });
  });
  it('refuses a bad input without calling the database', async () => {
    const f = candFake();
    expect((await addCandidate(f.ctx, { name: '' })).ok).toBe(false);
    expect(f.calls).toEqual([]);
  });
  it('maps each refusal word to its sentence', async () => {
    const words: Record<string, string> = {
      not_found: 'That candidate could not be found.',
      forbidden: 'You do not have permission to make changes here.',
      invalid_name: 'Enter the candidate\'s name.',
      too_long: 'One of the details is too long.',
      invalid_email: 'Enter an email address like name@example.com.',
      invalid_url: 'Enter a link that starts with https://',
      job_not_found: 'That job could not be found.',
      job_not_open: 'Only an open or paused job can take a new application.',
      surprise: GENERIC_SENTENCE,
    };
    for (const [word, sentence] of Object.entries(words)) {
      expect(await addCandidate(candFake({ answer: { word } }).ctx, { name: 'Aina' })).toEqual({ ok: false, error: sentence });
    }
    expect(await addCandidate(candFake({ answer: null }).ctx, { name: 'Aina' })).toEqual({ ok: false, error: GENERIC_SENTENCE });
  });
  it('logs only a code on an rpc error and on a throw', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = await addCandidate(candFake({ error: { code: '42501', message: 'Aina secret', details: 'a@b.co' } }).ctx, { name: 'Aina' });
    expect(e).toEqual({ ok: false, error: GENERIC_SENTENCE });
    expect(spy).toHaveBeenCalledWith('[hire-capability] addCandidate failed:', { code: '42501' });
    await addCandidate(candFake({ throws: new TypeError('Aina fetch failed') }).ctx, { name: 'Aina' });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] addCandidate failed:', { code: 'TypeError' });
    spy.mockRestore();
  });
  it('names the stored name in the message, reading the candidate by id and workspace', async () => {
    const f = candFake({ answer: { ...ADDED, candidate: 'existing' }, name: 'Farid bin Osman' });
    const result = await addCandidate(f.ctx, { name: 'Farid' });
    expect(result).toEqual({
      ok: true,
      data: {
        id: CAND_ID, name: 'Farid bin Osman', application_id: null, job_id: null, job: null,
        candidate: 'existing', application: 'none', message: 'Farid bin Osman is already on file. Nothing was changed.',
      },
    });
    expect(f.reads).toEqual([{ table: 'hire_candidates', filters: { id: CAND_ID, org_id: ORG } }]);
  });
  it('reads the job title when a job was given, scoped by workspace', async () => {
    const answer = { ...ADDED, application_id: APP_ID, application: 'created' };
    const f = candFake({ answer, title: 'Barista' });
    const result = await addCandidate(f.ctx, { name: 'Aina', job_id: JOB_ID });
    expect(result).toMatchObject({
      ok: true, data: { application_id: APP_ID, job_id: JOB_ID, job: 'Barista', message: 'Added Aina and an application for Barista.' },
    });
    expect(f.reads).toContainEqual({ table: 'hire_jobs', filters: { id: JOB_ID, org_id: ORG } });
  });
  it('still answers ok with the typed name when a read-back fails or finds nothing', async () => {
    expect(await addCandidate(candFake({ answer: ADDED, name: null }).ctx, { name: 'Aina' })).toMatchObject({
      ok: true, data: { name: 'Aina', message: 'Added Aina to the talent pool as Available.' },
    });
    expect(await addCandidate(candFake({ answer: ADDED, readThrows: true }).ctx, { name: 'Aina' })).toMatchObject({
      ok: true, data: { name: 'Aina' },
    });
  });
});

describe('updateCandidate', () => {
  it('sends only the fields that were sent, nulls for cleared ones, and [] for no skills', async () => {
    const f = candFake({ answer: { word: 'ok' }, name: 'Aina' });
    const result = await updateCandidate(f.ctx, { id: CAND_ID, headline: 'Barista', phone: '', email: null, skills: [] });
    expect(result).toEqual({ ok: true, data: { id: CAND_ID, name: 'Aina' } });
    expect(f.calls).toEqual([{
      fn: 'hire_update_candidate',
      args: { p_candidate_id: CAND_ID, p_changes: { headline: 'Barista', phone: null, email: null, skills: [] } },
    }]);
    expect(f.reads).toEqual([{ table: 'hire_candidates', filters: { id: CAND_ID, org_id: ORG } }]);
  });
  it('leaves a field that was not sent out of p_changes', async () => {
    const f = candFake({ answer: { word: 'ok' } });
    await updateCandidate(f.ctx, { id: CAND_ID, name: 'Aina binti Ali', location: undefined });
    expect(f.calls[0].args.p_changes).toEqual({ name: 'Aina binti Ali' });
    expect(Object.keys(f.calls[0].args.p_changes as object)).toEqual(['name']);
  });
  it('refuses an empty change without calling the database', async () => {
    const f = candFake();
    expect(await updateCandidate(f.ctx, { id: CAND_ID })).toEqual({ ok: false, error: 'Nothing to change.' });
    expect(f.calls).toEqual([]);
  });
  it('maps each word to its sentence', async () => {
    const words: Record<string, string> = {
      not_found: 'That candidate could not be found.',
      forbidden: 'You do not have permission to make changes here.',
      invalid_changes: GENERIC_SENTENCE,
      too_long: 'One of the details is too long.',
      invalid_email: 'Enter an email address like name@example.com.',
      email_taken: 'Another candidate already has this email.',
      invalid_name: 'Enter the candidate\'s name.',
    };
    for (const [word, sentence] of Object.entries(words)) {
      const f = candFake({ answer: { word } });
      expect(await updateCandidate(f.ctx, { id: CAND_ID, headline: 'x' })).toEqual({ ok: false, error: sentence });
    }
  });
  it('logs only a code on failure', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await updateCandidate(candFake({ error: { code: 'PGRST301', message: 'a@b.co' } }).ctx, { id: CAND_ID, headline: 'x' });
    expect(r).toEqual({ ok: false, error: GENERIC_SENTENCE });
    expect(spy).toHaveBeenCalledWith('[hire-capability] updateCandidate failed:', { code: 'PGRST301' });
    spy.mockRestore();
  });
  it('still answers ok with an empty name when the read-back fails', async () => {
    expect(await updateCandidate(candFake({ answer: { word: 'ok' }, name: null }).ctx, { id: CAND_ID, headline: 'x' }))
      .toEqual({ ok: true, data: { id: CAND_ID, name: '' } });
  });
});

describe('attachCandidateCv', () => {
  const answering = (result: unknown, throws = false) => ({
    rpc: async () => {
      if (throws) throw new TypeError('network');
      return result;
    },
  }) as never;
  it('returns the function\'s word, calling it with the application and path', async () => {
    const seen: unknown[] = [];
    const client = { rpc: async (fn: string, args: unknown) => { seen.push([fn, args]); return { data: 'ok', error: null }; } } as never;
    expect(await attachCandidateCv(client, APP_ID, 'org/job/cv.pdf')).toBe('ok');
    expect(seen).toEqual([['hire_attach_cv', { p_application_id: APP_ID, p_cv_path: 'org/job/cv.pdf' }]]);
    expect(await attachCandidateCv(answering({ data: 'already_attached', error: null }), APP_ID, 'p')).toBe('already_attached');
  });
  it('returns failed on an error, a throw or an odd answer, logging only a code', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await attachCandidateCv(answering({ data: null, error: { code: '42501', message: 'x' } }), APP_ID, 'p')).toBe('failed');
    expect(spy).toHaveBeenCalledWith('[hire-capability] attachCandidateCv failed:', { code: '42501' });
    expect(await attachCandidateCv(answering({}, true), APP_ID, 'p')).toBe('failed');
    expect(await attachCandidateCv(answering({ data: 7, error: null }), APP_ID, 'p')).toBe('failed');
    spy.mockRestore();
  });
});

// ─── deleting an application or a candidate ──────────────────────────────────

const DELETE_SENTENCE = 'That could not be deleted. Please try again.';

/** A client whose rpc answers `answer`. */
function delFake(opts: { answer?: unknown; error?: unknown; throws?: unknown } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (opts.throws) throw opts.throws;
      return { data: 'answer' in opts ? opts.answer : { word: 'ok' }, error: opts.error ?? null };
    },
  };
  return { ctx: { client: client as never, orgId: ORG } satisfies HireWriteContext, calls };
}

type TableAnswer = { row?: unknown; rows?: unknown[]; count?: number | null; error?: unknown };

/** A client whose reads answer by table: `row` for maybeSingle, `rows` and `count` when the query itself is awaited. */
function summaryFake(tables: Record<string, TableAnswer>, throws = false) {
  const reads: { table: string; columns: string; filters: Record<string, unknown> }[] = [];
  const client = {
    from: (table: string) => {
      const entry = { table, columns: '', filters: {} as Record<string, unknown> };
      reads.push(entry);
      const t = tables[table] ?? {};
      const chain = {
        select: (columns: string) => { entry.columns = columns; return chain; },
        eq: (k: string, v: unknown) => { entry.filters[k] = v; return chain; },
        in: (k: string, v: unknown) => { entry.filters[k] = v; return chain; },
        maybeSingle: async () => {
          if (throws) throw new TypeError('read failed');
          return { data: t.row ?? null, error: t.error ?? null };
        },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          (throws
            ? Promise.reject(new TypeError('read failed'))
            : Promise.resolve({ data: t.rows ?? [], count: t.count ?? 0, error: t.error ?? null })
          ).then(resolve, reject),
      };
      return chain;
    },
  };
  return { ctx: { client: client as never, orgId: ORG } satisfies HireWriteContext, reads };
}

describe('deletion schemas', () => {
  it('take one id and nothing else, described, with no workspace key', () => {
    for (const schema of [deleteApplicationInput, deleteCandidateInput]) {
      expect(Object.keys(schema.shape)).toEqual(['id']);
      expect(schema.safeParse({ id: 'nope' }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ id: APP_ID }).success).toBe(true);
    }
    for (const schema of [deleteApplicationInput, deleteCandidateInput, deletionSummaryInput]) {
      expect(() => z.toJSONSchema(schema)).not.toThrow();
      for (const [key, field] of Object.entries(schema.shape)) {
        expect(key).not.toMatch(/org|tenant|workspace/i);
        expect((field as z.ZodType).description, key).toBeTruthy();
      }
    }
    expect(deleteApplicationInput.shape.id.description).toBe('The application\'s id, from listApplications.');
    expect(deleteCandidateInput.shape.id.description).toBe('The candidate\'s id, from listCandidates.');
    expect(deletionSummaryInput.safeParse({ kind: 'job', id: APP_ID }).success).toBe(false);
  });
});

describe('deleteApplication', () => {
  const ANSWER = { word: 'ok', name: 'Aina Rahman', job: 'Sales Executive', applications: 1, interviews: 2, cv_files: 1 };
  it('sends only the id to its function, and reports what the function says it removed', async () => {
    const f = delFake({ answer: ANSWER });
    const result = await deleteApplication(f.ctx, { id: APP_ID });
    expect(f.calls).toEqual([{ fn: 'hire_delete_application', args: { p_application_id: APP_ID } }]);
    expect(result).toEqual({
      ok: true,
      data: {
        id: APP_ID, name: 'Aina Rahman', job: 'Sales Executive', applications: 1, interviews: 2, cv_files: 1,
        message: 'Deleted Aina Rahman\'s application for Sales Executive, with 2 interviews and 1 CV file. Aina Rahman is still on file.',
      },
    });
  });
  it('refuses a bad id before any call', async () => {
    const f = delFake();
    expect((await deleteApplication(f.ctx, { id: 'nope' })).ok).toBe(false);
    expect(f.calls).toEqual([]);
  });
  it('maps each refusal to its sentence', async () => {
    const cases: [unknown, string][] = [
      [{ word: 'not_found' }, 'That application could not be found. It may already have been deleted.'],
      [{ word: 'forbidden' }, 'You do not have permission to make changes here.'],
      [{ word: 'changed' }, DELETE_SENTENCE],
      [{ word: 'surprise' }, DELETE_SENTENCE],
      [null, DELETE_SENTENCE],
    ];
    for (const [answer, sentence] of cases) {
      expect(await deleteApplication(delFake({ answer }).ctx, { id: APP_ID })).toEqual({ ok: false, error: sentence });
    }
  });
  it('gives the delete sentence and logs only a code on an rpc error and on a throw', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = await deleteApplication(delFake({ error: { code: '42501', message: 'Aina secret' } }).ctx, { id: APP_ID });
    expect(e).toEqual({ ok: false, error: DELETE_SENTENCE });
    expect(spy).toHaveBeenCalledWith('[hire-capability] deleteApplication failed:', { code: '42501' });
    const t = await deleteApplication(delFake({ throws: new TypeError('Aina fetch failed') }).ctx, { id: APP_ID });
    expect(t).toEqual({ ok: false, error: DELETE_SENTENCE });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] deleteApplication failed:', { code: 'TypeError' });
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/Aina|66666666/);
    spy.mockRestore();
  });
  it('still answers ok when the answer has no name or odd counts: the deletion has happened', async () => {
    const result = await deleteApplication(delFake({ answer: { word: 'ok', interviews: '3', cv_files: -1 } }).ctx, { id: APP_ID });
    expect(result).toEqual({
      ok: true,
      data: { id: APP_ID, name: '', job: null, applications: 0, interviews: 0, cv_files: 0, message: 'Deleted the application.' },
    });
  });
});

describe('deleteCandidate', () => {
  it('sends only the id to its function, and reports what the function says it removed', async () => {
    const f = delFake({ answer: { word: 'ok', name: 'Aina Rahman', applications: 2, interviews: 1, cv_files: 1 } });
    const result = await deleteCandidate(f.ctx, { id: CAND_ID });
    expect(f.calls).toEqual([{ fn: 'hire_delete_candidate', args: { p_candidate_id: CAND_ID } }]);
    expect(result).toEqual({
      ok: true,
      data: {
        id: CAND_ID, name: 'Aina Rahman', job: null, applications: 2, interviews: 1, cv_files: 1,
        message: 'Deleted Aina Rahman, with 2 applications, 1 interview and 1 CV file.',
      },
    });
  });
  it('never reports a job, even if the answer carried one', async () => {
    const result = await deleteCandidate(delFake({ answer: { word: 'ok', name: 'Aina', job: 'Barista', applications: 0 } }).ctx, { id: CAND_ID });
    expect(result.ok && result.data.job).toBeNull();
    expect(result.ok && result.data.message).toBe('Deleted Aina.');
  });
  it('maps each refusal to its sentence', async () => {
    const cases: [unknown, string][] = [
      [{ word: 'not_found' }, 'That candidate could not be found. They may already have been deleted.'],
      [{ word: 'forbidden' }, 'You do not have permission to make changes here.'],
      [{ word: 'changed' }, 'This candidate was changed a moment ago. Nothing was deleted. Try again.'],
      ['not_found', 'That candidate could not be found. They may already have been deleted.'],
      [undefined, DELETE_SENTENCE],
    ];
    for (const [answer, sentence] of cases) {
      expect(await deleteCandidate(delFake({ answer }).ctx, { id: CAND_ID })).toEqual({ ok: false, error: sentence });
    }
  });
  it('refuses a bad id before any call, and logs only a code on a throw', async () => {
    const f = delFake();
    expect((await deleteCandidate(f.ctx, { id: '' })).ok).toBe(false);
    expect(f.calls).toEqual([]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await deleteCandidate(delFake({ throws: new TypeError('x') }).ctx, { id: CAND_ID })).toEqual({ ok: false, error: DELETE_SENTENCE });
    expect(spy).toHaveBeenCalledWith('[hire-capability] deleteCandidate failed:', { code: 'TypeError' });
    spy.mockRestore();
  });
});

describe('deletionSummary', () => {
  const FAILED = 'Couldn\'t check what this removes. Close this and try again.';
  it('counts what deleting an application would remove, reading within the workspace', async () => {
    const f = summaryFake({
      hire_applications: { row: { id: APP_ID, cv_path: 'o/j/f.pdf', candidate: { name: 'Aina Rahman' }, job: { title: 'Sales Executive' } } },
      hire_interviews: { count: 2 },
    });
    expect(await deletionSummary(f.ctx, { kind: 'application', id: APP_ID })).toEqual({
      ok: true, data: { name: 'Aina Rahman', job: 'Sales Executive', applications: 1, interviews: 2, cvFiles: 1 },
    });
    expect(f.reads.map((r) => r.table)).toEqual(['hire_applications', 'hire_interviews']);
    expect(f.reads[0].filters).toEqual({ id: APP_ID, org_id: ORG });
    expect(f.reads[1].filters).toEqual({ org_id: ORG, application_id: APP_ID });
    // No contact detail is ever asked for.
    for (const read of f.reads) expect(read.columns).not.toMatch(/email|phone/);
  });
  it('counts what deleting a candidate would remove', async () => {
    const f = summaryFake({
      hire_candidates: { row: { name: 'Aina Rahman' } },
      hire_applications: { rows: [{ id: 'a1', cv_path: 'o/j/f.pdf' }, { id: 'a2', cv_path: null }, { id: 'a3', cv_path: 'o/k/g.pdf' }] },
      hire_interviews: { count: 4 },
    });
    expect(await deletionSummary(f.ctx, { kind: 'candidate', id: CAND_ID })).toEqual({
      ok: true, data: { name: 'Aina Rahman', job: null, applications: 3, interviews: 4, cvFiles: 2 },
    });
    expect(f.reads[0].filters).toEqual({ id: CAND_ID, org_id: ORG });
    expect(f.reads[1].filters).toEqual({ org_id: ORG, candidate_id: CAND_ID });
    expect(f.reads[2].filters).toEqual({ org_id: ORG, application_id: ['a1', 'a2', 'a3'] });
    expect(f.reads[0].columns).toBe('name');
  });
  it('does not ask about interviews for a candidate with no applications', async () => {
    const f = summaryFake({ hire_candidates: { row: { name: 'Aina' } }, hire_applications: { rows: [] } });
    expect(await deletionSummary(f.ctx, { kind: 'candidate', id: CAND_ID })).toEqual({
      ok: true, data: { name: 'Aina', job: null, applications: 0, interviews: 0, cvFiles: 0 },
    });
    expect(f.reads.map((r) => r.table)).toEqual(['hire_candidates', 'hire_applications']);
  });
  it('never puts a storage path in what it returns', async () => {
    const f = summaryFake({
      hire_applications: { row: { id: APP_ID, cv_path: 'o/j/secret.pdf', candidate: { name: 'Aina' }, job: { title: 'Barista' } } },
    });
    expect(JSON.stringify(await deletionSummary(f.ctx, { kind: 'application', id: APP_ID }))).not.toMatch(/secret|\.pdf|cv_path/);
  });
  it('says the row could not be found when it is not there', async () => {
    expect(await deletionSummary(summaryFake({}).ctx, { kind: 'application', id: APP_ID }))
      .toEqual({ ok: false, error: 'That application could not be found. It may already have been deleted.' });
    expect(await deletionSummary(summaryFake({}).ctx, { kind: 'candidate', id: CAND_ID }))
      .toEqual({ ok: false, error: 'That candidate could not be found. They may already have been deleted.' });
  });
  it('gives its own sentence for a bad input, a read error and a throw, logging only a code', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await deletionSummary(summaryFake({}).ctx, { kind: 'candidate', id: 'nope' })).toEqual({ ok: false, error: FAILED });
    expect(await deletionSummary(summaryFake({}).ctx, { kind: 'job', id: CAND_ID } as never)).toEqual({ ok: false, error: FAILED });
    const failing = summaryFake({ hire_candidates: { row: { name: 'Aina' } }, hire_applications: { error: { code: 'PGRST301', message: 'Aina' } } });
    expect(await deletionSummary(failing.ctx, { kind: 'candidate', id: CAND_ID })).toEqual({ ok: false, error: FAILED });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] deletionSummary failed:', { code: 'PGRST301' });
    expect(await deletionSummary(summaryFake({}, true).ctx, { kind: 'application', id: APP_ID })).toEqual({ ok: false, error: FAILED });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] deletionSummary failed:', { code: 'TypeError' });
    spy.mockRestore();
  });
});

// ─── the talent pool ─────────────────────────────────────────────────────────

describe('pool schemas', () => {
  it('refuse a missing or malformed id and a status outside the four', () => {
    expect(setPoolStatusInput.safeParse({ status: 'available' }).success).toBe(false);
    expect(setPoolStatusInput.safeParse({ id: 'nope', status: 'available' }).success).toBe(false);
    expect(setPoolStatusInput.safeParse({ id: CAND_ID }).success).toBe(false);
    for (const status of ['shortlisted', 'Available', '', null]) {
      expect(setPoolStatusInput.safeParse({ id: CAND_ID, status }).success, String(status)).toBe(false);
    }
    for (const status of ['available', 'passive', 're_engaged', 'none']) {
      expect(setPoolStatusInput.safeParse({ id: CAND_ID, status }).success, status).toBe(true);
    }
    expect(setPoolStatusInput.safeParse({ id: CAND_ID, status: 'available', only_if_outside: 'yes' }).success).toBe(false);
    expect(moveToPipelineInput.safeParse({ id: CAND_ID }).success).toBe(false);
    expect(moveToPipelineInput.safeParse({ id: CAND_ID, job_id: 'nope' }).success).toBe(false);
    expect(moveToPipelineInput.safeParse({ id: 'nope', job_id: JOB_ID }).success).toBe(false);
    expect(moveToPipelineInput.safeParse({ id: CAND_ID, job_id: JOB_ID }).success).toBe(true);
  });
  it('convert to JSON Schema, describe every field and carry no workspace key', () => {
    for (const schema of [setPoolStatusInput, moveToPipelineInput]) {
      expect(() => z.toJSONSchema(schema)).not.toThrow();
      for (const [key, field] of Object.entries(schema.shape)) {
        expect(key).not.toMatch(/org|tenant|workspace/i);
        expect((field as z.ZodType).description, key).toBeTruthy();
      }
    }
  });
  it('drop a key they do not know, so a workspace named by the caller goes nowhere', () => {
    expect(setPoolStatusInput.parse({ id: CAND_ID, status: 'passive', org_id: 'evil' })).toEqual({ id: CAND_ID, status: 'passive' });
    expect(moveToPipelineInput.parse({ id: CAND_ID, job_id: JOB_ID, org_id: 'evil' })).toEqual({ id: CAND_ID, job_id: JOB_ID });
  });
  it('tell the model what each status means, and when to set the switch', () => {
    const status = setPoolStatusInput.shape.status.description ?? '';
    expect(status).toContain('open to hearing about a role now');
    expect(status).toContain('none removes them from the pool; they stay on file');
    expect(setPoolStatusInput.shape.only_if_outside.description).toBe(
      'Set true when ADDING someone to the pool: it is then refused, changing nothing, if they are already in it. '
      + 'Leave out when changing the status of someone already in the pool, or removing them.',
    );
    expect(setPoolStatusInput.shape.id.description).toBe('The candidate\'s id, from listCandidates or listTalentPool.');
    expect(moveToPipelineInput.shape.job_id.description).toBe('The job to add an application for, from listJobs. It must be open or paused.');
  });
});

describe('setPoolStatus', () => {
  const OK = { word: 'ok', from: 'none', to: 'available' };
  it('sends exactly the SQL argument names, and the switch as a real boolean', async () => {
    const add = candFake({ answer: OK });
    await setPoolStatus(add.ctx, { id: CAND_ID, status: 'available', only_if_outside: true });
    expect(add.calls).toEqual([{ fn: 'hire_set_pool_status', args: { p_candidate_id: CAND_ID, p_status: 'available', p_only_if_outside: true } }]);
    const change = candFake({ answer: { word: 'ok', from: 'available', to: 'passive' } });
    await setPoolStatus(change.ctx, { id: CAND_ID, status: 'passive' });
    expect(change.calls[0].args).toEqual({ p_candidate_id: CAND_ID, p_status: 'passive', p_only_if_outside: false });
  });
  it('never sends a workspace the caller named', async () => {
    const f = candFake({ answer: OK });
    await setPoolStatus(f.ctx, { id: CAND_ID, status: 'available', org_id: 'evil' } as never);
    expect(JSON.stringify(f.calls)).not.toContain('evil');
  });
  it('refuses a bad input without calling the database', async () => {
    const f = candFake();
    expect((await setPoolStatus(f.ctx, { id: CAND_ID, status: 'shortlisted' } as never)).ok).toBe(false);
    expect((await setPoolStatus(f.ctx, { id: 'nope', status: 'available' })).ok).toBe(false);
    expect(f.calls).toEqual([]);
  });
  it('answers with the name, where they were, where they are now and the sentence', async () => {
    const f = candFake({ answer: OK, name: 'Aina Rahman' });
    expect(await setPoolStatus(f.ctx, { id: CAND_ID, status: 'available', only_if_outside: true })).toEqual({
      ok: true,
      data: { id: CAND_ID, name: 'Aina Rahman', from: 'none', to: 'available', message: 'Added Aina Rahman to the talent pool as Available.' },
    });
    expect(f.reads).toEqual([{ table: 'hire_candidates', filters: { id: CAND_ID, org_id: ORG } }]);
    expect(await setPoolStatus(candFake({ answer: { word: 'ok', from: 'available', to: 'passive' } }).ctx, { id: CAND_ID, status: 'passive' }))
      .toMatchObject({ ok: true, data: { from: 'available', to: 'passive', message: 'Aina is now marked Passive.' } });
    expect(await setPoolStatus(candFake({ answer: { word: 'ok', from: 'passive', to: 'none' } }).ctx, { id: CAND_ID, status: 'none' }))
      .toMatchObject({ ok: true, data: { to: 'none', message: 'Removed Aina from the talent pool. They are still on file.' } });
  });
  it('is still a success when the name cannot be read back, or the answer says nothing of where they were', async () => {
    expect(await setPoolStatus(candFake({ answer: OK, readThrows: true }).ctx, { id: CAND_ID, status: 'available', only_if_outside: true }))
      .toEqual({ ok: true, data: { id: CAND_ID, name: '', from: 'none', to: 'available', message: 'Added to the talent pool as Available.' } });
    expect(await setPoolStatus(candFake({ answer: OK, name: null }).ctx, { id: CAND_ID, status: 'available' })).toMatchObject({ ok: true, data: { name: '' } });
    // No `from` in the answer: an add was an add, anything else says only where they are now.
    expect(await setPoolStatus(candFake({ answer: { word: 'ok' } }).ctx, { id: CAND_ID, status: 'passive', only_if_outside: true }))
      .toMatchObject({ ok: true, data: { from: 'none', to: 'passive', message: 'Added Aina to the talent pool as Passive.' } });
    expect(await setPoolStatus(candFake({ answer: { word: 'ok' } }).ctx, { id: CAND_ID, status: 'passive' }))
      .toMatchObject({ ok: true, data: { from: null, to: 'passive', message: 'Aina is now marked Passive.' } });
  });
  it('maps each refusal word to its sentence, with the name and the status where the sentence has them', async () => {
    const cases: [unknown, Record<string, unknown>, string][] = [
      [{ word: 'not_found' }, { status: 'passive' }, 'That candidate could not be found.'],
      [{ word: 'forbidden' }, { status: 'passive' }, 'You do not have permission to make changes here.'],
      [{ word: 'invalid_status' }, { status: 'passive' }, 'Choose Available, Passive or Re-engaged.'],
      [{ word: 'already_in_pool', from: 'passive' }, { status: 'available', only_if_outside: true }, 'Aina is already in the talent pool as Passive. Nothing was changed.'],
      [{ word: 'same_status', from: 'passive' }, { status: 'passive' }, 'Aina is already marked Passive. Nothing was changed.'],
      [{ word: 'same_status', from: 'none' }, { status: 'none' }, 'Aina is not in the talent pool. Nothing was changed.'],
      // The answer left `from` out: the status that was asked for is the one they have.
      [{ word: 'same_status' }, { status: 're_engaged' }, 'Aina is already marked Re-engaged. Nothing was changed.'],
      [{ word: 'surprise' }, { status: 'passive' }, GENERIC_SENTENCE],
      [null, { status: 'passive' }, GENERIC_SENTENCE],
    ];
    for (const [answer, input, sentence] of cases) {
      expect(await setPoolStatus(candFake({ answer }).ctx, { id: CAND_ID, ...input } as never), JSON.stringify(answer)).toEqual({ ok: false, error: sentence });
    }
  });
  it('gives the generic sentence and logs only a code on an rpc error and on a throw', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = await setPoolStatus(candFake({ error: { code: '42501', message: 'Aina secret', details: CAND_ID } }).ctx, { id: CAND_ID, status: 'passive' });
    expect(e).toEqual({ ok: false, error: GENERIC_SENTENCE });
    expect(spy).toHaveBeenCalledWith('[hire-capability] setPoolStatus failed:', { code: '42501' });
    await setPoolStatus(candFake({ throws: new TypeError('Aina fetch failed') }).ctx, { id: CAND_ID, status: 'passive' });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] setPoolStatus failed:', { code: 'TypeError' });
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/Aina|55555555/);
    spy.mockRestore();
  });
});

describe('moveToPipeline', () => {
  const MOVED = { word: 'ok', application_id: APP_ID, from: 'available', to: 're_engaged' };
  it('sends exactly the SQL argument names', async () => {
    const f = candFake({ answer: MOVED });
    await moveToPipeline(f.ctx, { id: CAND_ID, job_id: JOB_ID });
    expect(f.calls).toEqual([{ fn: 'hire_move_to_pipeline', args: { p_candidate_id: CAND_ID, p_job_id: JOB_ID } }]);
  });
  it('refuses a bad input without calling the database', async () => {
    const f = candFake();
    expect((await moveToPipeline(f.ctx, { id: CAND_ID, job_id: 'nope' })).ok).toBe(false);
    expect(f.calls).toEqual([]);
  });
  it('answers with the person, the job, the new application and the sentence', async () => {
    const f = candFake({ answer: MOVED, name: 'Aina Rahman', title: 'Barista' });
    expect(await moveToPipeline(f.ctx, { id: CAND_ID, job_id: JOB_ID })).toEqual({
      ok: true,
      data: {
        id: CAND_ID, name: 'Aina Rahman', application_id: APP_ID, job_id: JOB_ID, job: 'Barista', from: 'available', to: 're_engaged',
        message: 'Aina Rahman now has an application for Barista at Applied, and is marked Re-engaged.',
      },
    });
    expect(f.reads).toEqual([
      { table: 'hire_candidates', filters: { id: CAND_ID, org_id: ORG } },
      { table: 'hire_jobs', filters: { id: JOB_ID, org_id: ORG } },
    ]);
  });
  it('is still a success when nothing can be read back', async () => {
    expect(await moveToPipeline(candFake({ answer: MOVED, readThrows: true }).ctx, { id: CAND_ID, job_id: JOB_ID })).toEqual({
      ok: true,
      data: {
        id: CAND_ID, name: '', application_id: APP_ID, job_id: JOB_ID, job: null, from: 'available', to: 're_engaged',
        message: 'Added an application for the job at Applied, and marked them Re-engaged.',
      },
    });
    expect(await moveToPipeline(candFake({ answer: { word: 'ok' } }).ctx, { id: CAND_ID, job_id: JOB_ID }))
      .toMatchObject({ ok: true, data: { application_id: null, from: null, to: 're_engaged' } });
  });
  it('maps each refusal word to its sentence', async () => {
    const cases: [unknown, string][] = [
      [{ word: 'not_found' }, 'That candidate could not be found.'],
      [{ word: 'forbidden' }, 'You do not have permission to make changes here.'],
      [{ word: 'job_not_found' }, 'That job could not be found.'],
      [{ word: 'job_not_open' }, 'Only an open or paused job can take a new application.'],
      [{ word: 'not_in_pool' }, 'Aina is not in the talent pool. Add them to the pool first.'],
      [{ word: 'already_applied', application_id: APP_ID, outcome: 'active' }, 'Aina has already applied for Barista. Nothing was changed.'],
      [{ word: 'already_applied', application_id: APP_ID, outcome: 'rejected' }, 'Aina already has a rejected application for Barista. Reopen it from Applications. Nothing was changed.'],
      [{ word: 'already_applied', application_id: APP_ID, outcome: 'withdrawn' }, 'Aina already has a withdrawn application for Barista. Reopen it from Applications. Nothing was changed.'],
      [{ word: 'surprise' }, GENERIC_SENTENCE],
      [null, GENERIC_SENTENCE],
    ];
    for (const [answer, sentence] of cases) {
      expect(await moveToPipeline(candFake({ answer }).ctx, { id: CAND_ID, job_id: JOB_ID }), JSON.stringify(answer)).toEqual({ ok: false, error: sentence });
    }
  });
  it('gives the generic sentence and logs only a code on an rpc error and on a throw', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await moveToPipeline(candFake({ error: { code: '40P01', message: 'Aina deadlock' } }).ctx, { id: CAND_ID, job_id: JOB_ID }))
      .toEqual({ ok: false, error: GENERIC_SENTENCE });
    expect(spy).toHaveBeenCalledWith('[hire-capability] moveToPipeline failed:', { code: '40P01' });
    await moveToPipeline(candFake({ throws: new TypeError('Aina fetch failed') }).ctx, { id: CAND_ID, job_id: JOB_ID });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] moveToPipeline failed:', { code: 'TypeError' });
    spy.mockRestore();
  });
});

// ─── interviews ──────────────────────────────────────────────────────────────

const IV_ID = '77777777-7777-4777-8777-777777777777';
/** The read-back: no notes (they are not part of the answer), and the application's stage and outcome with the two names. */
const IV_READ = 'id,application_id,scheduled_at,duration_minutes,kind,place,interviewer_name,status,created_at,updated_at,'
  + 'application:hire_applications(stage,outcome,candidate:hire_candidates(name),job:hire_jobs(title))';
/** 3:00 pm on Tuesday 20 October 2026 in Kuala Lumpur, as the database writes it. */
const IV_ROW = {
  id: IV_ID, application_id: APP_ID, scheduled_at: '2026-10-20T07:00:00+00:00', duration_minutes: 60, kind: 'video',
  place: 'https://meet.example.com/abc', interviewer_name: 'Farah Lim', status: 'scheduled',
  created_at: '2026-10-11T04:00:00+00:00', updated_at: '2026-10-11T04:00:00+00:00',
  application: { stage: 'screening', outcome: 'active', candidate: { name: 'Aina Rahman' }, job: { title: 'Sales Executive' } },
};
const SCHEDULE = { application_id: APP_ID, date: '2026-10-20', time: '15:00', kind: 'video' } as const;
const HELD = { application_id: APP_ID, date: '2026-10-06', time: '15:00', kind: 'video', outcome: 'completed' } as const;
const INVITE = [
  'Hi Aina Rahman,',
  '',
  'You are invited to an interview for the Sales Executive role at Rimba Ventures.',
  '',
  'Date: Tuesday, 20 October 2026',
  'Time: 3:00 pm to 4:00 pm, Kuala Lumpur time (GMT+8)',
  'Length: 1 hour',
  'Type: Video call',
  'Link: https://meet.example.com/abc',
  'With: Farah Lim',
  '',
  'Please reply to confirm, or tell us if you need another time.',
].join('\n');
const NOT_READ = 'Saved. The interview could not be read back, so some details are not shown.';
const IN_PAST = 'That time has already passed in Kuala Lumpur. Choose a later one, or use “Record a past interview” if it already took place.';

/** A client whose rpc answers `answer` and whose read-back answers `row`; it writes down both. */
function ivFake(opts: { answer?: unknown; error?: unknown; throws?: unknown; row?: unknown; readThrows?: boolean; orgName?: string | null } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const reads: { table: string; columns: string; filters: Record<string, unknown> }[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (opts.throws) throw opts.throws;
      return { data: 'answer' in opts ? opts.answer : { word: 'ok', id: IV_ID }, error: opts.error ?? null };
    },
    from: (table: string) => {
      const entry = { table, columns: '', filters: {} as Record<string, unknown> };
      reads.push(entry);
      const chain = {
        select: (columns: string) => { entry.columns = columns; return chain; },
        eq: (k: string, v: unknown) => { entry.filters[k] = v; return chain; },
        maybeSingle: async () => {
          if (opts.readThrows) throw new Error('Aina read failed');
          return { data: 'row' in opts ? opts.row : IV_ROW, error: null };
        },
      };
      return chain;
    },
  };
  const ctx: HireWriteContext = { client: client as never, orgId: ORG, ...(opts.orgName === null ? {} : { orgName: opts.orgName ?? 'Rimba Ventures' }) };
  return { ctx, calls, reads };
}

describe('interview schemas', () => {
  const ALL = [scheduleInterviewInput, recordPastInterviewInput, rescheduleInterviewInput, cancelInterviewInput, setInterviewOutcomeInput, reopenInterviewInput];
  it('convert to JSON Schema, describe every field and carry no workspace key', () => {
    for (const schema of ALL) {
      // A transform or a preprocess cannot be converted: this is what keeps the schemas plain.
      expect(z.toJSONSchema(schema)).toMatchObject({ type: 'object' });
      for (const [key, field] of Object.entries(schema.shape)) {
        expect(key).not.toMatch(/org|tenant|workspace/i);
        expect((field as z.ZodType).description, key).toBeTruthy();
      }
    }
  });
  it('have exactly these fields', () => {
    expect(Object.keys(scheduleInterviewInput.shape)).toEqual(['application_id', 'date', 'time', 'duration_minutes', 'kind', 'place', 'interviewer_name', 'notes']);
    expect(Object.keys(recordPastInterviewInput.shape)).toEqual(['application_id', 'date', 'time', 'duration_minutes', 'kind', 'outcome', 'place', 'interviewer_name', 'notes']);
    expect(Object.keys(rescheduleInterviewInput.shape)).toEqual(['id', 'date', 'time', 'duration_minutes', 'kind', 'place', 'interviewer_name', 'notes']);
    expect(Object.keys(cancelInterviewInput.shape)).toEqual(['id']);
    expect(Object.keys(setInterviewOutcomeInput.shape)).toEqual(['id', 'outcome']);
    expect(Object.keys(reopenInterviewInput.shape)).toEqual(['id']);
  });
  it('need the type, with no default, and give a new interview 60 minutes', () => {
    expect(scheduleInterviewInput.safeParse({ application_id: APP_ID, date: '2026-10-20', time: '15:00' }).success).toBe(false);
    expect(recordPastInterviewInput.safeParse({ application_id: APP_ID, date: '2026-10-06', time: '15:00', outcome: 'completed' }).success).toBe(false);
    expect(scheduleInterviewInput.parse(SCHEDULE)).toEqual({ ...SCHEDULE, duration_minutes: 60 });
    expect(recordPastInterviewInput.parse(HELD)).toEqual({ ...HELD, duration_minutes: 60 });
    // A change has no default length: a default would be sent as a change.
    expect(rescheduleInterviewInput.parse({ id: IV_ID })).toEqual({ id: IV_ID });
  });
  it('drop a key they do not know, so a workspace or a "last seen" time named by the caller goes nowhere', () => {
    expect(scheduleInterviewInput.parse({ ...SCHEDULE, org_id: 'evil', status: 'completed' })).toEqual({ ...SCHEDULE, duration_minutes: 60 });
    expect(rescheduleInterviewInput.parse({ id: IV_ID, seen: '2026-10-11T04:00:00+00:00', p_if_updated_at: 'x', org_id: 'evil' })).toEqual({ id: IV_ID });
    expect(cancelInterviewInput.parse({ id: IV_ID, org_id: 'evil' })).toEqual({ id: IV_ID });
  });
  it('take a date as YYYY-MM-DD and a time as HH:MM, and say what is wrong with another shape', () => {
    const said = (input: Record<string, unknown>) => scheduleInterviewInput.safeParse({ ...SCHEDULE, ...input }).error?.issues[0]?.message;
    for (const date of ['20/10/2026', '2026-10-2', 'next Tuesday', '2026-10-20T15:00:00+08:00', '']) {
      expect(said({ date }), date).toBe('Use a real date, like 2026-10-31.');
    }
    for (const time of ['3pm', '9:5', '24:00', '15:60', '15:00:00', '07:00Z', '']) {
      expect(said({ time }), time).toBe('Give the time as HH:MM in 24-hour form, like 15:00.');
    }
    expect(rescheduleInterviewInput.safeParse({ id: IV_ID, time: '3pm' }).error?.issues[0]?.message).toBe('Give the time as HH:MM in 24-hour form, like 15:00.');
  });
  it('hold the length, the place, the interviewer and the notes to their limits, in the form\'s words', () => {
    const said = (input: Record<string, unknown>) => scheduleInterviewInput.safeParse({ ...SCHEDULE, ...input }).error?.issues[0]?.message;
    for (const duration_minutes of [14, 481, 0, -60, 60.5]) {
      expect(said({ duration_minutes }), String(duration_minutes)).toBe('Choose a length between 15 minutes and 8 hours.');
    }
    for (const duration_minutes of [15, 60, 75, 480]) expect(scheduleInterviewInput.safeParse({ ...SCHEDULE, duration_minutes }).success).toBe(true);
    expect(said({ place: 'x'.repeat(301) })).toBe('Keep this under 300 characters.');
    expect(said({ interviewer_name: 'x'.repeat(121) })).toBe('Keep the interviewer\'s name under 120 characters.');
    expect(said({ notes: 'x'.repeat(2001) })).toBe('Keep the notes under 2,000 characters.');
    expect(scheduleInterviewInput.safeParse({ ...SCHEDULE, place: 'x'.repeat(300), interviewer_name: 'x'.repeat(120), notes: 'x'.repeat(2000) }).success).toBe(true);
    expect(rescheduleInterviewInput.safeParse({ id: IV_ID, duration_minutes: 481 }).error?.issues[0]?.message).toBe('Choose a length between 15 minutes and 8 hours.');
  });
  it('take only the three types and the two outcomes', () => {
    for (const kind of ['zoom', 'Video', '', null]) expect(scheduleInterviewInput.safeParse({ ...SCHEDULE, kind }).success, String(kind)).toBe(false);
    for (const kind of ['video', 'onsite', 'phone']) expect(scheduleInterviewInput.safeParse({ ...SCHEDULE, kind }).success, kind).toBe(true);
    for (const outcome of ['cancelled', 'scheduled', 'Completed', '', null]) {
      expect(setInterviewOutcomeInput.safeParse({ id: IV_ID, outcome }).success, String(outcome)).toBe(false);
      expect(recordPastInterviewInput.safeParse({ ...HELD, outcome }).success, String(outcome)).toBe(false);
    }
    for (const outcome of ['completed', 'no_show']) {
      expect(setInterviewOutcomeInput.safeParse({ id: IV_ID, outcome }).success).toBe(true);
      expect(recordPastInterviewInput.safeParse({ ...HELD, outcome }).success).toBe(true);
    }
  });
  it('answer a made-up interview id with where a real one comes from', () => {
    expect(NOT_AN_INTERVIEW_ID).toBe('That is not an interview\'s id. Look the interview up with listInterviews and use the id it returns. Never make one up.');
    for (const schema of [rescheduleInterviewInput, cancelInterviewInput, reopenInterviewInput]) {
      expect(schema.safeParse({ id: 'interview-7' }).error?.issues[0]?.message).toBe(NOT_AN_INTERVIEW_ID);
    }
    expect(setInterviewOutcomeInput.safeParse({ id: 'interview-7', outcome: 'completed' }).error?.issues[0]?.message).toBe(NOT_AN_INTERVIEW_ID);
  });
  it('tell the model where each value comes from, and never to make one up', () => {
    const s = scheduleInterviewInput.shape;
    expect(s.application_id.description).toBe('The application\'s id, from listApplications.');
    expect(s.date.description).toBe('The day, as YYYY-MM-DD, in Kuala Lumpur.');
    expect(s.time.description).toBe('The start, as HH:MM in 24-hour form, in Kuala Lumpur time: 3 pm is 15:00.');
    expect(s.duration_minutes.description).toBe('How long it lasts, in whole minutes from 15 to 480. Leave out for 60.');
    expect(s.kind.description).toBe('How it is held: video, onsite or phone. Ask the user when it was not given: never pick one.');
    expect(s.place.description).toBe('Where it is held or the meeting link, exactly as the user gave it. Leave out when none was given: never make one up.');
    expect(s.interviewer_name.description).toBe('Who interviews, exactly as the user gave it. Leave out when none was given.');
    expect(s.notes.description).toBe('Notes for the team. Never shown to the candidate.');
    const p = recordPastInterviewInput.shape;
    expect(p.date.description).toBe('The day it took place, as YYYY-MM-DD, in Kuala Lumpur.');
    expect(p.time.description).toBe('When it started, as HH:MM in 24-hour form, in Kuala Lumpur time: 3 pm is 15:00.');
    expect(p.outcome.description).toBe('What happened: completed when it took place, no_show when the candidate did not turn up.');
    expect(p.place.description).toBe(s.place.description);
    const c = rescheduleInterviewInput.shape;
    expect(c.id.description).toBe('The interview\'s id, from listInterviews.');
    expect(c.date.description).toBe('The new day, as YYYY-MM-DD, in Kuala Lumpur. Send only what changes: leave it out to keep the time, and never send it without the time.');
    expect(c.time.description).toBe('The new start, as HH:MM in 24-hour form, in Kuala Lumpur time: 3 pm is 15:00. Send only what changes, and never without the date.');
    expect(c.duration_minutes.description).toBe('The new length, in whole minutes from 15 to 480. Send only what changes.');
    expect(c.kind.description).toBe('The new type: video, onsite or phone. Send only what changes.');
    expect(c.place.description).toBe('The new place or meeting link, exactly as the user gave it: never make one up. Send only what changes. Blank clears it.');
    expect(c.interviewer_name.description).toBe('Who interviews now, exactly as the user gave it. Send only what changes. Blank clears it.');
    expect(c.notes.description).toBe('The new notes for the team, in place of the old ones. Never shown to the candidate. Send only what changes. Blank clears them.');
    expect(setInterviewOutcomeInput.shape.outcome.description).toBe('completed when the interview took place; no_show when the candidate did not turn up.');
  });
});

describe('scheduleInterview', () => {
  it('sends exactly the SQL argument names, the instant as +08:00, and nulls for what was not given', async () => {
    const f = ivFake();
    await scheduleInterview(f.ctx, SCHEDULE, NOW);
    expect(f.calls).toEqual([{
      fn: 'hire_schedule_interview',
      args: {
        p_application_id: APP_ID, p_scheduled_at: '2026-10-20T15:00:00+08:00', p_duration_minutes: 60, p_kind: 'video',
        p_place: null, p_interviewer_name: null, p_notes: null,
      },
    }]);
    // The instant is 07:00 UTC whatever zone the server is in.
    expect(Date.parse(f.calls[0].args.p_scheduled_at as string)).toBe(Date.UTC(2026, 9, 20, 7, 0));
  });
  it('sends what was given, trimmed, and a blank as null', async () => {
    const f = ivFake();
    await scheduleInterview(f.ctx, {
      ...SCHEDULE, time: '09:30', duration_minutes: 45, kind: 'onsite', place: '  Level 3, Menara Rimba ', interviewer_name: 'Farah Lim', notes: '   ',
    }, NOW);
    expect(f.calls[0].args).toEqual({
      p_application_id: APP_ID, p_scheduled_at: '2026-10-20T09:30:00+08:00', p_duration_minutes: 45, p_kind: 'onsite',
      p_place: 'Level 3, Menara Rimba', p_interviewer_name: 'Farah Lim', p_notes: null,
    });
  });
  it('never sends a workspace the caller named', async () => {
    const f = ivFake();
    await scheduleInterview(f.ctx, { ...SCHEDULE, org_id: 'evil' } as never, NOW);
    expect(JSON.stringify(f.calls)).not.toMatch(/evil|org_id/);
  });
  it('refuses a made-up id, an unreal date and a time outside the limits before any call', async () => {
    const f = ivFake();
    const cases: [Record<string, unknown>, string][] = [
      [{ application_id: 'application-12' }, 'That is not an application\'s id. Look it up with listApplications and use the id it returns. Never make one up.'],
      [{ date: '2026-02-31' }, 'Use a real date, like 2026-10-31.'],
      [{ date: '2027-02-29' }, 'Use a real date, like 2026-10-31.'],
      // NOW is 12:00 on 11 October: 11:00 that day is an hour ago, and 13 October 2027 is 367 days ahead.
      [{ date: '2026-10-11', time: '11:00' }, IN_PAST],
      [{ date: '2026-10-10', time: '23:59' }, IN_PAST],
      [{ date: '2027-10-13' }, 'Choose a date within the next 12 months.'],
    ];
    for (const [over, error] of cases) {
      expect(await scheduleInterview(f.ctx, { ...SCHEDULE, ...over } as never, NOW), JSON.stringify(over)).toEqual({ ok: false, error });
    }
    expect((await scheduleInterview(f.ctx, { ...SCHEDULE, kind: undefined } as never, NOW)).ok).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.reads).toEqual([]);
  });
  it('lets a time up to five minutes ago, and one 366 days ahead, through to the database', async () => {
    const f = ivFake();
    expect((await scheduleInterview(f.ctx, { ...SCHEDULE, date: '2026-10-11', time: '11:57' }, NOW)).ok).toBe(true);
    expect((await scheduleInterview(f.ctx, { ...SCHEDULE, date: '2027-10-12', time: '12:00' }, NOW)).ok).toBe(true);
    expect(f.calls).toHaveLength(2);
  });
  it('answers with the row as read back, the sentence and the invitation', async () => {
    const f = ivFake();
    expect(await scheduleInterview(f.ctx, SCHEDULE, NOW)).toEqual({
      ok: true,
      data: {
        id: IV_ID, application_id: APP_ID, candidate: 'Aina Rahman', job: 'Sales Executive',
        application_stage: 'screening', application_outcome: 'active',
        scheduled_at: '2026-10-20T07:00:00+00:00', date: '2026-10-20', time: '15:00', duration_minutes: 60, kind: 'video',
        place: 'https://meet.example.com/abc', interviewer_name: 'Farah Lim', status: 'scheduled',
        created_at: '2026-10-11T04:00:00+00:00', updated_at: '2026-10-11T04:00:00+00:00',
        message: 'Scheduled an interview with Aina Rahman for Tuesday, 20 October 2026, 3:00 pm. Nothing has been sent to them.',
        invitation: INVITE, confirmed: true,
      },
    });
    // Read with the member's own client, by the new id and the workspace of the session.
    expect(f.reads).toEqual([{ table: 'hire_interviews', columns: IV_READ, filters: { id: IV_ID, org_id: ORG } }]);
  });
  it('leaves the workspace out of the invitation when the context has no name for it', async () => {
    const result = await scheduleInterview(ivFake({ orgName: null }).ctx, SCHEDULE, NOW);
    expect(result.ok && result.data.invitation?.split('\n')[2]).toBe('You are invited to an interview for the Sales Executive role.');
    const blank = await scheduleInterview(ivFake({ orgName: '  ' }).ctx, SCHEDULE, NOW);
    expect(blank.ok && blank.data.invitation?.split('\n')[2]).toBe('You are invited to an interview for the Sales Executive role.');
  });
  it('is still a success when the row cannot be read back: only what the input says, a note, and no invitation', async () => {
    const expected = {
      ok: true,
      data: {
        id: IV_ID, application_id: APP_ID, candidate: '', job: '', application_stage: null, application_outcome: null,
        scheduled_at: '2026-10-20T15:00:00+08:00', date: '2026-10-20', time: '15:00', duration_minutes: 60, kind: 'video',
        place: null, interviewer_name: null, status: 'scheduled', created_at: null, updated_at: null,
        message: 'Scheduled an interview with the candidate for Tuesday, 20 October 2026, 3:00 pm. Nothing has been sent to them.',
        invitation: null, confirmed: false, note: NOT_READ,
      },
    };
    expect(await scheduleInterview(ivFake({ row: null }).ctx, SCHEDULE, NOW)).toEqual(expected);
    expect(await scheduleInterview(ivFake({ readThrows: true }).ctx, SCHEDULE, NOW)).toEqual(expected);
  });
  it('gives no invitation when the row came back without its candidate or job', async () => {
    const result = await scheduleInterview(ivFake({ row: { ...IV_ROW, application: null } }).ctx, SCHEDULE, NOW);
    expect(result).toMatchObject({ ok: true, data: { candidate: '', job: '', application_stage: null, application_outcome: null, invitation: null, confirmed: true } });
  });
  it('maps each word to its sentence', async () => {
    const cases: [unknown, string][] = [
      [{ word: 'not_found' }, 'That application could not be found. It may have been deleted.'],
      [{ word: 'forbidden' }, 'You do not have permission to make changes here.'],
      [{ word: 'not_active' }, 'This application is no longer active. Reopen it before scheduling or changing an interview.'],
      [{ word: 'in_past' }, IN_PAST],
      [{ word: 'too_far_ahead' }, 'Choose a date within the next 12 months.'],
      [{ word: 'duplicate' }, 'This application already has an interview at that time.'],
      [{ word: 'invalid_time' }, GENERIC_SENTENCE],
      [{ word: 'invalid_duration' }, GENERIC_SENTENCE],
      [{ word: 'invalid_kind' }, GENERIC_SENTENCE],
      [{ word: 'invalid_place' }, GENERIC_SENTENCE],
      [{ word: 'invalid_interviewer' }, GENERIC_SENTENCE],
      [{ word: 'invalid_notes' }, GENERIC_SENTENCE],
      [{ word: 'surprise' }, GENERIC_SENTENCE],
      ['not_found', 'That application could not be found. It may have been deleted.'],
      [null, GENERIC_SENTENCE],
      [{}, GENERIC_SENTENCE],
    ];
    for (const [answer, error] of cases) {
      const f = ivFake({ answer });
      expect(await scheduleInterview(f.ctx, SCHEDULE, NOW), JSON.stringify(answer)).toEqual({ ok: false, error });
      expect(f.reads).toEqual([]);
    }
  });
  it('does not call it a success when the answer says ok but carries no id', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await scheduleInterview(ivFake({ answer: { word: 'ok' } }).ctx, SCHEDULE, NOW)).toEqual({ ok: false, error: GENERIC_SENTENCE });
    expect(await scheduleInterview(ivFake({ answer: 'ok' }).ctx, SCHEDULE, NOW)).toEqual({ ok: false, error: GENERIC_SENTENCE });
    spy.mockRestore();
  });
  it('gives the generic sentence and logs only a code on an rpc error and on a throw', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const input = { ...SCHEDULE, place: 'https://meet.example.com/abc', interviewer_name: 'Farah Lim', notes: 'Salary talk' };
    expect(await scheduleInterview(ivFake({ error: { code: '42501', message: 'Aina secret', details: APP_ID } }).ctx, input, NOW))
      .toEqual({ ok: false, error: GENERIC_SENTENCE });
    expect(spy).toHaveBeenCalledWith('[hire-capability] scheduleInterview failed:', { code: '42501' });
    expect(await scheduleInterview(ivFake({ throws: new TypeError('Aina fetch failed') }).ctx, input, NOW)).toEqual({ ok: false, error: GENERIC_SENTENCE });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] scheduleInterview failed:', { code: 'TypeError' });
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/Aina|Farah|meet\.example|Salary|66666666/);
    spy.mockRestore();
  });
});

describe('recordPastInterview', () => {
  const HELD_ROW = { ...IV_ROW, scheduled_at: '2026-10-06T07:00:00+00:00', status: 'completed', application: { ...IV_ROW.application, outcome: 'rejected' } };
  it('sends exactly the SQL argument names, with what happened', async () => {
    const f = ivFake({ row: HELD_ROW });
    await recordPastInterview(f.ctx, HELD, NOW);
    expect(f.calls).toEqual([{
      fn: 'hire_record_past_interview',
      args: {
        p_application_id: APP_ID, p_scheduled_at: '2026-10-06T15:00:00+08:00', p_duration_minutes: 60, p_kind: 'video', p_outcome: 'completed',
        p_place: null, p_interviewer_name: null, p_notes: null,
      },
    }]);
    const g = ivFake({ row: HELD_ROW });
    await recordPastInterview(g.ctx, { ...HELD, outcome: 'no_show', duration_minutes: 30, kind: 'phone', place: 'We called', interviewer_name: 'Farah Lim', notes: 'No answer twice' }, NOW);
    expect(g.calls[0].args).toEqual({
      p_application_id: APP_ID, p_scheduled_at: '2026-10-06T15:00:00+08:00', p_duration_minutes: 30, p_kind: 'phone', p_outcome: 'no_show',
      p_place: 'We called', p_interviewer_name: 'Farah Lim', p_notes: 'No answer twice',
    });
  });
  it('refuses a time that has not passed, one too far back, a missing outcome and a made-up id before any call', async () => {
    const f = ivFake();
    const cases: [Record<string, unknown>, string][] = [
      // NOW is 12:00 on 11 October 2026: 12:01 is ahead, and 9 October 2025 is 367 days back.
      [{ date: '2026-10-11', time: '12:01' }, 'That time has not passed yet in Kuala Lumpur. To plan an interview, use “Schedule interview”.'],
      [{ date: '2026-10-20' }, 'That time has not passed yet in Kuala Lumpur. To plan an interview, use “Schedule interview”.'],
      [{ date: '2025-10-09' }, 'Choose a date within the last 12 months.'],
      [{ date: '2026-02-30' }, 'Use a real date, like 2026-10-31.'],
      [{ outcome: undefined }, 'Choose what happened.'],
      [{ outcome: 'cancelled' }, 'Choose what happened.'],
      [{ application_id: 'application-12' }, 'That is not an application\'s id. Look it up with listApplications and use the id it returns. Never make one up.'],
    ];
    for (const [over, error] of cases) {
      expect(await recordPastInterview(f.ctx, { ...HELD, ...over } as never, NOW), JSON.stringify(over)).toEqual({ ok: false, error });
    }
    expect(f.calls).toEqual([]);
  });
  it('takes a start that is exactly now, and one 366 days back', async () => {
    const f = ivFake({ row: HELD_ROW });
    expect((await recordPastInterview(f.ctx, { ...HELD, date: '2026-10-11', time: '12:00' }, NOW)).ok).toBe(true);
    expect((await recordPastInterview(f.ctx, { ...HELD, date: '2025-10-10', time: '12:00' }, NOW)).ok).toBe(true);
    expect(f.calls).toHaveLength(2);
  });
  it('answers with the row and the sentence, and never an invitation', async () => {
    const result = await recordPastInterview(ivFake({ row: HELD_ROW }).ctx, HELD, NOW);
    expect(result).toMatchObject({
      ok: true,
      data: {
        id: IV_ID, candidate: 'Aina Rahman', job: 'Sales Executive', application_outcome: 'rejected', status: 'completed',
        date: '2026-10-06', time: '15:00',
        message: 'Recorded a completed interview with Aina Rahman on Tuesday, 6 October 2026, 3:00 pm. No invitation was made.',
        invitation: null, confirmed: true,
      },
    });
    const missed = await recordPastInterview(ivFake({ row: { ...HELD_ROW, status: 'no_show' } }).ctx, { ...HELD, outcome: 'no_show' }, NOW);
    expect(missed).toMatchObject({ ok: true, data: { status: 'no_show', message: 'Recorded a no-show for the interview with Aina Rahman on Tuesday, 6 October 2026, 3:00 pm.', invitation: null } });
  });
  it('gives no invitation even if the row reads as scheduled by the time it is read back', async () => {
    const result = await recordPastInterview(ivFake({ row: { ...HELD_ROW, status: 'scheduled' } }).ctx, HELD, NOW);
    expect(result).toMatchObject({ ok: true, data: { status: 'scheduled', invitation: null } });
  });
  it('is still a success when the row cannot be read back', async () => {
    expect(await recordPastInterview(ivFake({ row: null }).ctx, { ...HELD, outcome: 'no_show' }, NOW)).toEqual({
      ok: true,
      data: {
        id: IV_ID, application_id: APP_ID, candidate: '', job: '', application_stage: null, application_outcome: null,
        scheduled_at: '2026-10-06T15:00:00+08:00', date: '2026-10-06', time: '15:00', duration_minutes: 60, kind: 'video',
        place: null, interviewer_name: null, status: 'no_show', created_at: null, updated_at: null,
        message: 'Recorded a no-show for the interview with the candidate on Tuesday, 6 October 2026, 3:00 pm.',
        invitation: null, confirmed: false, note: NOT_READ,
      },
    });
  });
  it('maps each word to its sentence, and logs only a code on an error or a throw', async () => {
    const cases: [unknown, string][] = [
      [{ word: 'not_found' }, 'That application could not be found. It may have been deleted.'],
      [{ word: 'forbidden' }, 'You do not have permission to make changes here.'],
      [{ word: 'not_past' }, 'That time has not passed yet in Kuala Lumpur. To plan an interview, use “Schedule interview”.'],
      [{ word: 'too_far_back' }, 'Choose a date within the last 12 months.'],
      [{ word: 'duplicate' }, 'This application already has an interview at that time.'],
      [{ word: 'invalid_outcome' }, GENERIC_SENTENCE],
      [{ word: 'surprise' }, GENERIC_SENTENCE],
      [null, GENERIC_SENTENCE],
    ];
    for (const [answer, error] of cases) {
      expect(await recordPastInterview(ivFake({ answer }).ctx, HELD, NOW), JSON.stringify(answer)).toEqual({ ok: false, error });
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await recordPastInterview(ivFake({ error: { code: '40P01', message: 'Aina deadlock' } }).ctx, HELD, NOW)).toEqual({ ok: false, error: GENERIC_SENTENCE });
    expect(spy).toHaveBeenCalledWith('[hire-capability] recordPastInterview failed:', { code: '40P01' });
    await recordPastInterview(ivFake({ throws: new TypeError('Aina fetch failed') }).ctx, HELD, NOW);
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] recordPastInterview failed:', { code: 'TypeError' });
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Aina');
    spy.mockRestore();
  });
});

describe('rescheduleInterview', () => {
  const MOVED_ROW = { ...IV_ROW, scheduled_at: '2026-10-22T03:00:00+00:00', updated_at: '2026-10-11T05:00:00+00:00' };
  it('builds p_changes from only the keys that were sent', async () => {
    const notes = ivFake({ answer: 'ok' });
    await rescheduleInterview(notes.ctx, { id: IV_ID, notes: 'Bring a portfolio' }, NOW);
    expect(notes.calls).toEqual([{ fn: 'hire_reschedule_interview', args: { p_interview_id: IV_ID, p_changes: { notes: 'Bring a portfolio' } } }]);
    const all = ivFake({ answer: 'ok', row: MOVED_ROW });
    await rescheduleInterview(all.ctx, {
      id: IV_ID, date: '2026-10-22', time: '11:00', duration_minutes: 90, kind: 'phone', place: '+60 3-1234 5678', interviewer_name: 'Farah Lim', notes: 'Call the mobile',
    }, NOW);
    expect(all.calls[0].args).toEqual({
      p_interview_id: IV_ID,
      p_changes: {
        scheduled_at: '2026-10-22T11:00:00+08:00', duration_minutes: 90, kind: 'phone', place: '+60 3-1234 5678', interviewer_name: 'Farah Lim', notes: 'Call the mobile',
      },
    });
  });
  it('sends null for a place, an interviewer or notes that were cleared', async () => {
    const f = ivFake({ answer: 'ok' });
    await rescheduleInterview(f.ctx, { id: IV_ID, place: '', interviewer_name: null, notes: '   ' }, NOW);
    expect(f.calls[0].args).toEqual({ p_interview_id: IV_ID, p_changes: { place: null, interviewer_name: null, notes: null } });
  });
  it('passes the time the form last saw the row only when it is given', async () => {
    const without = ivFake({ answer: 'ok' });
    await rescheduleInterview(without.ctx, { id: IV_ID, kind: 'phone' }, NOW);
    expect(without.calls[0].args).toEqual({ p_interview_id: IV_ID, p_changes: { kind: 'phone' } });
    expect(without.calls[0].args).not.toHaveProperty('p_if_updated_at');
    const blank = ivFake({ answer: 'ok' });
    await rescheduleInterview(blank.ctx, { id: IV_ID, kind: 'phone' }, NOW, '');
    expect(blank.calls[0].args).not.toHaveProperty('p_if_updated_at');
    const seen = ivFake({ answer: 'ok' });
    await rescheduleInterview(seen.ctx, { id: IV_ID, kind: 'phone' }, NOW, '2026-10-11T04:00:00+00:00');
    expect(seen.calls[0].args).toEqual({ p_interview_id: IV_ID, p_changes: { kind: 'phone' }, p_if_updated_at: '2026-10-11T04:00:00+00:00' });
    // It is not part of the schema: a model cannot fill it.
    const smuggled = ivFake({ answer: 'ok' });
    await rescheduleInterview(smuggled.ctx, { id: IV_ID, kind: 'phone', seen: '2026-10-11T04:00:00+00:00' } as never, NOW);
    expect(smuggled.calls[0].args).not.toHaveProperty('p_if_updated_at');
  });
  it('refuses a date without a time, a time without a date, an empty change and a made-up id before any call', async () => {
    const f = ivFake({ answer: 'ok' });
    expect(await rescheduleInterview(f.ctx, { id: IV_ID, date: '2026-10-22' }, NOW)).toEqual({ ok: false, error: 'Give the date and the time together.' });
    expect(await rescheduleInterview(f.ctx, { id: IV_ID, time: '11:00', notes: 'x' }, NOW)).toEqual({ ok: false, error: 'Give the date and the time together.' });
    expect(await rescheduleInterview(f.ctx, { id: IV_ID }, NOW)).toEqual({ ok: false, error: 'Nothing was changed: the interview already has these details.' });
    expect(await rescheduleInterview(f.ctx, { id: 'interview-7', notes: 'x' }, NOW)).toEqual({ ok: false, error: NOT_AN_INTERVIEW_ID });
    expect(f.calls).toEqual([]);
  });
  it('refuses a day that does not exist before any call', async () => {
    const f = ivFake({ answer: 'ok' });
    expect(await rescheduleInterview(f.ctx, { id: IV_ID, date: '2026-02-31', time: '11:00' }, NOW)).toEqual({ ok: false, error: 'Use a real date, like 2026-10-31.' });
    expect(f.calls).toEqual([]);
  });
  it('does not judge a time itself: only the database knows whether it is a new time', async () => {
    // NOW is 12:00 on 11 October 2026. An interview that began at 11:00 has its notes changed, and the model sends
    // the unchanged date and time along: that must reach the database, which saves it (the past rule is for a time
    // that changes). A check here would refuse it with "That time has already passed".
    const began = ivFake({ answer: 'ok' });
    expect((await rescheduleInterview(began.ctx, { id: IV_ID, date: '2026-10-11', time: '11:00', notes: 'Ran late' }, NOW)).ok).toBe(true);
    expect(began.calls[0].args).toEqual({ p_interview_id: IV_ID, p_changes: { scheduled_at: '2026-10-11T11:00:00+08:00', notes: 'Ran late' } });
    // When the time really is new and has passed, or is too far off, the database says so and the sentence is its.
    const past = ivFake({ answer: 'in_past' });
    expect(await rescheduleInterview(past.ctx, { id: IV_ID, date: '2026-10-11', time: '09:00' }, NOW)).toEqual({ ok: false, error: IN_PAST });
    expect(past.calls).toHaveLength(1);
    const far = ivFake({ answer: 'too_far_ahead' });
    expect(await rescheduleInterview(far.ctx, { id: IV_ID, date: '2027-10-13', time: '11:00' }, NOW)).toEqual({ ok: false, error: 'Choose a date within the next 12 months.' });
    expect(far.calls).toHaveLength(1);
  });
  it('says the time is new in the invitation only when the database says the stored time moved', async () => {
    const moved = await rescheduleInterview(ivFake({ answer: { word: 'ok', moved: true }, row: MOVED_ROW }).ctx, { id: IV_ID, date: '2026-10-22', time: '11:00' }, NOW);
    expect(moved).toMatchObject({
      ok: true,
      data: {
        id: IV_ID, scheduled_at: '2026-10-22T03:00:00+00:00', date: '2026-10-22', time: '11:00', updated_at: '2026-10-11T05:00:00+00:00', status: 'scheduled',
        message: 'Updated the interview with Aina Rahman. It is on Thursday, 22 October 2026, 11:00 am. Nothing has been sent to them.',
        confirmed: true,
      },
    });
    expect(moved.ok && moved.data.invitation).toBe([
      'Hi Aina Rahman,',
      '',
      'Your interview for the Sales Executive role at Rimba Ventures has a new time.',
      '',
      'Date: Thursday, 22 October 2026',
      'Time: 11:00 am to 12:00 pm, Kuala Lumpur time (GMT+8)',
      'Length: 1 hour',
      'Type: Video call',
      'Link: https://meet.example.com/abc',
      'With: Farah Lim',
      '',
      'Please reply to confirm, or tell us if you need another time.',
    ].join('\n'));
    const edited = await rescheduleInterview(ivFake({ answer: 'ok' }).ctx, { id: IV_ID, notes: 'Bring a portfolio' }, NOW);
    expect(edited).toMatchObject({
      ok: true,
      data: { message: 'Updated the interview with Aina Rahman. It is on Tuesday, 20 October 2026, 3:00 pm. Nothing has been sent to them.', invitation: INVITE },
    });
  });
  describe('"has a new time" is the database\'s to say, never the input\'s', () => {
    const NEW_TIME = 'Your interview for the Sales Executive role at Rimba Ventures has a new time.';
    const INVITED = 'You are invited to an interview for the Sales Executive role at Rimba Ventures.';
    const opening = async (answer: unknown, input: Record<string, unknown>, row: unknown = IV_ROW) => {
      const f = ivFake({ answer, row });
      const result = await rescheduleInterview(f.ctx, { id: IV_ID, ...input } as never, NOW);
      expect(result.ok, JSON.stringify(answer)).toBe(true);
      expect(f.calls).toHaveLength(1);
      return result.ok ? result.data.invitation?.split('\n')[2] : undefined;
    };
    it('time sent and changed: the database says moved, and the invitation says the time is new', async () => {
      expect(await opening({ word: 'ok', moved: true }, { date: '2026-10-22', time: '11:00' }, MOVED_ROW)).toBe(NEW_TIME);
    });
    it('time sent but unchanged (with a new interviewer): the database says not moved, and the invitation does not say new', async () => {
      // The interview is already at 3:00 pm on 20 October: the model sent the same date and time along.
      const sent = { date: '2026-10-20', time: '15:00', interviewer_name: 'Farah Lim' };
      expect(await opening({ word: 'ok', moved: false }, sent)).toBe(INVITED);
      const f = ivFake({ answer: { word: 'ok', moved: false } });
      expect((await rescheduleInterview(f.ctx, { id: IV_ID, ...sent }, NOW))).toMatchObject({ ok: true, data: { invitation: INVITE } });
      // The time was still sent as it was given: what changed is only who decides the wording.
      expect(f.calls[0].args).toEqual({ p_interview_id: IV_ID, p_changes: { scheduled_at: '2026-10-20T15:00:00+08:00', interviewer_name: 'Farah Lim' } });
    });
    it('time not sent: not new, whatever the answer carries', async () => {
      expect(await opening({ word: 'ok', moved: false }, { notes: 'Bring a portfolio' })).toBe(INVITED);
      expect(await opening({ word: 'ok' }, { kind: 'video' })).toBe(INVITED);
    });
    it('an ok with no moved, or one that is not a boolean, is not moved: the plainer wording', async () => {
      const sent = { date: '2026-10-22', time: '11:00' };
      for (const answer of ['ok', { word: 'ok' }, { word: 'ok', moved: 'true' }, { word: 'ok', moved: 1 }, { word: 'ok', moved: null }, { word: 'ok', moved: {} }]) {
        expect(await opening(answer, sent, MOVED_ROW), JSON.stringify(answer)).toBe(INVITED);
      }
    });
    it('the success sentence is the same either way: it says when the interview is, from the row', async () => {
      for (const moved of [true, false]) {
        const result = await rescheduleInterview(ivFake({ answer: { word: 'ok', moved }, row: MOVED_ROW }).ctx, { id: IV_ID, date: '2026-10-22', time: '11:00' }, NOW);
        expect(result).toMatchObject({
          ok: true, data: { message: 'Updated the interview with Aina Rahman. It is on Thursday, 22 October 2026, 11:00 am. Nothing has been sent to them.' },
        });
      }
    });
  });
  it('is still a success when the row cannot be read back, saying only what was sent', async () => {
    expect(await rescheduleInterview(ivFake({ answer: 'ok', row: null }).ctx, { id: IV_ID, date: '2026-10-22', time: '11:00', place: '' }, NOW)).toEqual({
      ok: true,
      data: {
        id: IV_ID, application_id: null, candidate: '', job: '', application_stage: null, application_outcome: null,
        scheduled_at: '2026-10-22T11:00:00+08:00', date: '2026-10-22', time: '11:00', duration_minutes: null, kind: null,
        place: null, interviewer_name: null, status: 'scheduled', created_at: null, updated_at: null,
        message: 'Updated the interview with the candidate. It is on Thursday, 22 October 2026, 11:00 am. Nothing has been sent to them.',
        invitation: null, confirmed: false, note: NOT_READ,
      },
    });
    expect(await rescheduleInterview(ivFake({ answer: 'ok', readThrows: true }).ctx, { id: IV_ID, duration_minutes: 90, kind: 'phone' }, NOW)).toMatchObject({
      ok: true,
      data: {
        scheduled_at: null, date: null, time: null, duration_minutes: 90, kind: 'phone',
        message: 'Updated the interview with the candidate. Nothing has been sent to them.', invitation: null, confirmed: false, note: NOT_READ,
      },
    });
  });
  it('maps each word to its sentence', async () => {
    const cases: [unknown, string][] = [
      ['not_found', 'That interview could not be found. It may have been deleted with its application.'],
      ['forbidden', 'You do not have permission to make changes here.'],
      ['not_scheduled', 'This interview is no longer scheduled. Mark it as scheduled again first.'],
      ['not_active', 'This application is no longer active. Reopen it before scheduling or changing an interview.'],
      ['in_past', IN_PAST],
      ['too_far_ahead', 'Choose a date within the next 12 months.'],
      ['duplicate', 'This application already has an interview at that time.'],
      ['unchanged', 'Nothing was changed: the interview already has these details.'],
      ['changed', 'This interview was changed a moment ago. Nothing was saved. Check it and try again.'],
      ['invalid_changes', GENERIC_SENTENCE],
      ['invalid_time', GENERIC_SENTENCE],
      ['surprise', GENERIC_SENTENCE],
      [{ word: 'changed' }, 'This interview was changed a moment ago. Nothing was saved. Check it and try again.'],
      [null, GENERIC_SENTENCE],
    ];
    for (const [answer, error] of cases) {
      const f = ivFake({ answer });
      expect(await rescheduleInterview(f.ctx, { id: IV_ID, notes: 'x' }, NOW), JSON.stringify(answer)).toEqual({ ok: false, error });
      expect(f.reads).toEqual([]);
    }
  });
  it('gives the generic sentence and logs only a code on an rpc error and on a throw', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const input = { id: IV_ID, place: 'https://meet.example.com/abc', notes: 'Salary talk' };
    expect(await rescheduleInterview(ivFake({ error: { code: '42501', message: 'Aina secret' } }).ctx, input, NOW)).toEqual({ ok: false, error: GENERIC_SENTENCE });
    expect(spy).toHaveBeenCalledWith('[hire-capability] rescheduleInterview failed:', { code: '42501' });
    await rescheduleInterview(ivFake({ throws: new TypeError('Aina fetch failed') }).ctx, input, NOW);
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] rescheduleInterview failed:', { code: 'TypeError' });
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/Aina|meet\.example|Salary|77777777/);
    spy.mockRestore();
  });
});

describe('cancelInterview, setInterviewOutcome and reopenInterview', () => {
  const row = (status: string) => ({ ...IV_ROW, status });
  it('send only the id, and the outcome for the one that takes it', async () => {
    const a = ivFake({ answer: 'ok', row: row('cancelled') });
    await cancelInterview(a.ctx, { id: IV_ID });
    expect(a.calls).toEqual([{ fn: 'hire_cancel_interview', args: { p_interview_id: IV_ID } }]);
    const b = ivFake({ answer: 'ok', row: row('no_show') });
    await setInterviewOutcome(b.ctx, { id: IV_ID, outcome: 'no_show' });
    expect(b.calls).toEqual([{ fn: 'hire_set_interview_outcome', args: { p_interview_id: IV_ID, p_outcome: 'no_show' } }]);
    const c = ivFake({ answer: 'ok' });
    await reopenInterview(c.ctx, { id: IV_ID });
    expect(c.calls).toEqual([{ fn: 'hire_reopen_interview', args: { p_interview_id: IV_ID } }]);
    for (const x of [a, b, c]) {
      expect(JSON.stringify(x.calls)).not.toContain('org_id');
      expect(x.reads).toEqual([{ table: 'hire_interviews', columns: IV_READ, filters: { id: IV_ID, org_id: ORG } }]);
    }
  });
  it('refuse a made-up id, and an outcome that is neither of the two, before any call', async () => {
    const f = ivFake({ answer: 'ok' });
    expect(await cancelInterview(f.ctx, { id: 'interview-7' })).toEqual({ ok: false, error: NOT_AN_INTERVIEW_ID });
    expect(await reopenInterview(f.ctx, { id: '' })).toEqual({ ok: false, error: NOT_AN_INTERVIEW_ID });
    expect(await setInterviewOutcome(f.ctx, { id: 'interview-7', outcome: 'completed' })).toEqual({ ok: false, error: NOT_AN_INTERVIEW_ID });
    expect(await setInterviewOutcome(f.ctx, { id: IV_ID, outcome: 'cancelled' } as never)).toEqual({ ok: false, error: 'Choose what happened.' });
    expect(await setInterviewOutcome(f.ctx, { id: IV_ID } as never)).toEqual({ ok: false, error: 'Choose what happened.' });
    expect(f.calls).toEqual([]);
  });
  it('answer with the sentence, and an invitation only for an interview that reads as scheduled', async () => {
    expect(await cancelInterview(ivFake({ answer: 'ok', row: row('cancelled') }).ctx, { id: IV_ID })).toMatchObject({
      ok: true,
      data: { id: IV_ID, status: 'cancelled', candidate: 'Aina Rahman', message: 'Cancelled the interview with Aina Rahman. Nothing has been sent to them.', invitation: null, confirmed: true },
    });
    expect(await setInterviewOutcome(ivFake({ answer: 'ok', row: row('completed') }).ctx, { id: IV_ID, outcome: 'completed' })).toMatchObject({
      ok: true, data: { status: 'completed', message: 'Marked the interview with Aina Rahman as completed.', invitation: null },
    });
    expect(await setInterviewOutcome(ivFake({ answer: 'ok', row: row('no_show') }).ctx, { id: IV_ID, outcome: 'no_show' })).toMatchObject({
      ok: true, data: { status: 'no_show', message: 'Marked the interview with Aina Rahman as a no-show.', invitation: null },
    });
    // Scheduled again: the invitation is for the time it already had, so it does not say the time is new.
    expect(await reopenInterview(ivFake({ answer: 'ok' }).ctx, { id: IV_ID }, NOW)).toMatchObject({
      ok: true, data: { status: 'scheduled', message: 'The interview with Aina Rahman is scheduled again.', invitation: INVITE, confirmed: true },
    });
  });
  it('are still a success when the row cannot be read back, with the status the change implies', async () => {
    const blank = {
      id: IV_ID, application_id: null, candidate: '', job: '', application_stage: null, application_outcome: null,
      scheduled_at: null, date: null, time: null, duration_minutes: null, kind: null, place: null, interviewer_name: null,
      created_at: null, updated_at: null, invitation: null, confirmed: false, note: NOT_READ,
    };
    expect(await cancelInterview(ivFake({ answer: 'ok', row: null }).ctx, { id: IV_ID }))
      .toEqual({ ok: true, data: { ...blank, status: 'cancelled', message: 'Cancelled the interview with the candidate. Nothing has been sent to them.' } });
    expect(await setInterviewOutcome(ivFake({ answer: 'ok', readThrows: true }).ctx, { id: IV_ID, outcome: 'no_show' }))
      .toEqual({ ok: true, data: { ...blank, status: 'no_show', message: 'Marked the interview with the candidate as a no-show.' } });
    expect(await reopenInterview(ivFake({ answer: 'ok', row: null }).ctx, { id: IV_ID }))
      .toEqual({ ok: true, data: { ...blank, status: 'scheduled', message: 'The interview with the candidate is scheduled again.' } });
  });
  it('map each word to its sentence', async () => {
    const NOT_FOUND = 'That interview could not be found. It may have been deleted with its application.';
    const FORBIDDEN = 'You do not have permission to make changes here.';
    const NOT_SCHEDULED = 'This interview is no longer scheduled. Mark it as scheduled again first.';
    for (const [answer, error] of [['not_found', NOT_FOUND], ['forbidden', FORBIDDEN], ['not_scheduled', NOT_SCHEDULED], ['surprise', GENERIC_SENTENCE], [null, GENERIC_SENTENCE]] as const) {
      expect(await cancelInterview(ivFake({ answer }).ctx, { id: IV_ID }), String(answer)).toEqual({ ok: false, error });
    }
    for (const [answer, error] of [['not_found', NOT_FOUND], ['forbidden', FORBIDDEN], ['not_scheduled', NOT_SCHEDULED], ['invalid_outcome', GENERIC_SENTENCE], [null, GENERIC_SENTENCE]] as const) {
      expect(await setInterviewOutcome(ivFake({ answer }).ctx, { id: IV_ID, outcome: 'completed' }), String(answer)).toEqual({ ok: false, error });
    }
    for (const [answer, error] of [['not_found', NOT_FOUND], ['forbidden', FORBIDDEN], ['not_closed', 'This interview is already scheduled.'], ['surprise', GENERIC_SENTENCE], [null, GENERIC_SENTENCE]] as const) {
      expect(await reopenInterview(ivFake({ answer }).ctx, { id: IV_ID }), String(answer)).toEqual({ ok: false, error });
    }
  });
  it('give the generic sentence and log only a code on an rpc error and on a throw', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = () => ivFake({ error: { code: '42501', message: 'Aina secret', details: IV_ID } }).ctx;
    const throwing = () => ivFake({ throws: new TypeError('Aina fetch failed') }).ctx;
    expect(await cancelInterview(failing(), { id: IV_ID })).toEqual({ ok: false, error: GENERIC_SENTENCE });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] cancelInterview failed:', { code: '42501' });
    expect(await cancelInterview(throwing(), { id: IV_ID })).toEqual({ ok: false, error: GENERIC_SENTENCE });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] cancelInterview failed:', { code: 'TypeError' });
    expect(await setInterviewOutcome(failing(), { id: IV_ID, outcome: 'completed' })).toEqual({ ok: false, error: GENERIC_SENTENCE });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] setInterviewOutcome failed:', { code: '42501' });
    expect(await setInterviewOutcome(throwing(), { id: IV_ID, outcome: 'completed' })).toEqual({ ok: false, error: GENERIC_SENTENCE });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] setInterviewOutcome failed:', { code: 'TypeError' });
    expect(await reopenInterview(failing(), { id: IV_ID })).toEqual({ ok: false, error: GENERIC_SENTENCE });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] reopenInterview failed:', { code: '42501' });
    expect(await reopenInterview(throwing(), { id: IV_ID })).toEqual({ ok: false, error: GENERIC_SENTENCE });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] reopenInterview failed:', { code: 'TypeError' });
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/Aina|77777777/);
    spy.mockRestore();
  });
});

describe('closeApplication and the interviews still ahead', () => {
  /** A client whose rpc answers `word`, whose read-back answers ROW, and whose count read answers as told. */
  function closeFake(opts: { word?: string; count?: number | null; countError?: unknown; countThrows?: boolean } = {}) {
    const asked: { table: string; columns?: string; options?: unknown; filters: [string, string, unknown][] }[] = [];
    const client = {
      rpc: async () => ({ data: opts.word ?? 'ok', error: null }),
      from: (table: string) => {
        const entry: (typeof asked)[number] = { table, filters: [] };
        asked.push(entry);
        const chain = {
          select: (columns: string, options?: unknown) => { entry.columns = columns; entry.options = options; return chain; },
          eq: (key: string, value: unknown) => { entry.filters.push(['eq', key, value]); return chain; },
          gt: (key: string, value: unknown) => {
            entry.filters.push(['gt', key, value]);
            if (opts.countThrows) throw new Error('Aina read failed');
            return Promise.resolve({ count: 'count' in opts ? opts.count : 2, error: opts.countError ?? null });
          },
          maybeSingle: async () => ({ data: ROW, error: null }),
        };
        return chain;
      },
    };
    return { ctx: { client: client as never, orgId: ORG } satisfies HireWriteContext, asked };
  }
  it('counts the scheduled interviews of that application that are still ahead, inside the workspace', async () => {
    const f = closeFake({ count: 2 });
    const result = await closeApplication(f.ctx, { id: ID, outcome: 'rejected', reason: 'skills' }, NOW);
    expect(result).toMatchObject({ ok: true, data: { id: ID, candidate: 'Aina', confirmed: true, scheduled_interviews: 2 } });
    expect(f.asked.find((a) => a.table === 'hire_interviews')).toEqual({
      table: 'hire_interviews', columns: 'id', options: { count: 'exact', head: true },
      filters: [['eq', 'org_id', ORG], ['eq', 'application_id', ID], ['eq', 'status', 'scheduled'], ['gt', 'scheduled_at', '2026-10-11T04:00:00.000Z']],
    });
  });
  it('reports 0 when there are none, and when the count cannot be read: the rejection is saved either way', async () => {
    for (const opts of [{ count: 0 }, { count: null }, { count: 2, countError: { code: '57014' } }, { countThrows: true }, { count: -1 }, { count: 1.5 }]) {
      const result = await closeApplication(closeFake(opts).ctx, { id: ID, outcome: 'withdrawn' }, NOW);
      expect(result, JSON.stringify(opts)).toMatchObject({ ok: true, data: { scheduled_interviews: 0, confirmed: true } });
    }
  });
  it('does not count for a rejection that was refused', async () => {
    const f = closeFake({ word: 'not_active' });
    expect(await closeApplication(f.ctx, { id: ID, outcome: 'rejected' }, NOW)).toEqual({ ok: false, error: 'This application is no longer active. Reopen it first.' });
    expect(f.asked).toEqual([]);
  });
  it('is on a rejection or a withdrawal only: a move, a rating and a reopen do not carry it', async () => {
    for (const result of [
      await moveApplication(closeFake().ctx, { id: ID, stage: 'offer' }),
      await rateApplication(closeFake().ctx, { id: ID, rating: 3 }),
      await reopenApplication(closeFake().ctx, { id: ID }),
    ]) {
      expect(result.ok && result.data).not.toHaveProperty('scheduled_interviews');
    }
  });
});

// ─── no invitation for a start that has passed ───────────────────────────────

describe('an interview whose start has passed is given no invitation', () => {
  // IV_ROW starts at 3:00 pm on 20 October 2026 in Kuala Lumpur (07:00 UTC). NOW is nine days before it.
  const AFTER = new Date('2026-10-20T07:00:00.001Z');
  const AT_START = new Date('2026-10-20T07:00:00Z');
  const A_WEEK_ON = new Date('2026-10-27T04:00:00Z');
  /** Added to the success sentence so the missing invitation is explained (final-review fix pass). */
  const STARTED = 'Its start has already passed, so there is no invitation or calendar file.';
  it('"mark as scheduled again" on an interview from last week: saved, said, and nothing to send', async () => {
    const result = await reopenInterview(ivFake({ answer: 'ok' }).ctx, { id: IV_ID }, A_WEEK_ON);
    expect(result).toMatchObject({
      ok: true,
      data: { status: 'scheduled', scheduled_at: '2026-10-20T07:00:00+00:00', message: `The interview with Aina Rahman is scheduled again. ${STARTED}`, invitation: null, confirmed: true },
    });
    expect(result.ok && result.data).not.toHaveProperty('note');
  });
  it('a new interview saved inside the five minutes a slow form is allowed: the notice says why there is no invitation', async () => {
    // 3:00 pm on 20 October was two minutes ago.
    const result = await scheduleInterview(ivFake({ answer: { word: 'ok', id: IV_ID } }).ctx, SCHEDULE, new Date('2026-10-20T07:02:00Z'));
    expect(result).toMatchObject({
      ok: true,
      data: {
        message: `Scheduled an interview with Aina Rahman for Tuesday, 20 October 2026, 3:00 pm. Nothing has been sent to them. ${STARTED}`,
        invitation: null, confirmed: true,
      },
    });
    // Still ahead: the sentence is not there, and the invitation is.
    const ahead = await scheduleInterview(ivFake({ answer: { word: 'ok', id: IV_ID } }).ctx, SCHEDULE, NOW);
    expect(ahead.ok && ahead.data.message).toBe('Scheduled an interview with Aina Rahman for Tuesday, 20 October 2026, 3:00 pm. Nothing has been sent to them.');
    expect(ahead.ok && ahead.data.invitation).toBe(INVITE);
  });
  it('the sentence is only for a change that could have invited: not a cancellation, a mark, a past record or a row not read back', async () => {
    const said = async (run: Promise<{ ok: boolean; data?: { message: string } }>) => {
      const result = await run;
      return result.ok ? result.data?.message ?? '' : '';
    };
    expect(await said(cancelInterview(ivFake({ answer: 'ok' }).ctx, { id: IV_ID }, A_WEEK_ON))).not.toContain(STARTED);
    expect(await said(setInterviewOutcome(ivFake({ answer: 'ok', row: { ...IV_ROW, status: 'completed' } }).ctx, { id: IV_ID, outcome: 'completed' }, A_WEEK_ON)))
      .not.toContain(STARTED);
    expect(await said(reopenInterview(ivFake({ answer: 'ok', row: null }).ctx, { id: IV_ID }, A_WEEK_ON))).not.toContain(STARTED);
  });
  it('the same for an edit of one that has begun', async () => {
    const result = await rescheduleInterview(ivFake({ answer: { word: 'ok', moved: false } }).ctx, { id: IV_ID, notes: 'Ran late' }, A_WEEK_ON);
    expect(result).toMatchObject({
      ok: true,
      data: { message: `Updated the interview with Aina Rahman. It is on Tuesday, 20 October 2026, 3:00 pm. Nothing has been sent to them. ${STARTED}`, invitation: null, confirmed: true },
    });
  });
  it('is by the clock the capability is given, to the millisecond, for each change that can invite', async () => {
    const ok = { word: 'ok', id: IV_ID };
    const runs: [string, (now: Date) => Promise<{ ok: boolean; data?: { invitation: string | null } }>][] = [
      ['reopen', (now) => reopenInterview(ivFake({ answer: 'ok' }).ctx, { id: IV_ID }, now)],
      ['reschedule', (now) => rescheduleInterview(ivFake({ answer: { word: 'ok', moved: false } }).ctx, { id: IV_ID, kind: 'phone' }, now)],
      // Scheduling lets a start up to five minutes old through; it is saved, with nothing to send for it.
      ['schedule', (now) => scheduleInterview(ivFake({ answer: ok }).ctx, SCHEDULE, now)],
    ];
    for (const [name, run] of runs) {
      const before = await run(NOW);
      expect(before.ok && before.data?.invitation, name).toBe(INVITE);
      const atStart = await run(AT_START);
      expect(atStart.ok && atStart.data?.invitation, name).toBe(INVITE);
      const after = await run(AFTER);
      expect(after.ok, name).toBe(true);
      expect(after.ok && after.data?.invitation, name).toBeNull();
    }
  });
  it('cancelling and marking take the clock too, and never invite', async () => {
    expect(await cancelInterview(ivFake({ answer: 'ok', row: { ...IV_ROW, status: 'cancelled' } }).ctx, { id: IV_ID }, NOW)).toMatchObject({ ok: true, data: { invitation: null } });
    expect(await setInterviewOutcome(ivFake({ answer: 'ok', row: { ...IV_ROW, status: 'completed' } }).ctx, { id: IV_ID, outcome: 'completed' }, NOW))
      .toMatchObject({ ok: true, data: { invitation: null } });
    // A row that reads as scheduled again by the time it is read back (someone undid it) and has passed: still nothing.
    expect(await cancelInterview(ivFake({ answer: 'ok' }).ctx, { id: IV_ID }, A_WEEK_ON)).toMatchObject({ ok: true, data: { status: 'scheduled', invitation: null } });
  });
});

// ─── the instant the database is sent (beyond the plan's own tests) ──────────

describe('the instant sent for an interview', () => {
  /**
   * The two functions that insert take the start as text and answer `invalid_time` unless it says its own zone;
   * the one that changes reads it from `p_changes` under the same rule. Text with no zone would be stored eight
   * hours off. So what is sent for 3:00 pm on 20 October 2026 in Kuala Lumpur is pinned to the character.
   */
  const SENT = '2026-10-20T15:00:00+08:00';
  /** A week after that start, for the one that records an interview already held. */
  const LATER = new Date('2026-10-27T04:00:00Z');
  const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;

  /** Runs one capability against a client that says ok, and gives back the start it was sent. */
  async function sentBy(
    answer: unknown, run: (ctx: HireWriteContext) => Promise<{ ok: boolean }>, pick: (args: Record<string, unknown>) => unknown,
  ) {
    const f = ivFake({ answer });
    expect((await run(f.ctx)).ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    return pick(f.calls[0].args);
  }
  const NEW_ROW = { word: 'ok', id: IV_ID };
  const scheduled = (date = '2026-10-20', time = '15:00', now = NOW) =>
    sentBy(NEW_ROW, (ctx) => scheduleInterview(ctx, { ...SCHEDULE, date, time }, now), (args) => args.p_scheduled_at);
  const recorded = (date = '2026-10-20', time = '15:00', now = LATER) =>
    sentBy(NEW_ROW, (ctx) => recordPastInterview(ctx, { ...HELD, date, time }, now), (args) => args.p_scheduled_at);
  const changed = (date = '2026-10-20', time = '15:00') =>
    sentBy('ok', (ctx) => rescheduleInterview(ctx, { id: IV_ID, date, time }, NOW), (args) => (args.p_changes as Record<string, unknown>).scheduled_at);

  it('is this exact text from all three: a string, with +08:00, never a Date and never text without a zone', async () => {
    for (const sent of [await scheduled(), await recorded(), await changed()]) {
      expect(sent).toBe(SENT);
      expect(typeof sent).toBe('string');
      expect(sent).toMatch(ZONED);
      expect(Date.parse(sent as string)).toBe(Date.UTC(2026, 9, 20, 7, 0));
    }
  });
  it('is the same text whatever zone the server is in', async () => {
    const before = process.env.TZ;
    try {
      for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
        process.env.TZ = zone;
        expect(new Date('2026-10-20T07:00:00Z').getTimezoneOffset(), zone).toBe({ UTC: 0, 'America/New_York': 240, 'Asia/Tokyo': -540 }[zone]);
        expect(await scheduled(), zone).toBe(SENT);
        expect(await recorded(), zone).toBe(SENT);
        expect(await changed(), zone).toBe(SENT);
        // Midnight and the last minute of the day stay on the day that was typed.
        expect(await scheduled('2026-10-20', '00:00'), zone).toBe('2026-10-20T00:00:00+08:00');
        expect(await scheduled('2026-10-20', '23:59'), zone).toBe('2026-10-20T23:59:00+08:00');
        expect(await changed('2026-10-20', '00:00'), zone).toBe('2026-10-20T00:00:00+08:00');
        expect(await recorded('2026-10-20', '23:59'), zone).toBe('2026-10-20T23:59:00+08:00');
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
  it('keeps the day across a year, and on 29 February', async () => {
    // 00:00 on 1 January 2027 in Kuala Lumpur is 16:00 on 31 December 2026 in UTC.
    const newYear = await scheduled('2027-01-01', '00:00');
    expect(newYear).toBe('2027-01-01T00:00:00+08:00');
    expect(Date.parse(newYear as string)).toBe(Date.UTC(2026, 11, 31, 16, 0));
    expect(await scheduled('2026-12-31', '23:59')).toBe('2026-12-31T23:59:00+08:00');
    const nearLeapDay = new Date('2028-02-01T04:00:00Z');
    expect(await scheduled('2028-02-29', '00:00', nearLeapDay)).toBe('2028-02-29T00:00:00+08:00');
    expect(await scheduled('2028-02-29', '23:59', nearLeapDay)).toBe('2028-02-29T23:59:00+08:00');
    expect(await changed('2028-02-29', '09:30')).toBe('2028-02-29T09:30:00+08:00');
    expect(await recorded('2028-02-29', '09:30', new Date('2028-03-05T04:00:00Z'))).toBe('2028-02-29T09:30:00+08:00');
  });
  it('judges "already passed" by the Kuala Lumpur instant, not by the date in UTC', async () => {
    // 00:10 on 12 October in Kuala Lumpur is 16:10 on the 11th in UTC. 23:30 on the 11th in Kuala Lumpur is ahead of it.
    const justAfterMidnight = new Date('2026-10-11T16:10:00Z');
    const f = ivFake();
    expect(await scheduleInterview(f.ctx, { ...SCHEDULE, date: '2026-10-11', time: '23:30' }, justAfterMidnight)).toEqual({ ok: false, error: IN_PAST });
    expect((await scheduleInterview(f.ctx, { ...SCHEDULE, date: '2026-10-12', time: '00:06' }, justAfterMidnight)).ok).toBe(true);
    expect(f.calls.map((c) => c.args.p_scheduled_at)).toEqual(['2026-10-12T00:06:00+08:00']);
    const g = ivFake({ answer: { word: 'ok', id: IV_ID } });
    expect((await recordPastInterview(g.ctx, { ...HELD, date: '2026-10-12', time: '00:10' }, justAfterMidnight)).ok).toBe(true);
    expect(await recordPastInterview(g.ctx, { ...HELD, date: '2026-10-12', time: '00:11' }, justAfterMidnight))
      .toEqual({ ok: false, error: 'That time has not passed yet in Kuala Lumpur. To plan an interview, use “Schedule interview”.' });
    expect(g.calls.map((c) => c.args.p_scheduled_at)).toEqual(['2026-10-12T00:10:00+08:00']);
  });
  it('answers invalid_time from any of the three with the generic sentence, and reads nothing back', async () => {
    for (const answer of [{ word: 'invalid_time' }, 'invalid_time']) {
      const a = ivFake({ answer });
      expect(await scheduleInterview(a.ctx, SCHEDULE, NOW)).toEqual({ ok: false, error: GENERIC_SENTENCE });
      const b = ivFake({ answer });
      expect(await recordPastInterview(b.ctx, HELD, NOW)).toEqual({ ok: false, error: GENERIC_SENTENCE });
      const c = ivFake({ answer });
      expect(await rescheduleInterview(c.ctx, { id: IV_ID, date: '2026-10-22', time: '11:00' }, NOW)).toEqual({ ok: false, error: GENERIC_SENTENCE });
      for (const x of [a, b, c]) expect(x.reads).toEqual([]);
    }
  });
  it('gives the read-back start back as a Kuala Lumpur date and time, also when the database day is the one before', async () => {
    // 00:30 on Tuesday 20 October in Kuala Lumpur, as the database writes it: 16:30 on the 19th.
    const row = { ...IV_ROW, scheduled_at: '2026-10-19T16:30:00+00:00' };
    const result = await scheduleInterview(ivFake({ row }).ctx, { ...SCHEDULE, time: '00:30' }, NOW);
    expect(result).toMatchObject({
      ok: true,
      data: {
        scheduled_at: '2026-10-19T16:30:00+00:00', date: '2026-10-20', time: '00:30',
        message: 'Scheduled an interview with Aina Rahman for Tuesday, 20 October 2026, 12:30 am. Nothing has been sent to them.',
      },
    });
    expect(result.ok && result.data.invitation?.split('\n').slice(4, 6)).toEqual(['Date: Tuesday, 20 October 2026', 'Time: 12:30 am to 1:30 am, Kuala Lumpur time (GMT+8)']);
  });
});
