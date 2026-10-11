// tests/hire-careers.rls.test.ts
import { beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { createAnonymousClient } from '@/lib/supabase/anonymous';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient, beforeCleanup } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const client = liveClient;

const PREFIX = 'RLS careers job';
const OWNER_ORG_NAME = 'Hire Careers Owner Sdn Bhd';
const FORBIDDEN_KEYS = ['headcount', 'status', 'created_at', 'closed_at'];

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
let empty: Owned;
let viewer: SupabaseClient;
let visitor: SupabaseClient;
let demoId: string;

// Jobs of the owner's workspace, one per state the board must tell apart.
let openJob: { id: string };
let blankJob: { id: string };
let draftJob: { id: string };
let pausedJob: { id: string };
let closedJob: { id: string };
let salaryShownJob: { id: string };
let salaryHiddenJob: { id: string };
// An open, described job of the second workspace.
let otherJob: { id: string };

async function newJob(who: Owned, title: string, fields: Record<string, unknown> = {}) {
  const ins = await who.c
    .from('hire_jobs')
    .insert({ org_id: who.orgId, title: `${PREFIX} ${title}`, ...fields })
    .select('id')
    .single();
  expect(ins.error, ins.error?.message).toBeNull();
  return ins.data as { id: string };
}

const openFields = (description = 'A real description of the role.') => ({
  status: 'open',
  description,
  opened_at: new Date().toISOString(),
});

/** Writes the board's settings row as the workspace's owner. */
async function switchBoardOn(who: Owned, extra: Record<string, unknown> = {}) {
  const res = await who.c
    .from('hire_settings')
    .insert({ org_id: who.orgId, careers_enabled: true, ...extra })
    .select('org_id, careers_enabled')
    .single();
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data!.careers_enabled).toBe(true);
}

/** A call that must give nothing: an error or an empty list both count. */
function expectNoRows(res: { data: unknown; error: unknown }) {
  expect(Array.isArray(res.data) ? res.data : []).toHaveLength(0);
}

/** A call on the public functions must succeed and give nothing. */
function expectEmptyResult(res: { data: unknown; error: { message: string } | null }) {
  expect(res.error, res.error?.message).toBeNull();
  expectNoRows(res);
}

const careers = (orgId: string) => visitor.rpc('get_public_careers', { p_org_id: orgId });
const job = (orgId: string, jobId: string) =>
  visitor.rpc('get_public_job', { p_org_id: orgId, p_job_id: jobId });

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  owner = await ownedOrg(OWNER_ORG_NAME);
  other = await ownedOrg('Hire Careers Other Sdn Bhd');
  empty = await ownedOrg('Hire Careers Empty Sdn Bhd');
  viewer = client();
  await signInAnon(viewer);
  const { data, error } = await joinDemo(viewer);
  expect(error, error?.message).toBeNull();
  demoId = data as string;
  visitor = createAnonymousClient();

  openJob = await newJob(owner, 'open', openFields());
  blankJob = await newJob(owner, 'blank', openFields('placeholder'));
  const blank = await owner.c.from('hire_jobs').update({ description: '  \n\t ' }).eq('id', blankJob.id);
  expect(blank.error, blank.error?.message).toBeNull();
  draftJob = await newJob(owner, 'draft', { status: 'draft', description: 'Draft description.' });
  pausedJob = await newJob(owner, 'paused', { ...openFields(), status: 'paused' });
  closedJob = await newJob(owner, 'closed', { ...openFields(), status: 'closed', closed_at: new Date().toISOString() });
  const salary = { salary_min_cents: 500000, salary_max_cents: 800000 };
  salaryShownJob = await newJob(owner, 'salary shown', { ...openFields(), ...salary, show_salary: true });
  salaryHiddenJob = await newJob(owner, 'salary hidden', { ...openFields(), ...salary, show_salary: false });
  otherJob = await newJob(other, 'other open', openFields());
  // The empty workspace: a draft only, so its board will have no open job.
  await newJob(empty, 'empty draft', { status: 'draft', description: 'Not open.' });
});

