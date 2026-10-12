// tests/hire-deletions.rls.test.ts
//
// Live checks of the two functions that delete an application, or a candidate with everything held about them
// (Lekir slice 3c): public.hire_delete_application and public.hire_delete_candidate.
// Needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY; without all
// three every case is skipped.
// WRITTEN, NOT YET RUN: it runs only after the migration 20261028093000_hire_deletions.sql is applied.
//
// Who calls what. Both deletion functions are granted to `authenticated` only, so every call is made by a signed-in
// client (the owner, the owner of another workspace, a demo viewer) or by the signed-out visitor client, which must
// be refused outright (42501). The service client is used for two things only: hire_attach_cv (to give a hand-added
// application a stored file) and hire_cv_deletions_done (to ask whether the deletion queue held a path, and to
// clear it again so the cleanup run never looks for a file that was never stored). It never deletes anything.
//
// A gap. Nothing can create an interview on live: members and the server have read access only on hire_interviews.
// Every case therefore expects `interviews: 0`. The interview cascade and the count rest on the foreign key
// (20261013090000_hire_foundation.sql, line 63) and on the migration's text test. The piece that makes
// interviews writable adds the live case.
//
// Another gap. Candidates are stored with a lower-case email (the hand-add and the public form both lower it), so
// a candidate whose STORED email has capitals cannot be made through any function. The migration reads the email
// with lower() all the same; what is checked live is the lock key: case 14 races a deletion against a hand-add
// whose address is sent in capitals, and both must still take turns.
//
// The viewer case. A viewer made the way the other live files make one (joining the demo workspace) is a member
// without write access of the DEMO workspace, so `forbidden` is tested there, against a seeded row. The case does
// not compare the shared workspace before and after (another run or a reseed changes it): it asserts the refusal
// word and that the one row it targeted is still there, by id.
//
// What stays behind. Every workspace and user is made through tests/helpers/live-workspaces.ts, which deletes
// them at the end. A beforeCleanup step clears any queued test path that a failed case did not.
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createAnonymousClient } from '@/lib/supabase/anonymous';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { beforeCleanup, createOrg, joinDemo, liveClient, signInAnon, signInOwner } from './helpers/live-workspaces';

const hasService = hasSupabaseEnv && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const testWithSupabase = hasService ? test : test.skip;
if (!hasService) {
  console.warn(
    hasSupabaseEnv
      ? 'Set SUPABASE_SERVICE_ROLE_KEY in .env.local to run the deletion checks'
      : supabaseEnvSkipReason,
  );
}

const client = liveClient;
const serviceClient = (): SupabaseClient =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const PREFIX = 'RLS deletion job';
const RUN = Date.now();
const NONE = '00000000-0000-4000-8000-000000000000';

let emailCounter = 0;
/** A lowercase address that no earlier run can have used. */
const uniqueEmail = () => `rls-deletion-${RUN}-${++emailCounter}@example.com`;

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

type Added = {
  word: string;
  candidate_id?: string;
  application_id?: string | null;
  candidate?: string;
  application?: string;
};

let svc: SupabaseClient;
let owner: Owned;
let other: Owned;
let viewer: SupabaseClient; // a viewer of the DEMO workspace
let visitor: SupabaseClient; // no session
let demoId: string;

let openJob: { id: string; title: string };
let secondJob: { id: string; title: string };
let loneJob: { id: string; title: string };

// Every path this run attached, so the cleanup can clear whatever a failed case left in the deletion queue.
const attached: string[] = [];

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

const attach = (c: SupabaseClient, applicationId: string, path: string) =>
  c.rpc('hire_attach_cv', { p_application_id: applicationId, p_cv_path: path });

const removeApplication = (c: SupabaseClient, id: string) => c.rpc('hire_delete_application', { p_application_id: id });
const removeCandidate = (c: SupabaseClient, id: string) => c.rpc('hire_delete_candidate', { p_candidate_id: id });

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

