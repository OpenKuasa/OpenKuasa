// tests/hire-talent-pool.rls.test.ts
//
// Live checks of the talent pool functions (Lekir slice 3d): public.hire_set_pool_status and
// public.hire_move_to_pipeline, and the one change to public.hire_add_candidate (a new person added with no job
// is saved in the pool as `available`).
// Needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY; without all
// three every case is skipped.
// WRITTEN, NOT YET RUN: it runs only after the migration 20261029090000_hire_talent_pool.sql is applied (and 3c's
// 20261028093000_hire_deletions.sql, which case 22 needs for hire_delete_application).
//
// Who calls what. Both pool functions and hire_add_candidate are granted to `authenticated` only, so every call is
// made by a signed-in client (the owner, the owner of another workspace, a demo viewer) or by the signed-out
// visitor client, which must be refused outright (42501). The service client is not used to change anything: it
// is only passed to the shared helper's cleanup.
//
// The viewer case. A viewer made the way the other live files make one (joining the demo workspace) is not a
// member of a throwaway workspace, so against the OWNER's workspace that viewer is a stranger and the right word
// is `not_found`. The word `forbidden` is only true for a viewer who is a member of the workspace, so it is
// proven against a seeded DEMO row, read by id. Nothing is written to the demo workspace, and the shared
// workspace is never compared before and after (another run or a reseed changes it): the row the viewer tried to
// change is read again by id and its own pool status must be what it was.
//
// A gap. The migration 20261029090100_hire_talent_pool_backfill.sql, which moves the people already added by
// hand with no job into the pool, is NOT tested here. It is one statement in a migration file, not a function,
// and no member may update the table, so it cannot be run from a test. Its rule is pinned by Task 1's text test,
// and its effect on live is checked by the controller with counts read before and after. Case 22 proves the other
// half: after the migration nothing but a person's own action puts a careers-page applicant in the pool.
//
// A known gap, pinned on purpose (case 23). A status change sent from a stale screen for someone a colleague has
// just removed from the pool answers `ok` with `from: 'none'` and puts them back in the pool. The function
// cannot tell that apart from a deliberate add. When that is fixed, case 23 is the test to change.
//
// What stays behind. Every candidate and application this file creates cannot be removed by a user, so they go
// with the throwaway workspaces when the shared live-workspaces helper deletes them (and the anonymous users) at
// the end. A beforeCleanup step switches the careers board off first, so a leaked workspace has no public page.
import { beforeAll, expect, test } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAnonymousClient } from '@/lib/supabase/anonymous';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { beforeCleanup, createOrg, joinDemo, liveClient, signInAnon, signInOwner } from './helpers/live-workspaces';

const hasService = hasSupabaseEnv && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const testWithSupabase = hasService ? test : test.skip;
if (!hasService) {
  console.warn(
    hasSupabaseEnv
      ? 'Set SUPABASE_SERVICE_ROLE_KEY in .env.local to run the talent pool checks'
      : supabaseEnvSkipReason,
  );
}

const client = liveClient;

const PREFIX = 'RLS pool job';
const ALL_OFF = { require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false };
const RUN = Date.now();
const NONE = '00000000-0000-4000-8000-000000000000';
const CANDIDATE_SELECT = 'id, name, email, phone, headline, location, skills, source, pool_status';

let emailCounter = 0;
/** A lowercase address that no earlier run can have used. */
const uniqueEmail = () => `rls-pool-${RUN}-${++emailCounter}@example.com`;

async function ownedOrg(name: string) {
  const c = client();
  const { error: e1 } = await signInOwner(c);
  expect(e1, e1?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, name);
  expect(error, error?.message).toBeNull();
  return { c, orgId: orgId as string };
}

type Owned = Awaited<ReturnType<typeof ownedOrg>>;

type Res = { data: unknown; error: { message: string; code?: string } | null };

type CandidateRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  headline: string | null;
  location: string | null;
  skills: string[];
  source: string | null;
  pool_status: string;
};

type Added = {
  word: string;
  candidate_id?: string;
  application_id?: string | null;
  candidate?: string;
  application?: string;
};

