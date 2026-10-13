// tests/hire-jobs-writes.rls.test.ts
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient, signInOwner } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const client = liveClient;

const PREFIX = 'RLS test job';

async function ownedOrg(name: string) {
  const c = client();
  const { error: e1 } = await signInOwner(c);
  expect(e1, e1?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, name);
  expect(error, error?.message).toBeNull();
  return { c, orgId: orgId as string };
}

let owner: Awaited<ReturnType<typeof ownedOrg>>;
let other: Awaited<ReturnType<typeof ownedOrg>>;
let viewer: SupabaseClient;
let demoId: string;

async function newJob(title: string) {
  const ins = await owner.c
    .from('hire_jobs')
    .insert({ org_id: owner.orgId, title: `${PREFIX} ${title}` })
    .select('id, org_id, title, description, status, headcount, show_salary')
    .single();
  expect(ins.error, ins.error?.message).toBeNull();
  return ins.data!;
}

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  owner = await ownedOrg('Hire Jobs Writer Sdn Bhd');
  other = await ownedOrg('Hire Jobs Other Sdn Bhd');
  viewer = client();
  await signInAnon(viewer);
  const { data, error } = await joinDemo(viewer);
  expect(error, error?.message).toBeNull();
  demoId = data as string;
});

afterAll(async () => {
  await owner?.c.auth.signOut();
  await other?.c.auth.signOut();
  await viewer?.auth.signOut();
});

testWithSupabase('owner inserts a job with only org_id and title; defaults apply', async () => {
  const job = await newJob('defaults');
  expect(job.status).toBe('draft');
  expect(job.headcount).toBe(1);
  expect(job.show_salary).toBe(false);
});

testWithSupabase('owner updates title and description', async () => {
  const job = await newJob('edit me');
  const upd = await owner.c
    .from('hire_jobs')
    .update({ title: `${PREFIX} edited`, description: 'New description' })
    .eq('id', job.id)
    .select('title, description')
    .single();
  expect(upd.error, upd.error?.message).toBeNull();
  const back = await owner.c.from('hire_jobs').select('title, description').eq('id', job.id).single();
  expect(back.error, back.error?.message).toBeNull();
  expect(back.data).toEqual({ title: `${PREFIX} edited`, description: 'New description' });
});

testWithSupabase('owner cannot move a job to another workspace', async () => {
  const job = await newJob('stay put');
  // org_id is outside the column-level update grant, so this errors; either way the row must not move.
  await owner.c.from('hire_jobs').update({ org_id: other.orgId }).eq('id', job.id).select('id');
  const back = await owner.c.from('hire_jobs').select('org_id').eq('id', job.id).single();
  expect(back.error, back.error?.message).toBeNull();
  expect(back.data!.org_id).toBe(owner.orgId);
  const seenByOther = await other.c.from('hire_jobs').select('id').eq('id', job.id);
  expect(seenByOther.data ?? []).toHaveLength(0);
});

testWithSupabase('database checks reject bad headcount, salary range and work arrangement', async () => {
  const job = await newJob('checks');
  const zero = await owner.c.from('hire_jobs').update({ headcount: 0 }).eq('id', job.id);
  expect(zero.error, 'headcount 0 must be rejected').not.toBeNull();
  const range = await owner.c
    .from('hire_jobs')
    .update({ salary_min_cents: 500000, salary_max_cents: 100000 })
    .eq('id', job.id);
  expect(range.error, 'max below min must be rejected').not.toBeNull();
  const moon = await owner.c.from('hire_jobs').update({ work_arrangement: 'moon' }).eq('id', job.id);
  expect(moon.error, 'unknown work arrangement must be rejected').not.toBeNull();
  const back = await owner.c
    .from('hire_jobs')
    .select('headcount, salary_min_cents, salary_max_cents, work_arrangement')
    .eq('id', job.id)
    .single();
  expect(back.data).toEqual({
    headcount: 1,
    salary_min_cents: null,
    salary_max_cents: null,
    work_arrangement: null,
  });
});

testWithSupabase('a user in another workspace cannot see, update or delete the job', async () => {
  const job = await newJob('private');
  const seen = await other.c.from('hire_jobs').select('id').eq('id', job.id);
  expect(seen.error).toBeNull();
  expect(seen.data ?? []).toHaveLength(0);

  const upd = await other.c.from('hire_jobs').update({ title: `${PREFIX} hacked` }).eq('id', job.id).select('id');
  expect(upd.data ?? []).toHaveLength(0);
  const del = await other.c.from('hire_jobs').delete().eq('id', job.id).select('id');
  expect(del.data ?? []).toHaveLength(0);

  const still = await owner.c.from('hire_jobs').select('title').eq('id', job.id).single();
  expect(still.error, still.error?.message).toBeNull();
  expect(still.data!.title).toBe(`${PREFIX} private`);
});

testWithSupabase('a viewer (demo member) cannot write jobs', async () => {
  expect(demoId).toBeTruthy();
  const ins = await viewer.from('hire_jobs').insert({ org_id: demoId, title: `${PREFIX} viewer insert` });
  expect(ins.error, 'a viewer insert must be rejected').not.toBeNull();

  const before = await viewer.from('hire_jobs').select('id, title').eq('org_id', demoId).limit(1);
  expect(before.error, before.error?.message).toBeNull();
  expect(before.data ?? [], 'the demo workspace should have a job to try').toHaveLength(1);
  const demoJob = before.data![0];

  const upd = await viewer.from('hire_jobs').update({ title: `${PREFIX} viewer edit` }).eq('id', demoJob.id).select('id');
  expect(upd.data ?? []).toHaveLength(0);
  const del = await viewer.from('hire_jobs').delete().eq('id', demoJob.id).select('id');
  expect(del.data ?? []).toHaveLength(0);

  const after = await viewer.from('hire_jobs').select('title').eq('id', demoJob.id).single();
  expect(after.error, after.error?.message).toBeNull();
  expect(after.data!.title).toBe(demoJob.title);
  const leaked = await viewer.from('hire_jobs').select('id').eq('org_id', demoId).like('title', `${PREFIX}%`);
  expect(leaked.data ?? []).toHaveLength(0);
});

testWithSupabase('owner deletes their own job', async () => {
  const job = await newJob('delete me');
  const del = await owner.c.from('hire_jobs').delete().eq('id', job.id).select('id');
  expect(del.error, del.error?.message).toBeNull();
  expect(del.data).toHaveLength(1);
  const gone = await owner.c.from('hire_jobs').select('id').eq('id', job.id);
  expect(gone.data ?? []).toHaveLength(0);
});