type Removed = { word: string; name?: string; job?: string; applications?: number; interviews?: number; cv_files?: number };

/** An `ok` deletion, with exactly the counts expected, and the name (and job, for an application) when given. */
function expectRemoved(
  res: Res,
  counts: { applications: number; interviews: number; cv_files: number },
  who?: { name: string; job?: string },
): Removed {
  expectWord(res, 'ok');
  const data = res.data as Removed;
  expect({ applications: data.applications, interviews: data.interviews, cv_files: data.cv_files }).toEqual(counts);
  if (who) {
    expect(data.name, 'name').toBe(who.name);
    if (who.job !== undefined) expect(data.job, 'job').toBe(who.job);
  }
  return data;
}

const exists = async (c: SupabaseClient, table: 'hire_candidates' | 'hire_applications', id: string) => {
  const res = await c.from(table).select('id').eq('id', id).maybeSingle();
  expect(res.error, res.error?.message).toBeNull();
  return res.data !== null;
};

async function candidateIdsByEmail(c: SupabaseClient, orgId: string, email: string): Promise<string[]> {
  const res = await c.from('hire_candidates').select('id, email').eq('org_id', orgId);
  expect(res.error, res.error?.message).toBeNull();
  return ((res.data ?? []) as { id: string; email: string | null }[])
    .filter((row) => row.email?.toLowerCase() === email.toLowerCase())
    .map((row) => row.id);
}

async function applicationCount(c: SupabaseClient, candidateId: string): Promise<number> {
  const res = await c.from('hire_applications').select('id').eq('candidate_id', candidateId);
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? []).length;
}

/** A well-formed path under this workspace and job. No object is stored: only the row's column is being tested. */
const cvPath = (orgId: string, jobId: string) => `${orgId}/${jobId}/${randomUUID()}.pdf`;

/**
 * True when this path was waiting in the deletion queue, and takes it out again so the cleanup run never looks for a
 * file that was never stored. `hire_cv_deletions_done` answers how many rows it cleared: 1 proves the trigger queued it.
 */
async function wasQueued(path: string): Promise<boolean> {
  const done = await svc.rpc('hire_cv_deletions_done', { p_paths: [path] });
  expect(done.error, done.error?.message).toBeNull();
  return done.data === 1;
}

/** A hand-added candidate with an application on a job. Returns the ids. */
async function addApplied(job: { id: string }, a: AddArgs = {}) {
  const added = expectAdded(
    await add(owner.c, owner.orgId, { name: 'Farid Osman', email: uniqueEmail(), job_id: job.id, ...a }),
    'created',
    'created',
  );
  return { candidateId: added.candidate_id!, applicationId: added.application_id! };
}

/** Gives an application a stored-file path, and remembers it for cleanup. */
async function givePath(applicationId: string, jobId: string): Promise<string> {
  const path = cvPath(owner.orgId, jobId);
  attached.push(path);
  const res = await attach(svc, applicationId, path);
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data).toBe('ok');
  return path;
}

beforeAll(async () => {
  if (!hasService) return;
  svc = serviceClient();
  owner = await ownedOrg('Hire Deletion Owner Sdn Bhd');
  other = await ownedOrg('Hire Deletion Other Sdn Bhd');
  viewer = client();
  await signInAnon(viewer);
  const joined = await joinDemo(viewer);
  expect(joined.error, joined.error?.message).toBeNull();
  demoId = joined.data as string;
  visitor = createAnonymousClient();

  openJob = await newJob(owner, 'open', openFields());
  secondJob = await newJob(owner, 'second', openFields());
  loneJob = await newJob(owner, 'lone', openFields());
}, 120_000);

// Runs first inside the helper's cleanup, while the workspaces still exist: clear every path this run attached from
// the deletion queue, so the cleanup run never looks for a file that was never stored.
beforeCleanup(async () => {
  if (!hasService || !svc || attached.length === 0) return;
  const done = await svc.rpc('hire_cv_deletions_done', { p_paths: attached });
  if (done.error) throw new Error(`queue clearing failed: ${done.error.message}`);
});

