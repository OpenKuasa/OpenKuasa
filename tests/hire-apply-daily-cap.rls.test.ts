// tests/hire-apply-daily-cap.rls.test.ts
//
// Live check of the workspace's daily cap on public applications
// (20261125090200_hire_apply_daily_cap.sql): 500 in any 24 hours, answered 'day_full'.
// Needs that migration applied; before it, the 301st application of the day is refused as 'throttled'
// and the first test fails on that word.
//
// How the cap is reached: neither a member nor the service role may insert into hire_applications
// directly, and the cap must not have a test-only lower number, so the test does what a flood would do.
// It sends 500 real applications through submit_public_application as the server, spread round-robin
// over 17 open jobs (at most 30 per job, so a job's limit of 30 a minute never answers first, however
// fast they go). That takes a while: the test allows five minutes.
//
// Everything it writes (candidates, applications, notifications, rate-limit ticks) belongs to its
// throwaway workspaces, which the shared live-workspaces helper deletes when the file finishes.
import { beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { createAnonymousClient } from '@/lib/supabase/anonymous';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { publicWriter } from './helpers/public-writer';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const CAP = 500;
const JOBS = 17;
const PER_JOB_MINUTE = 30;
const BATCH = 20;
const RUN = Date.now();

let emailCounter = 0;
/** A lowercase address that no earlier run can have used. */
const uniqueEmail = () => `rls-cap-${RUN}-${++emailCounter}@example.com`;

type Owned = { c: SupabaseClient; orgId: string };

async function ownedOrg(name: string): Promise<Owned> {
  const c = liveClient();
  const { error: e1 } = await signInOwner(c);
  expect(e1, e1?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, name);
  expect(error, error?.message).toBeNull();
  return { c, orgId: orgId as string };
}

async function openJob(who: Owned, title: string): Promise<string> {
  const ins = await who.c
    .from('hire_jobs')
    .insert({
      org_id: who.orgId, title: `RLS cap job ${title}`, status: 'open',
      description: 'A real description of the role.', opened_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  expect(ins.error, ins.error?.message).toBeNull();
  return (ins.data as { id: string }).id;
}

async function boardOn(who: Owned) {
  const res = await who.c.from('hire_settings').insert({ org_id: who.orgId, careers_enabled: true }).select('org_id').single();
  expect(res.error, res.error?.message).toBeNull();
}

let writer: SupabaseClient;
let owner: Owned;
let other: Owned;
let jobs: string[] = [];
let otherJob: string;

const apply = (orgId: string, jobId: string, email = uniqueEmail()) =>
  writer.rpc('submit_public_application', {
    p_org_id: orgId,
    p_job_id: jobId,
    p_name: 'Aina Rahman',
    p_email: email,
    p_phone: null,
    p_cover_letter: null,
    p_cv_url: null,
    p_portfolio_url: null,
    p_expected_salary_cents: null,
    p_consent: true,
    p_honeypot: null,
  });

const word = (res: { data: unknown; error: { message: string } | null }) => {
  expect(res.error, res.error?.message).toBeNull();
  return res.data;
};

async function count(table: string, who: Owned, consentedOnly = false) {
  const base = who.c.from(table).select('*', { count: 'exact', head: true }).eq('org_id', who.orgId);
  const { count: n, error } = await (consentedOnly ? base.not('consented_at', 'is', null) : base);
  expect(error, error?.message).toBeNull();
  return n as number;
}

/** A member's hand-added application, through the function the Candidates page uses. */
const addByHand = (who: Owned, jobId: string, email: string) =>
  who.c.rpc('hire_add_candidate', {
    p_org_id: who.orgId, p_name: 'Farid Osman', p_email: email, p_phone: null, p_headline: null,
    p_location: null, p_skills: null, p_source: 'Careers page', p_job_id: jobId,
    p_cover_letter: null, p_cv_url: null,
  });

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  ({ writer } = await publicWriter(createAnonymousClient()));
  owner = await ownedOrg('Hire Cap Owner Sdn Bhd');
  other = await ownedOrg('Hire Cap Other Sdn Bhd');
  await boardOn(owner);
  await boardOn(other);
  jobs = [];
  for (let i = 0; i < JOBS; i++) jobs.push(await openJob(owner, `${i}`));
  otherJob = await openJob(other, 'other');
  expect(Math.ceil(CAP / JOBS)).toBeLessThanOrEqual(PER_JOB_MINUTE);
}, 120_000);

testWithSupabase('a hand-added application first does not use up the day', async () => {
  // Labelled as if from the careers page on purpose: only the consent date marks an applicant's own.
  const res = await addByHand(owner, jobs[0], uniqueEmail());
  expect(res.error, res.error?.message).toBeNull();
  expect((res.data as { word: string; application: string }).application).toBe('created');
}, 30_000);

testWithSupabase('takes 500 public applications across the jobs, then answers day_full', async () => {
  const answers: unknown[] = [];
  for (let start = 0; start < CAP; start += BATCH) {
    const batch = [];
    for (let i = start; i < Math.min(start + BATCH, CAP); i++) batch.push(apply(owner.orgId, jobs[i % JOBS]));
    answers.push(...(await Promise.all(batch)).map(word));
  }
  expect(answers.filter((a) => a !== 'ok')).toEqual([]);
  expect(await count('hire_applications', owner, true)).toBe(CAP);

  const before = {
    candidates: await count('hire_candidates', owner),
    applications: await count('hire_applications', owner),
  };
  const email = uniqueEmail();
  // Any job, a new email: the workspace's day is full.
  expect(word(await apply(owner.orgId, jobs[JOBS - 1], email))).toBe('day_full');
  expect(word(await apply(owner.orgId, jobs[3]))).toBe('day_full');
  // Nothing was kept for the refused ones.
  expect(await count('hire_candidates', owner)).toBe(before.candidates);
  expect(await count('hire_applications', owner)).toBe(before.applications);
  const found = await owner.c.from('hire_candidates').select('id').eq('org_id', owner.orgId).eq('email', email);
  expect(found.error, found.error?.message).toBeNull();
  expect(found.data).toEqual([]);
}, 300_000);

testWithSupabase('a member can still add an application by hand once the day is full', async () => {
  const res = await addByHand(owner, jobs[1], uniqueEmail());
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data).toMatchObject({ word: 'ok', application: 'created' });
}, 30_000);

testWithSupabase('another workspace is not affected', async () => {
  expect(word(await apply(other.orgId, otherJob))).toBe('ok');
}, 30_000);

testWithSupabase('the checks before the cap still answer first: a paused job is closed, not day_full', async () => {
  const paused = await owner.c.from('hire_jobs').update({ status: 'paused' }).eq('id', jobs[2]).select('id').single();
  expect(paused.error, paused.error?.message).toBeNull();
  expect(word(await apply(owner.orgId, jobs[2]))).toBe('closed');
  // And a missing consent is still asked for first.
  const res = await writer.rpc('submit_public_application', {
    p_org_id: owner.orgId, p_job_id: jobs[4], p_name: 'Aina Rahman', p_email: uniqueEmail(), p_phone: null,
    p_cover_letter: null, p_cv_url: null, p_portfolio_url: null, p_expected_salary_cents: null,
    p_consent: false, p_honeypot: null,
  });
  expect(word(res)).toBe('consent_required');
}, 30_000);
