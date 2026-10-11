// tests/hire-public-applications.rls.test.ts
//
// Live checks of public.submit_public_application and of what a signed-out visitor can and cannot do.
//
// The rows this file creates through the function (candidates, applications, notifications, rate-limit
// ticks) cannot be removed by a user, so they go with their throwaway workspaces: the shared
// live-workspaces helper deletes those (and the anonymous users) when the file finishes.
import { beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { createAnonymousClient } from '@/lib/supabase/anonymous';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient, beforeCleanup } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const client = liveClient;

const PREFIX = 'RLS apply job';
const OWNER_ORG_NAME = 'Hire Apply Owner Sdn Bhd';
const SWITCHES = 'require_cv, require_cover_letter, ask_portfolio, ask_expected_salary';
const ALL_OFF = { require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false };
const FORBIDDEN_KEYS = ['headcount', 'status', 'created_at', 'closed_at'];
const RUN = Date.now();
const NAME = 'Aina Rahman';
const PHONE_SENT = ' +60  12-345 6789 ';
const PHONE_STORED = '+60 12-345 6789';

let emailCounter = 0;
/** A lowercase address that no earlier run can have used. */
const uniqueEmail = () => `rls-${RUN}-${++emailCounter}@example.com`;

async function ownedOrg(name: string) {
  const c = client();
  const { error: e1 } = await signInAnon(c);
  expect(e1, e1?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, name);
  expect(error, error?.message).toBeNull();
  return { c, orgId: orgId as string };
}

type Owned = Awaited<ReturnType<typeof ownedOrg>>;

let owner: Owned;
let other: Owned;
let viewer: SupabaseClient;
let visitor: SupabaseClient;
let demoId: string;

let openJob: { id: string; title: string };
let secondJob: { id: string; title: string };
let reqJob: { id: string; title: string };
let draftJob: { id: string; title: string };
let pastJob: { id: string; title: string };
let otherJob: { id: string; title: string };

async function newJob(who: Owned, title: string, fields: Record<string, unknown> = {}) {
  const full = `${PREFIX} ${title}`;
  const ins = await who.c
    .from('hire_jobs')
    .insert({ org_id: who.orgId, title: full, ...fields })
    .select('id')
    .single();
  expect(ins.error, ins.error?.message).toBeNull();
  const created = { id: (ins.data as { id: string }).id, title: full };
  return created;
}

const openFields = (extra: Record<string, unknown> = {}) => ({
  status: 'open',
  description: 'A real description of the role.',
  opened_at: new Date().toISOString(),
  ...extra,
});

/** A fresh open, described job: for cases that send several submissions and must not share a rate limit. */
const freshOpenJob = (title: string) => newJob(owner, title, openFields());

async function switchBoardOn(who: Owned) {
  const res = await who.c
    .from('hire_settings')
    .insert({ org_id: who.orgId, careers_enabled: true })
    .select('org_id, careers_enabled')
    .single();
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data!.careers_enabled).toBe(true);
}

async function setSettings(who: Owned, fields: Record<string, unknown>) {
  const res = await who.c.from('hire_settings').update(fields).eq('org_id', who.orgId).select('org_id').single();
  expect(res.error, res.error?.message).toBeNull();
}

type Params = Partial<{
  p_org_id: string;
  p_job_id: string;
  p_name: string | null;
  p_email: string | null;
  p_phone: string | null;
  p_cover_letter: string | null;
  p_cv_url: string | null;
  p_portfolio_url: string | null;
  p_expected_salary_cents: number | null;
  p_consent: boolean;
  p_honeypot: string | null;
}>;

/** Calls the function as the signed-out visitor, with good defaults a case can override. */
const apply = (overrides: Params = {}) =>
  visitor.rpc('submit_public_application', {
    p_org_id: owner.orgId,
    p_job_id: openJob.id,
    p_name: NAME,
    p_email: uniqueEmail(),
    p_phone: null,
    p_cover_letter: null,
    p_cv_url: null,
    p_portfolio_url: null,
    p_expected_salary_cents: null,
    p_consent: true,
    p_honeypot: null,
    ...overrides,
  });