// The cases run in file order: later ones may read what earlier ones wrote.

testWithSupabase('1. a signed-out caller is refused outright on both functions', async () => {
  expectRefusedOutright(await removeApplication(visitor, NONE), 'visitor delete application');
  expectRefusedOutright(await removeCandidate(visitor, NONE), 'visitor delete candidate');
}, 60_000);

testWithSupabase('2. unknown and foreign ids answer not_found, and nothing changes', async () => {
  const { candidateId, applicationId } = await addApplied(openJob);

  expectWord(await removeApplication(owner.c, NONE), 'not_found');
  expectWord(await removeCandidate(owner.c, NONE), 'not_found');

  // The owner of another workspace names this workspace's ids: they read as missing.
  expectWord(await removeApplication(other.c, applicationId), 'not_found');
  expectWord(await removeCandidate(other.c, candidateId), 'not_found');
  expect(await exists(owner.c, 'hire_applications', applicationId)).toBe(true);
  expect(await exists(owner.c, 'hire_candidates', candidateId)).toBe(true);
}, 60_000);

testWithSupabase('3. deleting an application answers its name and job, and the candidate stays', async () => {
  // A CV LINK is not a stored file: it must count as 0.
  const { candidateId, applicationId } = await addApplied(openJob, {
    name: 'Application Only',
    cv_url: 'https://example.com/application-only.pdf',
  });
  expectRemoved(
    await removeApplication(owner.c, applicationId),
    { applications: 1, interviews: 0, cv_files: 0 },
    { name: 'Application Only', job: openJob.title },
  );
  expect(await exists(owner.c, 'hire_applications', applicationId)).toBe(false);
  expect(await exists(owner.c, 'hire_candidates', candidateId)).toBe(true);
}, 60_000);

testWithSupabase('4. deleting a candidate with two applications takes both', async () => {
  const email = uniqueEmail();
  const first = await addApplied(openJob, { name: 'Two Applications', email, cv_url: 'https://example.com/two.pdf' });
  const secondAdded = expectAdded(
    await add(owner.c, owner.orgId, { name: 'Two Applications', email, job_id: secondJob.id }),
    'existing',
    'created',
  );
  expect(secondAdded.candidate_id).toBe(first.candidateId);

  // A CV link on one application is still no stored file.
  expectRemoved(
    await removeCandidate(owner.c, first.candidateId),
    { applications: 2, interviews: 0, cv_files: 0 },
    { name: 'Two Applications' },
  );
  expect(await exists(owner.c, 'hire_applications', first.applicationId)).toBe(false);
  expect(await exists(owner.c, 'hire_applications', secondAdded.application_id!)).toBe(false);
  expect(await exists(owner.c, 'hire_candidates', first.candidateId)).toBe(false);
}, 60_000);

testWithSupabase('5. deleting a candidate with no applications answers all zeros', async () => {
  const added = expectAdded(await add(owner.c, owner.orgId, { name: 'No Applications' }), 'created', 'none');
  expectRemoved(
    await removeCandidate(owner.c, added.candidate_id!),
    { applications: 0, interviews: 0, cv_files: 0 },
    { name: 'No Applications' },
  );
  expect(await exists(owner.c, 'hire_candidates', added.candidate_id!)).toBe(false);
}, 60_000);

testWithSupabase('6. a stored CV file is queued for removal when its application is deleted', async () => {
  const { applicationId } = await addApplied(openJob, { name: 'File Holder' });
  const path = await givePath(applicationId, openJob.id);
  expectRemoved(
    await removeApplication(owner.c, applicationId),
    { applications: 1, interviews: 0, cv_files: 1 },
    { name: 'File Holder', job: openJob.title },
  );
  expect(await wasQueued(path), 'the path was in the deletion queue').toBe(true);
}, 60_000);