let owner: Owned;
let other: Owned;
let viewer: SupabaseClient; // a viewer of the DEMO workspace
let visitor: SupabaseClient; // no session
let demoId: string;

let openJob: { id: string; title: string };
let secondJob: { id: string; title: string };
let pausedJob: { id: string; title: string };
let draftJob: { id: string; title: string };
let closedJob: { id: string; title: string };
let otherJob: { id: string; title: string };

async function newJob(who: Owned, title: string, fields: Record<string, unknown>) {
  const full = `${PREFIX} ${title}`;
  const ins = await who.c.from('hire_jobs').insert({ org_id: who.orgId, title: full, ...fields }).select('id').single();
  expect(ins.error, ins.error?.message).toBeNull();
  return { id: (ins.data as { id: string }).id, title: full };
}

const openFields = () => ({
  status: 'open',
  description: 'A real description of the role.',
  opened_at: new Date().toISOString(),
});

async function switchBoardOn(who: Owned) {
  const res = await who.c
    .from('hire_settings')
    .insert({ org_id: who.orgId, careers_enabled: true })
    .select('org_id, careers_enabled')
    .single();
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data!.careers_enabled).toBe(true);
}

type AddArgs = Partial<{
  name: string | null;
  email: string | null;
  phone: string | null;
  headline: string | null;
  location: string | null;
  skills: string[] | null;
  source: string | null;
  job_id: string | null;
  cover_letter: string | null;
  cv_url: string | null;
}>;

/** hire_add_candidate with every optional argument defaulting to null, as the function does. */
const add = (c: SupabaseClient, orgId: string, a: AddArgs = {}) =>
  c.rpc('hire_add_candidate', {
    p_org_id: orgId,
    p_name: a.name === undefined ? 'Farid Osman' : a.name,
    p_email: a.email ?? null,
    p_phone: a.phone ?? null,
    p_headline: a.headline ?? null,
    p_location: a.location ?? null,
    p_skills: a.skills ?? null,
    p_source: a.source ?? null,
    p_job_id: a.job_id ?? null,
    p_cover_letter: a.cover_letter ?? null,
    p_cv_url: a.cv_url ?? null,
  });

const update = (c: SupabaseClient, id: string, changes: unknown) =>
  c.rpc('hire_update_candidate', { p_candidate_id: id, p_changes: changes });

/** The function must answer with exactly this word and no error: an error for another reason cannot pass. */
function expectWord(res: Res, word: string) {
  expect(res.error, res.error?.message).toBeNull();
  const answer = res.data;
  const got = answer && typeof answer === 'object' ? (answer as { word?: unknown }).word : answer;
  expect(got).toBe(word);
}

/** An `ok` add, with the data it answered. */
function expectAdded(res: Res, candidate: string, application: string): Added {
  expectWord(res, 'ok');
  const data = res.data as Added;
  expect(data.candidate, 'candidate').toBe(candidate);
  expect(data.application, 'application').toBe(application);
  expect(typeof data.candidate_id).toBe('string');
  return data;
}

/** A signed-out caller is refused before the function runs. */
function expectRefusedOutright(res: Res, label: string) {
  expect(res.error, `${label}: expected a permission error`).not.toBeNull();
  expect(res.error?.code, `${label}: ${res.error?.message}`).toBe('42501');
  expect(res.data ?? null, `${label}: no answer`).toBeNull();
}

/** Sends a public application the way the careers page does, for the careers-page and race cases. */
const sendPublicApplication = (c: SupabaseClient, orgId: string, jobId: string, a: { name?: string; email: string; consent: boolean }) =>
  c.rpc('submit_public_application', {
    p_org_id: orgId,
    p_job_id: jobId,
    p_name: a.name ?? 'Public Applicant',
    p_email: a.email,
    p_phone: null,
    p_cover_letter: null,
    p_cv_url: null,
    p_portfolio_url: null,
    p_expected_salary_cents: null,
    p_consent: a.consent,
    p_honeypot: null,
  });

const setStatus = (c: SupabaseClient, id: string, status: string | null, onlyIfOutside?: boolean) =>
  c.rpc('hire_set_pool_status', {
    p_candidate_id: id, p_status: status, ...(onlyIfOutside === undefined ? {} : { p_only_if_outside: onlyIfOutside }),
  });