/** The function must answer with exactly this word and no error: an error for another reason cannot pass. */
function expectWord(res: { data: unknown; error: { message: string } | null }, word: string) {
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data).toBe(word);
}

async function countRows(table: string, who: Owned, jobId?: string) {
  const base = who.c.from(table).select('*', { count: 'exact', head: true });
  const { count, error } = await (jobId ? base.eq('job_id', jobId) : base.eq('org_id', who.orgId));
  expect(error, error?.message).toBeNull();
  expect(count).not.toBeNull();
  return count as number;
}

/** What the owner can see of everything a submission could write. */
async function snapshot() {
  const [candidates, applications, notifications] = await Promise.all([
    countRows('hire_candidates', owner),
    countRows('hire_applications', owner),
    countRows('notifications', owner),
  ]);
  return { candidates, applications, notifications };
}

async function candidateByEmail(email: string) {
  const res = await owner.c
    .from('hire_candidates')
    .select('id, name, email, phone, source, pool_status')
    .eq('org_id', owner.orgId)
    .eq('email', email);
  expect(res.error, res.error?.message).toBeNull();
  return res.data as Array<{
    id: string; name: string; email: string; phone: string | null; source: string | null; pool_status: string;
  }>;
}

type AppRow = {
  id: string; stage: string; outcome: string; source: string | null; consented_at: string | null;
  cover_letter: string | null; cv_url: string | null; portfolio_url: string | null;
  expected_salary_cents: number | null; job_id: string;
};

async function applicationsOf(candidateId: string) {
  const res = await owner.c
    .from('hire_applications')
    .select('id, stage, outcome, source, consented_at, cover_letter, cv_url, portfolio_url, expected_salary_cents, job_id')
    .eq('candidate_id', candidateId);
  expect(res.error, res.error?.message).toBeNull();
  return res.data as AppRow[];
}

async function ownerNotifications() {
  const res = await owner.c.from('notifications').select('title, body, href').eq('org_id', owner.orgId);
  expect(res.error, res.error?.message).toBeNull();
  return res.data as Array<{ title: string; body: string | null; href: string | null }>;
}

const publicJob = (orgId: string, jobId: string) =>
  visitor.rpc('get_public_job', { p_org_id: orgId, p_job_id: jobId });

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  owner = await ownedOrg(OWNER_ORG_NAME);
  other = await ownedOrg('Hire Apply Other Sdn Bhd');
  viewer = client();
  await signInAnon(viewer);
  const { data, error } = await joinDemo(viewer);
  expect(error, error?.message).toBeNull();
  demoId = data as string;
  visitor = createAnonymousClient();

  // Both boards on, the owner's form switches all off.
  await switchBoardOn(owner);
  await switchBoardOn(other);

  openJob = await newJob(owner, 'open', openFields());
  secondJob = await newJob(owner, 'second', openFields());
  reqJob = await newJob(owner, 'requirements', openFields());
  draftJob = await newJob(owner, 'draft', { status: 'draft', description: 'Draft description.' });
  pastJob = await newJob(owner, 'past', openFields({ closes_on: '2020-01-01' }));
  otherJob = await newJob(other, 'other open', openFields());
}, 30_000);

// If the cleanup cannot delete the workspaces (no key, migration not applied), they must not
// keep a public board or an open application form, so this runs first inside the helper's cleanup.
beforeCleanup(async () => {
  for (const who of [owner, other]) {
    if (!who) continue;
    await who.c.from('hire_settings').update({ careers_enabled: false, ...ALL_OFF }).eq('org_id', who.orgId);
  }
});

// The cases run in file order: later ones read what earlier ones wrote.