testWithSupabase('7. deleting a candidate queues the files of every application', async () => {
  const email = uniqueEmail();
  const first = await addApplied(openJob, { name: 'Two Files', email });
  const secondAdded = expectAdded(
    await add(owner.c, owner.orgId, { name: 'Two Files', email, job_id: secondJob.id }),
    'existing',
    'created',
  );
  const pathOne = await givePath(first.applicationId, openJob.id);
  const pathTwo = await givePath(secondAdded.application_id!, secondJob.id);
  expectRemoved(
    await removeCandidate(owner.c, first.candidateId),
    { applications: 2, interviews: 0, cv_files: 2 },
    { name: 'Two Files' },
  );
  expect(await wasQueued(pathOne), 'first path queued').toBe(true);
  expect(await wasQueued(pathTwo), 'second path queued').toBe(true);
}, 60_000);

testWithSupabase('8. an application can be deleted at any stage and with any outcome', async () => {
  const hired = await addApplied(openJob, { name: 'Hired One' });
  const moved = await owner.c.rpc('hire_move_application', { p_application_id: hired.applicationId, p_stage: 'hired' });
  expect(moved.error, moved.error?.message).toBeNull();
  expect(moved.data).toBe('ok');
  expectRemoved(
    await removeApplication(owner.c, hired.applicationId),
    { applications: 1, interviews: 0, cv_files: 0 },
    { name: 'Hired One', job: openJob.title },
  );

  const rejected = await addApplied(openJob, { name: 'Rejected One' });
  const closed = await owner.c.rpc('hire_close_application', {
    p_application_id: rejected.applicationId,
    p_outcome: 'rejected',
    p_reason: 'experience',
  });
  expect(closed.error, closed.error?.message).toBeNull();
  expect(closed.data).toBe('ok');
  expectRemoved(
    await removeCandidate(owner.c, rejected.candidateId),
    { applications: 1, interviews: 0, cv_files: 0 },
    { name: 'Rejected One' },
  );
}, 60_000);

testWithSupabase('9. a second delete, and a change after a delete, answer not_found', async () => {
  const { candidateId, applicationId } = await addApplied(openJob, { name: 'Gone Twice' });
  expectWord(await removeApplication(owner.c, applicationId), 'ok');
  expectWord(await removeApplication(owner.c, applicationId), 'not_found');
  expectWord(
    await owner.c.rpc('hire_move_application', { p_application_id: applicationId, p_stage: 'screening' }),
    'not_found',
  );
  expectWord(await owner.c.rpc('hire_rate_application', { p_application_id: applicationId, p_rating: 4 }), 'not_found');

  expectWord(await removeCandidate(owner.c, candidateId), 'ok');
  expectWord(await removeCandidate(owner.c, candidateId), 'not_found');
  expectWord(await update(owner.c, candidateId, { phone: '012-345 6789' }), 'not_found');
}, 60_000);

testWithSupabase('10. a demo viewer is told forbidden, and the row is still there', async () => {
  const seededCandidates = await viewer.from('hire_candidates').select('id').eq('org_id', demoId).limit(1);
  expect(seededCandidates.error, seededCandidates.error?.message).toBeNull();
  expect((seededCandidates.data ?? []).length, 'the demo workspace should hold seeded candidates').toBeGreaterThan(0);
  const seededApplications = await viewer.from('hire_applications').select('id').eq('org_id', demoId).limit(1);
  expect(seededApplications.error, seededApplications.error?.message).toBeNull();
  expect((seededApplications.data ?? []).length, 'the demo workspace should hold seeded applications').toBeGreaterThan(0);
  const candidateId = (seededCandidates.data![0] as { id: string }).id;
  const applicationId = (seededApplications.data![0] as { id: string }).id;

  expectWord(await removeCandidate(viewer, candidateId), 'forbidden');
  expectWord(await removeApplication(viewer, applicationId), 'forbidden');

  // Only the two targeted rows are looked at: the shared workspace is not compared as a whole.
  expect(await exists(viewer, 'hire_candidates', candidateId)).toBe(true);
  expect(await exists(viewer, 'hire_applications', applicationId)).toBe(true);
}, 60_000);