const move = (c: SupabaseClient, id: string, jobId: string) =>
  c.rpc('hire_move_to_pipeline', { p_candidate_id: id, p_job_id: jobId });

type PoolAnswer = { word: string; from?: string; to?: string; application_id?: string; outcome?: string };

/** An answer with exactly this word and, where given, these other keys. */
function expectAnswer(res: Res, word: string, rest: Partial<PoolAnswer> = {}): PoolAnswer {
  expectWord(res, word);
  expect(res.data).toMatchObject(rest);
  return res.data as PoolAnswer;
}

const poolStatusOf = async (c: SupabaseClient, id: string) => {
  const res = await c.from('hire_candidates').select('pool_status').eq('id', id).maybeSingle();
  expect(res.error, res.error?.message).toBeNull();
  return (res.data as { pool_status: string } | null)?.pool_status ?? null;
};

async function readCandidate(c: SupabaseClient, id: string): Promise<CandidateRow> {
  const res = await c.from('hire_candidates').select(CANDIDATE_SELECT).eq('id', id).single();
  expect(res.error, res.error?.message).toBeNull();
  return res.data as CandidateRow;
}

async function candidatesByEmail(c: SupabaseClient, orgId: string, email: string): Promise<CandidateRow[]> {
  const res = await c.from('hire_candidates').select(CANDIDATE_SELECT).eq('org_id', orgId).eq('email', email.toLowerCase());
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? []) as CandidateRow[];
}

type MovedRow = {
  id: string;
  stage: string;
  outcome: string;
  source: string | null;
  consented_at: string | null;
  cover_letter: string | null;
  cv_url: string | null;
  cv_path: string | null;
};
/** Every application this candidate has to this job: there must never be more than one. */
const applicationsFor = async (c: SupabaseClient, candidateId: string, jobId: string): Promise<MovedRow[]> => {
  const res = await c
    .from('hire_applications')
    .select('id, stage, outcome, source, consented_at, cover_letter, cv_url, cv_path')
    .eq('candidate_id', candidateId)
    .eq('job_id', jobId);
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? []) as MovedRow[];
};

/** How many applications a workspace holds, as its own owner reads them. */
const applicationCount = async (who: Owned) => {
  const res = await who.c.from('hire_applications').select('id').eq('org_id', who.orgId);
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? []).length;
};

/** A candidate with no job: since this migration, saved in the pool as available. Returns the id. */
async function person(who: Owned, over: AddArgs = {}): Promise<string> {
  const added = expectAdded(await add(who.c, who.orgId, over), 'created', 'none');
  return added.candidate_id!;
}

beforeAll(async () => {
  if (!hasService) return;
  owner = await ownedOrg('Hire Pool Owner Sdn Bhd');
  other = await ownedOrg('Hire Pool Other Sdn Bhd');
  viewer = client();
  await signInAnon(viewer);
  const joined = await joinDemo(viewer);
  expect(joined.error, joined.error?.message).toBeNull();
  demoId = joined.data as string;
  visitor = createAnonymousClient();

  await switchBoardOn(owner);
  const set = await owner.c.from('hire_settings').update(ALL_OFF).eq('org_id', owner.orgId).select('org_id').single();
  expect(set.error, set.error?.message).toBeNull();

  openJob = await newJob(owner, 'open', openFields());
  secondJob = await newJob(owner, 'second', openFields());
  pausedJob = await newJob(owner, 'paused', { ...openFields(), status: 'paused' });
  draftJob = await newJob(owner, 'draft', {});
  closedJob = await newJob(owner, 'closed', {
    ...openFields(),
    status: 'closed',
    closed_at: new Date().toISOString(),
  });
  otherJob = await newJob(other, 'open', openFields());
}, 120_000);

// Runs first inside the helper's cleanup, while the workspaces still exist: switch the careers board off.
beforeCleanup(async () => {
  if (!hasService) return;
  if (owner) await owner.c.from('hire_settings').update({ careers_enabled: false }).eq('org_id', owner.orgId);
});

// The cases run in file order: later ones may read what earlier ones wrote.

let outsider: string; // added with a job, so not in the pool