testWithSupabase('1. each refusal gives its word and writes nothing, not even a notification', async () => {
  const cases: Array<[string, Params, string]> = [
    ['name too long', { p_name: 'a'.repeat(121) }, 'name_too_long'],
    ['cover letter too long', { p_cover_letter: 'x'.repeat(4001) }, 'cover_letter_too_long'],
    ['link too long', { p_cv_url: `https://example.com/${'a'.repeat(481)}` }, 'url_too_long'],
    ['blank name', { p_name: '   ' }, 'invalid_name'],
    ['bad email', { p_email: 'aina@' }, 'invalid_email'],
    ['javascript link', { p_cv_url: 'javascript:alert(1)' }, 'invalid_url'],
    ['negative salary', { p_expected_salary_cents: -1 }, 'invalid_salary'],
    ["another workspace's org with this job", { p_org_id: other.orgId }, 'not_found'],
    ["this workspace's org with another workspace's job", { p_job_id: otherJob.id }, 'not_found'],
    ['draft job', { p_job_id: draftJob.id }, 'closed'],
    ['job past its closing date', { p_job_id: pastJob.id }, 'closed'],
    ['no consent', { p_consent: false }, 'consent_required'],
  ];
  const before = await snapshot();
  for (const [label, overrides, word] of cases) {
    const res = await apply(overrides);
    expect(res.error, `${label}: ${res.error?.message}`).toBeNull();
    expect(res.data, label).toBe(word);
    expect(await snapshot(), `${label} wrote something`).toEqual(before);
  }
}, 60_000);

testWithSupabase('2. a filled honeypot answers ok and writes nothing', async () => {
  const before = await snapshot();
  const email = uniqueEmail();
  expectWord(await apply({ p_email: email, p_honeypot: 'http://spam.example' }), 'ok');
  expect(await snapshot()).toEqual(before);
  expect(await candidateByEmail(email)).toHaveLength(0);
}, 30_000);

const email3 = uniqueEmail();

testWithSupabase('3. a valid application is stored as one candidate and one application', async () => {
  const before = await snapshot();
  expectWord(
    await apply({
      p_email: email3,
      p_name: '  Aina   Rahman ',
      p_phone: PHONE_SENT,
      p_portfolio_url: 'https://example.com/portfolio',
      p_expected_salary_cents: 450000,
    }),
    'ok',
  );
  const after = await snapshot();
  expect(after.candidates).toBe(before.candidates + 1);
  expect(after.applications).toBe(before.applications + 1);

  const candidates = await candidateByEmail(email3);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    name: NAME, email: email3, phone: PHONE_STORED, source: 'Careers page', pool_status: 'none',
  });
  const apps = await applicationsOf(candidates[0].id);
  expect(apps).toHaveLength(1);
  expect(apps[0]).toMatchObject({
    job_id: openJob.id, stage: 'applied', outcome: 'active', source: 'Careers page',
    // The switches are off, so what was sent is not kept.
    cover_letter: null, cv_url: null, portfolio_url: null, expected_salary_cents: null,
  });
  expect(apps[0].consented_at).not.toBeNull();
  expect(Math.abs(Date.now() - Date.parse(apps[0].consented_at as string))).toBeLessThan(60_000);
}, 30_000);

testWithSupabase('4. the same application again answers ok and writes nothing new', async () => {
  const before = await snapshot();
  expectWord(await apply({ p_email: email3, p_phone: PHONE_SENT }), 'ok');
  // Not a second candidate, application or notification.
  expect(await snapshot()).toEqual(before);
}, 30_000);

testWithSupabase('5. an existing candidate is not overwritten, and their stored name is the one announced', async () => {
  const before = await snapshot();
  expectWord(
    await apply({
      p_job_id: secondJob.id,
      p_email: email3.toUpperCase(),
      p_name: 'Different Person',
      p_phone: '+60 99-000 0000',
    }),
    'ok',
  );
  const after = await snapshot();
  expect(after.candidates).toBe(before.candidates);
  expect(after.applications).toBe(before.applications + 1);

  const candidates = await candidateByEmail(email3);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({ name: NAME, phone: PHONE_STORED });
  const apps = await applicationsOf(candidates[0].id);
  expect(apps.map((a) => a.job_id).sort()).toEqual([openJob.id, secondJob.id].sort());

  const notes = await ownerNotifications();
  expect(
    notes.some((n) => n.body?.includes(NAME) && n.body.includes(secondJob.title)),
    'a notification names the stored candidate and the second job',
  ).toBe(true);
  expect(notes.filter((n) => n.body?.includes('Different Person'))).toHaveLength(0);
}, 30_000);