// If the cleanup cannot delete the workspaces (no key, migration not applied), they must not
// keep a public board switched on, so this runs first inside the helper's cleanup.
beforeCleanup(async () => {
  for (const who of [owner, other, empty]) {
    if (!who) continue;
    await who.c.from('hire_settings').update({ careers_enabled: false }).eq('org_id', who.orgId);
  }
});

// The cases run in file order: case 1 needs the owner's board still off, case 2 switches it on.

testWithSupabase('1. board off: nothing for the list and nothing for an open, described job', async () => {
  expectEmptyResult(await careers(owner.orgId));
  expectEmptyResult(await job(owner.orgId, openJob.id));
});

testWithSupabase('2. board on: the workspace name and exactly the open jobs with a description', async () => {
  await switchBoardOn(owner, { careers_headline: 'Join us', careers_tagline: 'Build with us' });
  const res = await careers(owner.orgId);
  expect(res.error, res.error?.message).toBeNull();
  const rows = res.data as Array<Record<string, unknown>>;
  const listed = rows.map((r) => r.job_id as string).sort();
  const expected = [openJob.id, salaryShownJob.id, salaryHiddenJob.id].sort();
  expect(listed).toEqual(expected);
  for (const excluded of [blankJob.id, draftJob.id, pausedJob.id, closedJob.id]) {
    expect(listed).not.toContain(excluded);
  }
  for (const r of rows) {
    expect(r.org_name).toBe(OWNER_ORG_NAME);
    expect(r.headline).toBe('Join us');
    expect(r.tagline).toBe('Build with us');
  }
  const opened = rows.find((r) => r.job_id === openJob.id)!;
  expect(opened.title).toBe(`${PREFIX} open`);
  expect(opened.accepting).toBe(true);
});

testWithSupabase('3. a job page is not given for a draft, paused, closed or blank-description job', async () => {
  // Control: the same call does return the open job, so an empty answer below is not a broken call.
  const control = await job(owner.orgId, openJob.id);
  expect(control.error, control.error?.message).toBeNull();
  expect(control.data).toHaveLength(1);
  expect((control.data as Array<Record<string, unknown>>)[0].description).toBe('A real description of the role.');

  for (const id of [draftJob.id, pausedJob.id, closedJob.id, blankJob.id]) {
    expectEmptyResult(await job(owner.orgId, id));
  }
});

testWithSupabase('4. the salary is given only when the job shows it', async () => {
  const shown = await job(owner.orgId, salaryShownJob.id);
  expect(shown.error, shown.error?.message).toBeNull();
  expect(shown.data).toHaveLength(1);
  const shownRow = (shown.data as Array<Record<string, unknown>>)[0];
  expect(Number(shownRow.salary_min_cents)).toBe(500000);
  expect(Number(shownRow.salary_max_cents)).toBe(800000);

  const hidden = await job(owner.orgId, salaryHiddenJob.id);
  expect(hidden.error, hidden.error?.message).toBeNull();
  expect(hidden.data).toHaveLength(1);
  const hiddenRow = (hidden.data as Array<Record<string, unknown>>)[0];
  expect(hiddenRow.title).toBe(`${PREFIX} salary hidden`);
  expect(hiddenRow.salary_min_cents).toBeNull();
  expect(hiddenRow.salary_max_cents).toBeNull();
});

testWithSupabase("5. another workspace's job is not given under this workspace's address", async () => {
  await switchBoardOn(other);
  // Control: under its own address the other workspace's job is given.
  const own = await job(other.orgId, otherJob.id);
  expect(own.error, own.error?.message).toBeNull();
  expect(own.data).toHaveLength(1);

  expectEmptyResult(await job(owner.orgId, otherJob.id));
  expectEmptyResult(await job(other.orgId, openJob.id));
  const listed = ((await careers(owner.orgId)).data as Array<{ job_id: string | null }>).map((r) => r.job_id);
  expect(listed).not.toContain(otherJob.id);
});

