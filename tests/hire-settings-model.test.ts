// tests/hire-settings-model.test.ts
import { describe, expect, it } from 'vitest';
import { buildSettingsModel } from '@/lib/hire/settings-model';
import { DEFAULT_HIRE_SETTINGS, type Application, type HireData, type Job } from '@/lib/hire/types';

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id, title: id, department: null, location: null, employment_type: 'full_time', status: 'open',
  description: 'Write things.', salary_min_cents: null, salary_max_cents: null, show_salary: false, closes_on: null,
  work_arrangement: null, headcount: 1,
  opened_at: '2026-09-01T00:00:00Z', closed_at: null, created_at: '2026-09-01T00:00:00Z', ...over,
});

const app = (id: string, over: Partial<Application> = {}): Application => ({
  id, candidate_id: 'c1', job_id: 'j1', candidate_name: 'Aina', job_title: 'Role', stage: 'applied',
  outcome: 'active', rating: null, source: null, applied_at: '2026-10-01T00:00:00Z', offered_at: null,
  hired_at: null, created_at: '2026-10-01T00:00:00Z',
  cover_letter: null, cv_url: null, cv_path: null, portfolio_url: null, expected_salary_cents: null,
  consented_at: null, reject_reason: null, ...over,
});

const data = (over: Partial<HireData> = {}): HireData => ({
  listJobs: async () => [],
  listCandidates: async () => [],
  listApplications: async () => [],
  listInterviews: async () => [],
  getSettings: async () => ({ org_id: 'o1', ...DEFAULT_HIRE_SETTINGS }),
  ...over,
});

describe('buildSettingsModel', () => {
  it('gives the five stages in order, each with how many live applications sit in it', async () => {
    const model = await buildSettingsModel(data({
      listApplications: async () => [
        app('a1'),
        app('a2', { stage: 'interview' }),
        app('a3', { stage: 'interview' }),
        app('a4', { stage: 'interview', outcome: 'rejected' }),
        app('a5', { stage: 'hired', outcome: 'withdrawn' }),
      ],
    }));
    expect(model.stages).toEqual([
      { stage: 'applied', label: 'Applied', count: 1 },
      { stage: 'screening', label: 'Screening', count: 0 },
      { stage: 'interview', label: 'Interview', count: 2 },
      { stage: 'offer', label: 'Offer', count: 0 },
      { stage: 'hired', label: 'Hired', count: 0 },
    ]);
  });

  it('counts the jobs the careers page shows by its own rule: open and with a description', async () => {
    const model = await buildSettingsModel(data({
      getSettings: async () => ({ org_id: 'o1', ...DEFAULT_HIRE_SETTINGS, careers_enabled: true }),
      listJobs: async () => [
        job('shown'),
        job('blank', { description: '   ' }),
        job('none', { description: null }),
        job('draft', { status: 'draft' }),
        job('closed', { status: 'closed' }),
      ],
    }));
    expect(model.board).toEqual({ enabled: true, orgId: 'o1', listed: 1, hiddenOpen: 2 });
  });

  it('says the page is off, and carries the settings for the application form card', async () => {
    const model = await buildSettingsModel(data({ listJobs: async () => [job('j1')] }));
    expect(model.board).toEqual({ enabled: false, orgId: 'o1', listed: 1, hiddenOpen: 0 });
    expect(model.settings).toMatchObject({ org_id: 'o1', require_cv: false });
  });
});
