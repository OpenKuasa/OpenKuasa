import { describe, expect, it } from 'vitest';
import { createSeedHireData, seedRow } from '@/lib/hire/seed';
import { APPLICATION_STAGES } from '@/lib/hire/types';
import { interviewCardFromLists } from '@/lib/hire/namesakes';

const NOW = new Date('2026-10-10T04:00:00Z');
const data = createSeedHireData(NOW);

describe('hire seed', () => {
  it('has 9 jobs, 342 candidates, 248 applications and 10 interviews', async () => {
    expect(await data.listJobs()).toHaveLength(9);
    expect(await data.listCandidates()).toHaveLength(342);
    expect(await data.listApplications()).toHaveLength(248);
    expect(await data.listInterviews()).toHaveLength(10);
  });

  it('reaches each stage the stated number of times', async () => {
    const apps = await data.listApplications();
    const reached = (stage: (typeof APPLICATION_STAGES)[number]) =>
      apps.filter((a) => APPLICATION_STAGES.indexOf(a.stage) >= APPLICATION_STAGES.indexOf(stage)).length;
    expect(APPLICATION_STAGES.map(reached)).toEqual([248, 96, 38, 4, 2]);
  });

  it('has the stated source mix and applicants per job', async () => {
    const apps = await data.listApplications();
    const count = (key: 'source' | 'job_title', value: string) => apps.filter((a) => a[key] === value).length;
    expect(['JobStreet', 'LinkedIn', 'Referral', 'Careers page'].map((s) => count('source', s))).toEqual([104, 72, 44, 28]);
    expect(count('job_title', 'Software Engineer')).toBe(56);
    expect(count('job_title', 'Sales Executive')).toBe(42);
    expect(count('job_title', 'Marketing Lead')).toBe(0);
  });

  it('gives every candidate a unique name and email', async () => {
    const candidates = await data.listCandidates();
    expect(new Set(candidates.map((c) => c.name)).size).toBe(342);
    expect(new Set(candidates.map((c) => c.email)).size).toBe(342);
    expect(candidates.every((c) => c.email?.endsWith('@demo.openkuasa.com'))).toBe(true);
  });

  it('never dates anything applied, offered or hired in the future', async () => {
    for (const a of await data.listApplications()) {
      expect(Date.parse(a.applied_at)).toBeLessThanOrEqual(NOW.getTime());
      if (a.offered_at) expect(Date.parse(a.offered_at)).toBeLessThanOrEqual(NOW.getTime());
      if (a.hired_at) expect(Date.parse(a.hired_at)).toBeLessThanOrEqual(NOW.getTime());
      if (a.offered_at) expect(Date.parse(a.offered_at)).toBeGreaterThan(Date.parse(a.applied_at));
    }
  });

  it('has six interviews ahead, three completed and one no-show, all with active interview-stage applications', async () => {
    const interviews = await data.listInterviews();
    const apps = new Map((await data.listApplications()).map((a) => [a.id, a]));
    expect(interviews.filter((i) => i.status === 'scheduled' && Date.parse(i.scheduled_at) > NOW.getTime())).toHaveLength(6);
    expect(interviews.filter((i) => i.status === 'completed')).toHaveLength(3);
    expect(interviews.filter((i) => i.status === 'no_show')).toHaveLength(1);
    for (const i of interviews) {
      expect(apps.get(i.application_id)).toMatchObject({ stage: 'interview', outcome: 'active' });
    }
  });

  it('gives every interview an hour, no place, no notes, and the stage and outcome of its application', async () => {
    const apps = new Map((await data.listApplications()).map((a) => [a.id, a]));
    const interviews = await data.listInterviews();
    for (const i of interviews) {
      expect(i, i.id).toMatchObject({ duration_minutes: 60, place: null, notes: null });
      // Never changed since it was made: its calendar file is number 0.
      expect(i.updated_at, i.id).toBe(i.created_at);
      expect([i.application_stage, i.application_outcome], i.id).toEqual([apps.get(i.application_id)!.stage, apps.get(i.application_id)!.outcome]);
    }
    expect(await createSeedHireData(NOW).listInterviews()).toEqual(interviews);
  });

  it('can say which interview a card is about from its own list', async () => {
    const interviews = await data.listInterviews();
    const one = interviews[0];
    expect(interviewCardFromLists(one.id, interviews)).toEqual({
      target: {
        id: one.id, application_id: one.application_id, candidate: one.candidate_name, job: one.job_title, scheduled_at: one.scheduled_at, kind: one.kind,
        status: one.status, duration_minutes: one.duration_minutes, place: one.place,
      },
      // Every sample candidate has a name of their own, and each has one interview.
      others: [],
      cut: false,
      also: [],
      alsoClosed: [],
      application_outcome: one.application_outcome,
    });
  });

  it('is the same for the same now', async () => {
    expect(await createSeedHireData(NOW).listApplications()).toEqual(await data.listApplications());
  });

  it('leaves the five application detail fields null on every seeded application', async () => {
    for (const a of await data.listApplications()) {
      expect([a.cover_letter, a.cv_url, a.portfolio_url, a.expected_salary_cents, a.consented_at], a.id).toEqual([null, null, null, null, null]);
    }
  });

  it('seedRow is a pure rule: application 1', () => {
    expect(seedRow(1)).toMatchObject({ k: 37, jobIndex: 0, stage: 'interview', outcome: 'active' });
  });

  it('gives every job the slice 2a fields', async () => {
    const jobs = await data.listJobs();
    for (const job of jobs) {
      expect(job.headcount).toBeGreaterThanOrEqual(1);
      expect(typeof job.show_salary).toBe('boolean');
      expect(job).toHaveProperty('description');
      expect(job).toHaveProperty('closes_on');
      expect(job).toHaveProperty('work_arrangement');
    }
    // Every open job can be shown publicly later, so it has a description.
    for (const job of jobs.filter((j) => j.status === 'open')) {
      expect(job.description?.length ?? 0).toBeGreaterThan(40);
    }
    expect(jobs.filter((j) => j.show_salary)).toHaveLength(4);
    for (const job of jobs) {
      if (job.salary_min_cents !== null && job.salary_max_cents !== null) {
        expect(job.salary_max_cents).toBeGreaterThanOrEqual(job.salary_min_cents);
      }
      if (job.closes_on) expect(job.closes_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('words each job description so it reads right whatever letter the title starts with', async () => {
    const jobs = await data.listJobs();
    const manager = jobs.find((j) => j.title === 'Account Manager');
    expect(manager?.description?.startsWith('Rimba Ventures is hiring for the role of Account Manager in our Sales team.')).toBe(true);
    const described = jobs.filter((j) => j.description !== null);
    expect(described).toHaveLength(8);
    for (const job of described) {
      // "a Account Manager", "a Operations Executive", "a Engineering team".
      for (const wrong of [' a A', ' a O', ' a E']) expect(job.description, job.title).not.toContain(wrong);
    }
  });

  it('schedules interviews in working hours in Kuala Lumpur, on the hour or half hour', async () => {
    for (const interview of await data.listInterviews()) {
      const kl = new Date(new Date(interview.scheduled_at).getTime() + 8 * 3_600_000);
      const minutes = kl.getUTCHours() * 60 + kl.getUTCMinutes();
      expect(minutes, interview.scheduled_at).toBeGreaterThanOrEqual(9 * 60);
      expect(minutes, interview.scheduled_at).toBeLessThanOrEqual(17 * 60);
      expect(kl.getUTCMinutes() % 30).toBe(0);
    }
  });

  it('moves an evening interview to the next day, so upcoming ones stay after now', async () => {
    const eveningNow = new Date('2026-10-10T10:00:00Z'); // 18:00 in Kuala Lumpur
    const interviews = await createSeedHireData(eveningNow).listInterviews();
    const scheduled = interviews.filter((i) => i.status === 'scheduled');
    expect(scheduled).toHaveLength(6);
    for (const interview of scheduled) {
      expect(new Date(interview.scheduled_at).getTime(), interview.scheduled_at).toBeGreaterThan(eveningNow.getTime());
    }
    expect(scheduled[0].scheduled_at).toBe('2026-10-11T09:00:00.000Z'); // 17:00 the next day
    for (const interview of interviews) {
      const kl = new Date(new Date(interview.scheduled_at).getTime() + 8 * 3_600_000);
      const minutes = kl.getUTCHours() * 60 + kl.getUTCMinutes();
      expect(minutes, interview.scheduled_at).toBeGreaterThanOrEqual(9 * 60);
      expect(minutes, interview.scheduled_at).toBeLessThanOrEqual(17 * 60);
      expect(kl.getUTCMinutes() % 30).toBe(0);
    }
    const done = interviews.filter((i) => i.status !== 'scheduled');
    expect(done).toHaveLength(4);
    for (const interview of done) {
      expect(new Date(interview.scheduled_at).getTime(), interview.scheduled_at).toBeLessThan(eveningNow.getTime());
    }
  });

  it('has the careers page off, with no workspace id', async () => {
    expect(await createSeedHireData(new Date()).getSettings()).toEqual({
      org_id: null, careers_enabled: false, careers_headline: null, careers_tagline: null,
      require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false,
    });
  });
});