testWithSupabase('6. a missing phone is filled once, and then left alone', async () => {
  const email = uniqueEmail();
  expectWord(await apply({ p_email: email, p_name: 'Hafiz Ismail', p_phone: null }), 'ok');
  expect((await candidateByEmail(email))[0].phone).toBeNull();

  expectWord(await apply({ p_job_id: secondJob.id, p_email: email, p_name: 'Hafiz Ismail', p_phone: '+60 11-222 3333' }), 'ok');
  expect((await candidateByEmail(email))[0].phone).toBe('+60 11-222 3333');

  // A repeat to the first job with another phone changes nothing.
  expectWord(await apply({ p_email: email, p_name: 'Hafiz Ismail', p_phone: '+60 88-777 6666' }), 'ok');
  expect((await candidateByEmail(email))[0].phone).toBe('+60 11-222 3333');
}, 30_000);

testWithSupabase('7. requirements and optional fields follow the workspace settings', async () => {
  const cv = 'https://example.com/cv.pdf';
  const letter = 'I would like to apply.';
  await setSettings(owner, { require_cv: true, require_cover_letter: true });

  const beforeRefusals = await countRows('hire_applications', owner, reqJob.id);
  expectWord(await apply({ p_job_id: reqJob.id, p_cover_letter: letter }), 'cv_required');
  expectWord(await apply({ p_job_id: reqJob.id, p_cv_url: cv }), 'cover_letter_required');
  // A letter with no visible character counts as none.
  expectWord(await apply({ p_job_id: reqJob.id, p_cv_url: cv, p_cover_letter: '  \n\t ' }), 'cover_letter_required');
  expect(await countRows('hire_applications', owner, reqJob.id)).toBe(beforeRefusals);

  const both = uniqueEmail();
  expectWord(await apply({ p_job_id: reqJob.id, p_email: both, p_cv_url: cv, p_cover_letter: `${letter}\n` }), 'ok');
  const bothApps = await applicationsOf((await candidateByEmail(both))[0].id);
  expect(bothApps).toHaveLength(1);
  expect(bothApps[0]).toMatchObject({ cv_url: cv, cover_letter: letter, portfolio_url: null, expected_salary_cents: null });

  await setSettings(owner, { ask_portfolio: true, ask_expected_salary: true });
  const asked = uniqueEmail();
  expectWord(
    await apply({
      p_job_id: reqJob.id,
      p_email: asked,
      p_cv_url: cv,
      p_cover_letter: letter,
      p_portfolio_url: 'https://example.com/work',
      p_expected_salary_cents: 350000,
    }),
    'ok',
  );
  const askedApps = await applicationsOf((await candidateByEmail(asked))[0].id);
  expect(askedApps).toHaveLength(1);
  expect(askedApps[0]).toMatchObject({
    cv_url: cv, cover_letter: letter, portfolio_url: 'https://example.com/work', expected_salary_cents: 350000,
  });
}, 60_000);

testWithSupabase('8. the members were told about a new application', async () => {
  const notes = await ownerNotifications();
  const note = notes.find((n) => n.body?.includes(NAME) && n.body.includes(openJob.title));
  expect(note, 'a notification for the case 3 application').toBeDefined();
  expect(note).toMatchObject({ title: 'New application', href: '/hire/applications' });
}, 30_000);

testWithSupabase('9. a board that is off takes no application', async () => {
  await setSettings(owner, { careers_enabled: false });
  const before = await snapshot();
  expectWord(await apply({ p_email: uniqueEmail() }), 'closed');
  expect(await snapshot()).toEqual(before);
  await setSettings(owner, { careers_enabled: true });
}, 30_000);