testWithSupabase('1. a person outside the pool is added with the add-only switch: none to available', async () => {
  // Added WITH a job, so they are `none` (`person` is not used: it puts its candidate in the pool).
  const added = expectAdded(await add(owner.c, owner.orgId, { email: uniqueEmail(), job_id: openJob.id }), 'created', 'created');
  outsider = added.candidate_id!;
  expect(await poolStatusOf(owner.c, outsider)).toBe('none');

  expectAnswer(await setStatus(owner.c, outsider, 'available', true), 'ok', { from: 'none', to: 'available' });
  expect(await poolStatusOf(owner.c, outsider)).toBe('available');
}, 60_000);

testWithSupabase('2. the same add again: already_in_pool, and they are left as they are', async () => {
  expectAnswer(await setStatus(owner.c, outsider, 'passive', true), 'already_in_pool', { from: 'available' });
  expect(await poolStatusOf(owner.c, outsider)).toBe('available');
}, 60_000);

testWithSupabase('3. a status change reports where it came from and where it went', async () => {
  expectAnswer(await setStatus(owner.c, outsider, 'passive'), 'ok', { from: 'available', to: 'passive' });
  expect(await poolStatusOf(owner.c, outsider)).toBe('passive');
  expectAnswer(await setStatus(owner.c, outsider, 're_engaged', false), 'ok', { from: 'passive', to: 're_engaged' });
  expect(await poolStatusOf(owner.c, outsider)).toBe('re_engaged');
}, 60_000);

testWithSupabase('4. a status sent twice: same_status, unchanged', async () => {
  expectAnswer(await setStatus(owner.c, outsider, 're_engaged'), 'same_status', { from: 're_engaged' });
  expect(await poolStatusOf(owner.c, outsider)).toBe('re_engaged');
}, 60_000);

testWithSupabase('5. removing from the pool keeps the person and their application', async () => {
  const before = await readCandidate(owner.c, outsider);
  expectAnswer(await setStatus(owner.c, outsider, 'none'), 'ok', { from: 're_engaged', to: 'none' });
  const after = await readCandidate(owner.c, outsider);
  expect(after).toEqual({ ...before, pool_status: 'none' });
  expect(await applicationsFor(owner.c, outsider, openJob.id)).toHaveLength(1);
}, 60_000);

testWithSupabase('6. removing again: same_status from none', async () => {
  expectAnswer(await setStatus(owner.c, outsider, 'none'), 'same_status', { from: 'none' });
  expect(await poolStatusOf(owner.c, outsider)).toBe('none');
}, 60_000);

testWithSupabase('7. a status outside the list, and none with the add-only switch: invalid_status, unchanged', async () => {
  const id = await person(owner);
  expect(await poolStatusOf(owner.c, id)).toBe('available');
  for (const status of ['shortlisted', '', null]) {
    expectWord(await setStatus(owner.c, id, status), 'invalid_status');
    expect(await poolStatusOf(owner.c, id), `after ${JSON.stringify(status)}`).toBe('available');
  }
  expectWord(await setStatus(owner.c, id, 'none', true), 'invalid_status');
  expect(await poolStatusOf(owner.c, id)).toBe('available');
}, 60_000);

testWithSupabase('8. an id that does not exist: not_found on both functions', async () => {
  expectWord(await setStatus(owner.c, NONE, 'available'), 'not_found');
  expectWord(await move(owner.c, NONE, openJob.id), 'not_found');
}, 60_000);

let moved: { id: string; applicationId: string };

testWithSupabase('9. a pool member moved to an open job: one application at applied, active, no consent, and re_engaged', async () => {
  const id = await person(owner, { source: 'Referral', email: uniqueEmail() });
  expect(await poolStatusOf(owner.c, id)).toBe('available');

  const answer = expectAnswer(await move(owner.c, id, openJob.id), 'ok', { from: 'available', to: 're_engaged' });
  expect(typeof answer.application_id).toBe('string');

  const apps = await applicationsFor(owner.c, id, openJob.id);
  expect(apps).toHaveLength(1);
  expect(apps[0]).toMatchObject({
    id: answer.application_id,
    stage: 'applied',
    outcome: 'active',
    source: 'Referral',
    consented_at: null,
    cover_letter: null,
    cv_url: null,
    cv_path: null,
  });
  expect(await poolStatusOf(owner.c, id)).toBe('re_engaged');
  moved = { id, applicationId: answer.application_id! };
}, 60_000);