testWithSupabase('6. a board that is on with no open jobs gives the name and a null job id', async () => {
  await switchBoardOn(empty);
  const res = await careers(empty.orgId);
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data).toHaveLength(1);
  const row = (res.data as Array<Record<string, unknown>>)[0];
  expect(row.org_name).toBe('Hire Careers Empty Sdn Bhd');
  expect(row.job_id).toBeNull();
  expect(row.title).toBeNull();
});

testWithSupabase('7. the demo workspace gives nothing from either function', async () => {
  expect(demoId).toBeTruthy();
  // The demo board is never on, so this is true trivially; the exclusion by slug itself is
  // asserted by the migration text test (tests/hire-settings-migration.test.ts).
  expectEmptyResult(await careers(demoId));
  const demoJobs = await viewer.from('hire_jobs').select('id').eq('org_id', demoId).limit(1);
  expect(demoJobs.error, demoJobs.error?.message).toBeNull();
  expect(demoJobs.data).toHaveLength(1);
  expectEmptyResult(await job(demoId, demoJobs.data![0].id));
});

testWithSupabase('8. a visitor cannot read the tables directly', async () => {
  // Permission denied (42501), not an empty list: an empty list would also pass if the grant existed and
  // row-level security hid the rows.
  const jobs = await visitor.from('hire_jobs').select('id');
  expect(jobs.error?.code).toBe('42501');
  const settings = await visitor.from('hire_settings').select('org_id');
  expect(settings.error?.code).toBe('42501');
});

testWithSupabase('9. a viewer cannot write settings and a writer cannot move the row', async () => {
  // A viewer (demo member) tries to switch the demo board on.
  const ins = await viewer
    .from('hire_settings')
    .insert({ org_id: demoId, careers_enabled: true })
    .select('org_id');
  expect(ins.error !== null || (ins.data ?? []).length === 0, 'a viewer insert must error or change nothing').toBe(true);
  const upd = await viewer.from('hire_settings').update({ careers_enabled: true }).eq('org_id', demoId).select('org_id');
  expect(upd.error !== null || (upd.data ?? []).length === 0, 'a viewer update must error or change nothing').toBe(true);
  const seen = await viewer.from('hire_settings').select('org_id').eq('org_id', demoId).eq('careers_enabled', true);
  expect(seen.error, seen.error?.message).toBeNull();
  expect(seen.data ?? []).toHaveLength(0);

  // The owner (a writer) cannot point their own row at another workspace: org_id is outside the update grant.
  const move = await owner.c
    .from('hire_settings')
    .update({ org_id: other.orgId })
    .eq('org_id', owner.orgId)
    .select('org_id');
  expect(move.error, 'changing org_id must be rejected').not.toBeNull();
  const back = await owner.c.from('hire_settings').select('org_id, careers_enabled').eq('org_id', owner.orgId).single();
  expect(back.error, back.error?.message).toBeNull();
  expect(back.data).toEqual({ org_id: owner.orgId, careers_enabled: true });
});

testWithSupabase('10. returned rows carry no headcount, status, created_at or closed_at', async () => {
  const list = await careers(owner.orgId);
  expect(list.error, list.error?.message).toBeNull();
  const listRows = list.data as Array<Record<string, unknown>>;
  expect(listRows.length).toBeGreaterThan(0);
  const one = await job(owner.orgId, openJob.id);
  expect(one.error, one.error?.message).toBeNull();
  const oneRows = one.data as Array<Record<string, unknown>>;
  expect(oneRows).toHaveLength(1);
  for (const row of [...listRows, ...oneRows]) {
    for (const key of FORBIDDEN_KEYS) expect(Object.keys(row)).not.toContain(key);
  }
});

// Last on purpose: it switches the owner's board off, and cases 2 to 10 need it on.
testWithSupabase('11. (runs last, after every case that needs the board on) the owner switches the board off: both functions give nothing', async () => {
  const off = await owner.c
    .from('hire_settings')
    .update({ careers_enabled: false })
    .eq('org_id', owner.orgId)
    .select('org_id, careers_enabled')
    .single();
  expect(off.error, off.error?.message).toBeNull();
  expect(off.data!.careers_enabled).toBe(false);
  expectEmptyResult(await careers(owner.orgId));
  expectEmptyResult(await job(owner.orgId, openJob.id));
});