testWithSupabase('10. the demo workspace takes no application', async () => {
  const demoJobs = await viewer.from('hire_jobs').select('id').eq('org_id', demoId).limit(1);
  expect(demoJobs.error, demoJobs.error?.message).toBeNull();
  expect(demoJobs.data).toHaveLength(1);
  expectWord(await apply({ p_org_id: demoId, p_job_id: demoJobs.data![0].id }), 'closed');
}, 30_000);

testWithSupabase('11. a visitor has no access to the candidate or application tables', async () => {
  // Permission denied (42501), not an empty list: an empty list would also pass if the grant existed
  // and row-level security hid the rows.
  const candidates = await visitor.from('hire_candidates').select('id');
  expect(candidates.error?.code).toBe('42501');
  const applications = await visitor.from('hire_applications').select('id');
  expect(applications.error?.code).toBe('42501');
}, 30_000);

testWithSupabase("12. another workspace's owner reads none of these candidates or applications", async () => {
  // Control: the owner does see them.
  expect(await countRows('hire_candidates', owner)).toBeGreaterThan(0);
  expect(await countRows('hire_applications', owner)).toBeGreaterThan(0);

  const candidates = await other.c.from('hire_candidates').select('id');
  expect(candidates.error, candidates.error?.message).toBeNull();
  expect(candidates.data ?? []).toHaveLength(0);
  const applications = await other.c.from('hire_applications').select('id');
  expect(applications.error, applications.error?.message).toBeNull();
  expect(applications.data ?? []).toHaveLength(0);
}, 30_000);

testWithSupabase('13. the public job carries the four requirement columns, matching the settings, and no more', async () => {
  const mixed = { require_cv: true, require_cover_letter: false, ask_portfolio: true, ask_expected_salary: false };
  await setSettings(owner, mixed);
  const settings = await owner.c.from('hire_settings').select(SWITCHES).eq('org_id', owner.orgId).single();
  expect(settings.error, settings.error?.message).toBeNull();
  expect(settings.data).toEqual(mixed);

  const res = await publicJob(owner.orgId, openJob.id);
  expect(res.error, res.error?.message).toBeNull();
  const rows = res.data as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject(mixed);
  for (const key of FORBIDDEN_KEYS) expect(Object.keys(rows[0])).not.toContain(key);
  // The throttle cases below apply with the least a form asks for: no CV may be required by then.
  await setSettings(owner, ALL_OFF);
}, 30_000);

// The two throttle cases are last and each use their own fresh job: every accepted submission to a job
// counts toward its limit of 30 a minute.

testWithSupabase('14. the throttle: 30 accepted submissions to a job are ok and the 31st is throttled', async () => {
  const job = await freshOpenJob('throttle');
  for (let i = 0; i < 30; i++) {
    const res = await apply({ p_job_id: job.id });
    expect(res.error, `submission ${i + 1}: ${res.error?.message}`).toBeNull();
    expect(res.data, `submission ${i + 1}`).toBe('ok');
  }
  expectWord(await apply({ p_job_id: job.id }), 'throttled');
  expect(await countRows('hire_applications', owner, job.id)).toBe(30);
}, 120_000);

testWithSupabase('15. a repeat counts toward the limit, so it cannot be told from a new application', async () => {
  const job = await freshOpenJob('throttle repeat');
  const first = uniqueEmail();
  expectWord(await apply({ p_job_id: job.id, p_email: first }), 'ok');
  for (let i = 1; i < 29; i++) {
    const res = await apply({ p_job_id: job.id });
    expect(res.error, `submission ${i + 1}: ${res.error?.message}`).toBeNull();
    expect(res.data, `submission ${i + 1}`).toBe('ok');
  }
  // The 30th accepted submission is a repeat of the first email: ok, and it adds no row.
  expectWord(await apply({ p_job_id: job.id, p_email: first }), 'ok');
  // The 31st is refused, new email or not.
  expectWord(await apply({ p_job_id: job.id }), 'throttled');
  expect(await countRows('hire_applications', owner, job.id)).toBe(29);
}, 120_000);