testWithSupabase('10. a paused job, a candidate with no source and no email; a re-engaged person can be moved again', async () => {
  const id = await person(owner);
  expectWord(await update(owner.c, id, { source: null }), 'ok');
  expect((await readCandidate(owner.c, id)).source, 'the candidate truly has no source').toBeNull();
  expectAnswer(await setStatus(owner.c, id, 'passive'), 'ok', { to: 'passive' });

  const first = expectAnswer(await move(owner.c, id, pausedJob.id), 'ok', { from: 'passive', to: 're_engaged' });
  const apps = await applicationsFor(owner.c, id, pausedJob.id);
  expect(apps).toHaveLength(1);
  expect(apps[0]).toMatchObject({ id: first.application_id, source: 'Added by hand', stage: 'applied', outcome: 'active' });
  expect(await poolStatusOf(owner.c, id)).toBe('re_engaged');

  // Someone already Re-engaged can be moved again, to another job.
  expectAnswer(await move(owner.c, id, secondJob.id), 'ok', { from: 're_engaged', to: 're_engaged' });
  expect(await applicationsFor(owner.c, id, secondJob.id)).toHaveLength(1);
  expect(await applicationsFor(owner.c, id, pausedJob.id)).toHaveLength(1);
}, 60_000);

testWithSupabase('11. a second move to the same job: already_applied, the same application, still one', async () => {
  expectAnswer(await move(owner.c, moved.id, openJob.id), 'already_applied', {
    outcome: 'active',
    application_id: moved.applicationId,
  });
  expect(await applicationsFor(owner.c, moved.id, openJob.id)).toHaveLength(1);
  expect(await poolStatusOf(owner.c, moved.id)).toBe('re_engaged');
}, 60_000);

testWithSupabase('12. already applied changes nothing, the pool status included', async () => {
  const email = uniqueEmail();
  const id = await person(owner, { email });
  const byHand = expectAdded(await add(owner.c, owner.orgId, { email, job_id: secondJob.id }), 'existing', 'created');
  expect(byHand.candidate_id).toBe(id);
  expectAnswer(await setStatus(owner.c, id, 'passive'), 'ok', { from: 'available', to: 'passive' });

  const closed = await owner.c.rpc('hire_close_application', {
    p_application_id: byHand.application_id,
    p_outcome: 'rejected',
    p_reason: 'experience',
  });
  expect(closed.error, closed.error?.message).toBeNull();
  expect(closed.data).toBe('ok');

  expectAnswer(await move(owner.c, id, secondJob.id), 'already_applied', {
    outcome: 'rejected',
    application_id: byHand.application_id!,
  });
  expect(await poolStatusOf(owner.c, id), 'not marked re-engaged').toBe('passive');
  expect(await applicationsFor(owner.c, id, secondJob.id)).toHaveLength(1);
}, 60_000);

testWithSupabase('13. a job that takes no applications, and a job that is not there: nothing is written', async () => {
  const id = await person(owner);
  const refusals: Array<[string, string, string]> = [
    ['a draft job', draftJob.id, 'job_not_open'],
    ['a closed job', closedJob.id, 'job_not_open'],
    ['another workspace\'s job', otherJob.id, 'job_not_found'],
    ['a job that does not exist', NONE, 'job_not_found'],
  ];
  for (const [label, jobId, word] of refusals) {
    expectWord(await move(owner.c, id, jobId), word);
    expect(await applicationsFor(owner.c, id, jobId), `after ${label}`).toHaveLength(0);
    expect(await poolStatusOf(owner.c, id), `after ${label}`).toBe('available');
  }
}, 60_000);

testWithSupabase('14. a person not in the pool: not_in_pool, no application, still none', async () => {
  const added = expectAdded(await add(owner.c, owner.orgId, { email: uniqueEmail(), job_id: openJob.id }), 'created', 'created');
  const id = added.candidate_id!;
  expectWord(await move(owner.c, id, secondJob.id), 'not_in_pool');
  expect(await applicationsFor(owner.c, id, secondJob.id)).toHaveLength(0);
  expect(await poolStatusOf(owner.c, id)).toBe('none');
}, 60_000);

