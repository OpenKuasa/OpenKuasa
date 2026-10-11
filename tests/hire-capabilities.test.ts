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
      ok: true, data: { name: 'Aina', message: 'Added Aina.' },
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
