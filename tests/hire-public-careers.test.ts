import { describe, expect, it, vi } from 'vitest';
import {
  careersJobPath, careersPath, careersUrl, formatLongDate, formatSalary, getPublicCareers, getPublicJob, readPublicJob,
} from '@/lib/hire/public-careers';

const ORG = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const client = (data: unknown, error: unknown = null) => {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { rpc, asClient: { rpc } as never };
};
const row = {
  org_name: 'Kedai Kopi', headline: null, tagline: 'Good coffee', job_id: JOB, title: 'Barista',
  department: 'Operations', location: 'Ipoh', work_arrangement: 'onsite', employment_type: 'full_time',
  closes_on: '2026-10-31', accepting: true,
};

describe('getPublicCareers', () => {
  it('maps the rows to a board', async () => {
    const c = client([row]);
    expect(await getPublicCareers(c.asClient, ORG)).toEqual({
      orgName: 'Kedai Kopi', headline: null, tagline: 'Good coffee',
      jobs: [{
        id: JOB, title: 'Barista', department: 'Operations', location: 'Ipoh',
        workArrangement: 'onsite', employmentType: 'full_time', closesOn: '2026-10-31', accepting: true,
      }],
    });
    expect(c.rpc).toHaveBeenCalledWith('get_public_careers', { p_org_id: ORG });
  });
  it('reads a board that is on with no open jobs as an empty board, not as missing', async () => {
    const c = client([{ ...row, job_id: null, title: null, accepting: null }]);
    expect(await getPublicCareers(c.asClient, ORG)).toMatchObject({ orgName: 'Kedai Kopi', jobs: [] });
  });
  it('is null when nothing comes back, and when the call fails', async () => {
    expect(await getPublicCareers(client([]).asClient, ORG)).toBeNull();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A row beside the error: reading the row anyway would not be null.
    expect(await getPublicCareers(client([row], { message: 'boom' }).asClient, ORG)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    const thrown = { rpc: vi.fn().mockRejectedValue(new Error('network down')) } as never;
    expect(await getPublicCareers(thrown, ORG)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
  it('makes no call for an id that is not a UUID', async () => {
    const c = client([row]);
    expect(await getPublicCareers(c.asClient, 'abc')).toBeNull();
    expect(c.rpc).not.toHaveBeenCalled();
  });
});

describe('getPublicJob', () => {
  const jobRow = { ...row, description: 'Make coffee.\nSmile.', salary_min_cents: 300000, salary_max_cents: null };
  it('maps one job', async () => {
    const c = client([jobRow]);
    expect(await getPublicJob(c.asClient, ORG, JOB)).toMatchObject({
      id: JOB, orgName: 'Kedai Kopi', description: 'Make coffee.\nSmile.', salaryMinCents: 300000, salaryMaxCents: null,
    });
    expect(c.rpc).toHaveBeenCalledWith('get_public_job', { p_org_id: ORG, p_job_id: JOB });
  });
  it('maps the four form requirements, and reads their absence as all false', async () => {
    const asked = { require_cv: true, require_cover_letter: false, ask_portfolio: true, ask_expected_salary: false };
    expect((await getPublicJob(client([{ ...jobRow, ...asked }]).asClient, ORG, JOB))?.form).toEqual(asked);
    expect((await getPublicJob(client([jobRow]).asClient, ORG, JOB))?.form).toEqual({
      require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false,
    });
  });
  it('is null for no row, a failed call, or a bad id (without calling)', async () => {
    expect(await getPublicJob(client([]).asClient, ORG, JOB)).toBeNull();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getPublicJob(client([jobRow], { message: 'boom' }).asClient, ORG, JOB)).toBeNull();
    expect(await getPublicJob({ rpc: vi.fn().mockRejectedValue(new Error('network down')) } as never, ORG, JOB)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
    const c = client([jobRow]);
    expect(await getPublicJob(c.asClient, ORG, 'not-a-uuid')).toBeNull();
    expect(await getPublicJob(c.asClient, 'x', JOB)).toBeNull();
    expect(c.rpc).not.toHaveBeenCalled();
  });
});

describe('readPublicJob', () => {
  const jobRow = { ...row, description: 'Make coffee.', salary_min_cents: null, salary_max_cents: null };
  it('found: the job, as getPublicJob gives it', async () => {
    const c = client([jobRow]);
    const answer = await readPublicJob(c.asClient, ORG, JOB);
    expect(answer).toEqual({ state: 'found', job: await getPublicJob(client([jobRow]).asClient, ORG, JOB) });
    expect(answer).toMatchObject({ job: { id: JOB, orgName: 'Kedai Kopi' } });
    expect(c.rpc).toHaveBeenCalledWith('get_public_job', { p_org_id: ORG, p_job_id: JOB });
  });
  it('missing: no row, or a row that cannot be a job', async () => {
    expect(await readPublicJob(client([]).asClient, ORG, JOB)).toEqual({ state: 'missing' });
    expect(await readPublicJob(client(null).asClient, ORG, JOB)).toEqual({ state: 'missing' });
    expect(await readPublicJob(client([{ ...jobRow, title: null }]).asClient, ORG, JOB)).toEqual({ state: 'missing' });
    expect(await readPublicJob(client([{ ...jobRow, org_name: null }]).asClient, ORG, JOB)).toEqual({ state: 'missing' });
  });
  it('missing, without a call: an id that is not a UUID', async () => {
    const c = client([jobRow]);
    expect(await readPublicJob(c.asClient, ORG, 'not-a-uuid')).toEqual({ state: 'missing' });
    expect(await readPublicJob(c.asClient, 'x', JOB)).toEqual({ state: 'missing' });
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it('failed: an error in the answer, even beside a valid row, or a call that threw', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await readPublicJob(client([jobRow], { message: 'boom' }).asClient, ORG, JOB)).toEqual({ state: 'failed' });
    const thrown = { rpc: vi.fn().mockRejectedValue(new Error('network down')) } as never;
    expect(await readPublicJob(thrown, ORG, JOB)).toEqual({ state: 'failed' });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe('addresses and formatting', () => {
  it('builds the board and job addresses', () => {
    expect(careersPath(ORG)).toBe(`/careers/${ORG}`);
    expect(careersJobPath(ORG, JOB)).toBe(`/careers/${ORG}/${JOB}`);
    expect(careersUrl('https://openkuasa.com/', ORG)).toBe(`https://openkuasa.com/careers/${ORG}`);
  });
  it('writes a salary range for Malaysia', () => {
    expect(formatSalary(400000, 600000)).toBe('RM 4,000 – RM 6,000 a month');
    expect(formatSalary(400000, null)).toBe('From RM 4,000 a month');
    expect(formatSalary(null, 600050)).toBe('Up to RM 6,000.50 a month');
    expect(formatSalary(null, null)).toBeNull();
  });
  it('writes a date in full without depending on the machine locale', () => {
    expect(formatLongDate('2026-10-31')).toBe('31 October 2026');
    expect(formatLongDate('2026-09-01')).toBe('1 September 2026');
    expect(formatLongDate('nonsense')).toBeNull();
  });
});