testWithSupabase('15. two moves for one person and one job at once: one application', async () => {
  for (let i = 0; i < 5; i++) {
    const id = await person(owner, { email: uniqueEmail() });
    const both = (await Promise.all([move(owner.c, id, openJob.id), move(owner.c, id, openJob.id)])) as Res[];
    for (const res of both) expect(res.error, res.error?.message).toBeNull();
    const words = both.map((res) => (res.data as { word: string }).word).sort();
    expect(words, `round ${i + 1}`).toEqual(['already_applied', 'ok']);
    expect(await applicationsFor(owner.c, id, openJob.id), `round ${i + 1}`).toHaveLength(1);
    expect(await poolStatusOf(owner.c, id), `round ${i + 1}`).toBe('re_engaged');
  }
}, 120_000);

testWithSupabase('16. a move racing the public form for one email and one job: one candidate, one application', async () => {
  for (let i = 0; i < 5; i++) {
    const email = uniqueEmail();
    const id = await person(owner, { email });
    const [moveRes, sent] = (await Promise.all([
      move(owner.c, id, openJob.id),
      sendPublicApplication(visitor, owner.orgId, openJob.id, { email, consent: true }),
    ])) as [Res, Res];
    expect(moveRes.error, moveRes.error?.message).toBeNull();
    expect(sent.error, sent.error?.message).toBeNull();
    const word = (moveRes.data as { word: string }).word;
    expect(['ok', 'already_applied'], `round ${i + 1}`).toContain(word);
    expect(await applicationsFor(owner.c, id, openJob.id), `round ${i + 1}`).toHaveLength(1);
    expect(await candidatesByEmail(owner.c, owner.orgId, email), `round ${i + 1}`).toHaveLength(1);
    // When the public form went first the move found an application and touched nothing.
    expect(await poolStatusOf(owner.c, id), `round ${i + 1}`).toBe(word === 'ok' ? 're_engaged' : 'available');
  }
}, 120_000);

testWithSupabase('17. hire_add_candidate: no job is available, a job is none, and an existing person is left as they are', async () => {
  const noJob = expectAdded(await add(owner.c, owner.orgId, { email: uniqueEmail() }), 'created', 'none');
  expect(await poolStatusOf(owner.c, noJob.candidate_id!)).toBe('available');

  const withJob = expectAdded(await add(owner.c, owner.orgId, { email: uniqueEmail(), job_id: openJob.id }), 'created', 'created');
  expect(await poolStatusOf(owner.c, withJob.candidate_id!)).toBe('none');

  // Someone in the pool, set to passive, added again with no job: left as passive.
  const passiveEmail = uniqueEmail();
  const passiveId = await person(owner, { email: passiveEmail });
  expectAnswer(await setStatus(owner.c, passiveId, 'passive'), 'ok', { to: 'passive' });
  const again = expectAdded(await add(owner.c, owner.orgId, { email: passiveEmail }), 'existing', 'none');
  expect(again.candidate_id).toBe(passiveId);
  expect(await poolStatusOf(owner.c, passiveId)).toBe('passive');

  // Someone not in the pool, added again with no job: an existing person is never put in the pool by an add.
  const outEmail = uniqueEmail();
  const out = expectAdded(await add(owner.c, owner.orgId, { email: outEmail, job_id: openJob.id }), 'created', 'created');
  const outAgain = expectAdded(await add(owner.c, owner.orgId, { email: outEmail }), 'existing', 'none');
  expect(outAgain.candidate_id).toBe(out.candidate_id);
  expect(await poolStatusOf(owner.c, out.candidate_id!)).toBe('none');
}, 120_000);