testWithSupabase('11. a direct delete is refused for an owner', async () => {
  const { candidateId, applicationId } = await addApplied(openJob, { name: 'Direct Delete' });

  const app = await owner.c.from('hire_applications').delete().eq('id', applicationId).select('id');
  expect(Boolean(app.error) || (app.data ?? []).length === 0, 'application delete refused').toBe(true);
  const person = await owner.c.from('hire_candidates').delete().eq('id', candidateId).select('id');
  expect(Boolean(person.error) || (person.data ?? []).length === 0, 'candidate delete refused').toBe(true);

  expect(await exists(owner.c, 'hire_applications', applicationId)).toBe(true);
  expect(await exists(owner.c, 'hire_candidates', candidateId)).toBe(true);
}, 60_000);

testWithSupabase('12. a job becomes deletable once its last application has gone', async () => {
  const { applicationId } = await addApplied(loneJob, { name: 'Last One' });
  const blocked = await owner.c.from('hire_jobs').delete().eq('id', loneJob.id).select('id');
  expect(blocked.error, 'the job delete is refused while an application exists').not.toBeNull();
  expect(blocked.error?.message).toContain('This job has applications');

  expectWord(await removeApplication(owner.c, applicationId), 'ok');

  const freed = await owner.c.from('hire_jobs').delete().eq('id', loneJob.id).select('id');
  expect(freed.error, freed.error?.message).toBeNull();
  const left = await owner.c.from('hire_jobs').select('id').eq('id', loneJob.id).maybeSingle();
  expect(left.error, left.error?.message).toBeNull();
  expect(left.data).toBeNull();
}, 60_000);

testWithSupabase('13. a deleted person who applies again is a new candidate', async () => {
  const email = uniqueEmail();
  const first = expectAdded(
    await add(owner.c, owner.orgId, { name: 'Come Back', email, job_id: openJob.id }),
    'created',
    'created',
  );
  expectWord(await removeCandidate(owner.c, first.candidate_id!), 'ok');
  const again = expectAdded(
    await add(owner.c, owner.orgId, { name: 'Come Back', email, job_id: openJob.id }),
    'created',
    'created',
  );
  expect(again.candidate_id).not.toBe(first.candidate_id);
}, 60_000);

// Each round sends a deletion and a hand-add for one address at once. Both take the same lock (workspace and
// lower-cased email), so they take turns, and the add never fails on a foreign key to a candidate that has just
// gone. Odd rounds send the address in capitals with spaces: the add lower-cases it, and the lock key must agree.
testWithSupabase('14. a deletion racing a hand-add for the same email never raises', async () => {
  for (let round = 0; round < 5; round += 1) {
    const email = uniqueEmail();
    const made = expectAdded(await add(owner.c, owner.orgId, { name: 'Race Target', email }), 'created', 'none');
    const deletedId = made.candidate_id!;
    const sentEmail = round % 2 === 1 ? `  ${email.toUpperCase()}  ` : email;

    const [deleted, added] = (await Promise.all([
      removeCandidate(owner.c, deletedId),
      add(owner.c, owner.orgId, { name: 'Race Target', email: sentEmail, job_id: openJob.id }),
    ])) as [Res, Res];
    expect(deleted.error, `round ${round}: ${deleted.error?.message}`).toBeNull();
    expect(added.error, `round ${round}: ${added.error?.message}`).toBeNull();
    expectWord(deleted, 'ok');
    expectWord(added, 'ok');

    const people = await candidateIdsByEmail(owner.c, owner.orgId, email);
    if (people.length === 0) continue; // the add went first, found the candidate, and both went with the deletion
    expect(people, `round ${round}: never two`).toHaveLength(1);
    expect(people[0], `round ${round}: a new person, not the deleted one`).not.toBe(deletedId);
    expect(await applicationCount(owner.c, people[0]), `round ${round}: exactly one application`).toBe(1);
  }
}, 120_000);