testWithSupabase('18. a demo viewer is told forbidden on both functions, and the row is unchanged', async () => {
  const seeded = await viewer.from('hire_candidates').select('id, pool_status').eq('org_id', demoId).neq('pool_status', 'none').limit(1);
  expect(seeded.error, seeded.error?.message).toBeNull();
  const row = (seeded.data ?? [])[0] as { id: string; pool_status: string } | undefined;
  expect(row, 'the demo workspace should hold a seeded candidate in the pool').toBeTruthy();
  const jobs = await viewer.from('hire_jobs').select('id').eq('org_id', demoId).eq('status', 'open').limit(1);
  expect(jobs.error, jobs.error?.message).toBeNull();
  const demoJob = (jobs.data ?? [])[0] as { id: string } | undefined;
  expect(demoJob, 'the demo workspace should hold a seeded open job').toBeTruthy();

  expectWord(await setStatus(viewer, row!.id, 'available'), 'forbidden');
  expectWord(await setStatus(viewer, row!.id, 'none'), 'forbidden');
  expectWord(await move(viewer, row!.id, demoJob!.id), 'forbidden');

  // Read again by id: its own pool status is what it was. Nothing else about the shared workspace is compared.
  expect(await poolStatusOf(viewer, row!.id)).toBe(row!.pool_status);
}, 60_000);

testWithSupabase('19. another workspace\'s owner is told not_found, and nothing changes', async () => {
  const before = await poolStatusOf(owner.c, moved.id);
  const otherBefore = await applicationCount(other);
  expectWord(await setStatus(other.c, moved.id, 'passive'), 'not_found');
  expectWord(await move(other.c, moved.id, otherJob.id), 'not_found');
  expect(await poolStatusOf(owner.c, moved.id)).toBe(before);
  expect(await applicationCount(other)).toBe(otherBefore);
}, 60_000);

testWithSupabase('20. a signed-out caller is refused outright on both functions', async () => {
  expectRefusedOutright(await setStatus(visitor, NONE, 'available'), 'visitor set');
  expectRefusedOutright(await move(visitor, NONE, NONE), 'visitor move');
}, 30_000);

testWithSupabase('21. a direct update of pool_status is refused for the owner', async () => {
  const before = await poolStatusOf(owner.c, moved.id);
  const updated = await owner.c.from('hire_candidates').update({ pool_status: 'passive' }).eq('id', moved.id).select('id');
  expect(Boolean(updated.error) || (updated.data ?? []).length === 0, 'update refused').toBe(true);
  expect(await poolStatusOf(owner.c, moved.id)).toBe(before);
}, 30_000);

testWithSupabase('22. deleting a careers-page applicant\'s last application does not put them in the pool', async () => {
  const email = uniqueEmail();
  const sent = await sendPublicApplication(visitor, owner.orgId, openJob.id, { email, consent: true });
  expect(sent.error, sent.error?.message).toBeNull();
  expect(sent.data).toBe('ok');
  const [applicant] = await candidatesByEmail(owner.c, owner.orgId, email);
  expect(applicant.pool_status).toBe('none');
  const apps = await applicationsFor(owner.c, applicant.id, openJob.id);
  expect(apps).toHaveLength(1);

  expectWord(await owner.c.rpc('hire_delete_application', { p_application_id: apps[0].id }), 'ok');
  expect(await poolStatusOf(owner.c, applicant.id), 'nothing moved them into the pool').toBe('none');
  // A recruiter can still add them: that is then a person's decision.
  expectAnswer(await setStatus(owner.c, applicant.id, 'available', true), 'ok', { from: 'none', to: 'available' });
}, 60_000);

testWithSupabase('23. KNOWN GAP: a stale screen\'s change puts back someone a colleague has just removed', async () => {
  // Two screens show the same person as Passive. A colleague removes them from the pool; the other screen, not yet
  // refreshed, sends "mark Passive". The function cannot tell that from a deliberate add: it answers ok from none
  // and puts them back. This case documents the CURRENT behaviour so a later fix has a test to change.
  const id = await person(owner);
  expectAnswer(await setStatus(owner.c, id, 'passive'), 'ok', { from: 'available', to: 'passive' });
  expectAnswer(await setStatus(owner.c, id, 'none'), 'ok', { from: 'passive', to: 'none' });
  expectAnswer(await setStatus(owner.c, id, 'passive'), 'ok', { from: 'none', to: 'passive' });
  expect(await poolStatusOf(owner.c, id)).toBe('passive');
}, 60_000);
