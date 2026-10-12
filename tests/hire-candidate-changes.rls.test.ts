// tests/hire-candidate-changes.rls.test.ts
//
// Live checks of the three functions that add a candidate by hand, edit one, and attach a stored CV to an
// application (Lekir slice 3b): public.hire_add_candidate, hire_update_candidate and hire_attach_cv.
// Needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY; without all
// three every case is skipped.
// WRITTEN, NOT YET RUN: it runs only after the migration 20261026090000_hire_candidate_changes.sql is applied.
//
// Who calls what. hire_add_candidate and hire_update_candidate are granted to `authenticated` only, so every call
// is made by a signed-in client (the owner, the owner of another workspace, a demo viewer) or by the signed-out
// visitor client, which must be refused outright (42501). hire_attach_cv is granted to `service_role` only: the
// service client calls it (and stores and removes the test files); a member and a visitor must be refused (42501).
//
// The viewer case. A viewer made the way the other live files make one (joining the demo workspace) is not a
// member of a throwaway workspace, so against the OWNER's workspace that viewer is a stranger and the right word
// is `not_found`. The word `forbidden` is only true for a viewer who is a member of the workspace, so it is
// tested against the DEMO workspace, where the same viewer is a member without write access. Nothing is written
// to the demo workspace, and the case does not compare the shared workspace before and after (another run or a
// reseed changes it): the answer word is the assertion, plus checks that no other row can break.
//
// What stays behind. Every candidate and application this file creates cannot be removed by a user, so they go
// with the throwaway workspaces when the shared live-workspaces helper deletes them (and the anonymous users) at
// the end. A beforeCleanup step removes the stored test files first (while the workspaces still exist) and
// switches the careers boards off, so a leaked workspace has no public page.
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
      ? 'Set SUPABASE_SERVICE_ROLE_KEY in .env.local to run the candidate change checks'
      : supabaseEnvSkipReason,
  );
}

const client = liveClient;
const serviceClient = (): SupabaseClient =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const BUCKET = 'hire-cvs';
const PREFIX = 'RLS candidate job';
const ALL_OFF = { require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false };
const RUN = Date.now();
const PDF = new TextEncoder().encode('%PDF-1.4\n%test\n');
const PDF_OPTIONS = { contentType: 'application/pdf', upsert: false };
const NONE = '00000000-0000-4000-8000-000000000000';
const CANDIDATE_SELECT = 'id, name, email, phone, headline, location, skills, source, pool_status';
const APPLICATION_SELECT = 'id, candidate_id, job_id, stage, outcome, source, consented_at, cv_path, cover_letter, cv_url';

let emailCounter = 0;
/** A lowercase address that no earlier run can have used. */
const uniqueEmail = () => `rls-candidate-${RUN}-${++emailCounter}@example.com`;

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

type ApplicationRow = {
  id: string;
  candidate_id: string;
  job_id: string;
  stage: string;
  outcome: string;
  source: string | null;
  consented_at: string | null;
  cv_path: string | null;
  cover_letter: string | null;
  cv_url: string | null;
};

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
let draftJob: { id: string; title: string };
let closedJob: { id: string; title: string };
let otherJob: { id: string; title: string };

// Every object path this run stored, so the cleanup can remove it.
const stored: string[] = [];

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

const attach = (c: SupabaseClient, applicationId: string, path: string) =>
  c.rpc('hire_attach_cv', { p_application_id: applicationId, p_cv_path: path });

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

/** A signed-out caller (or a member calling a service-only function) is refused before the function runs. */
function expectRefusedOutright(res: Res, label: string) {
  expect(res.error, `${label}: expected a permission error`).not.toBeNull();
  expect(res.error?.code, `${label}: ${res.error?.message}`).toBe('42501');
  expect(res.data ?? null, `${label}: no answer`).toBeNull();
}

async function candidates(c: SupabaseClient, orgId: string): Promise<CandidateRow[]> {
  const res = await c.from('hire_candidates').select(CANDIDATE_SELECT).eq('org_id', orgId).order('id');
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? []) as CandidateRow[];
}

async function readCandidate(c: SupabaseClient, id: string): Promise<CandidateRow> {
  const res = await c.from('hire_candidates').select(CANDIDATE_SELECT).eq('id', id).single();
  expect(res.error, res.error?.message).toBeNull();
  return res.data as CandidateRow;
}

async function candidatesByEmail(c: SupabaseClient, orgId: string, email: string): Promise<CandidateRow[]> {
  return (await candidates(c, orgId)).filter((row) => row.email?.toLowerCase() === email.toLowerCase());
}

async function readApplication(c: SupabaseClient, id: string): Promise<ApplicationRow> {
  const res = await c.from('hire_applications').select(APPLICATION_SELECT).eq('id', id).single();
  expect(res.error, res.error?.message).toBeNull();
  return res.data as ApplicationRow;
}

async function applicationsOf(c: SupabaseClient, candidateId: string): Promise<ApplicationRow[]> {
  const res = await c.from('hire_applications').select(APPLICATION_SELECT).eq('candidate_id', candidateId);
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? []) as ApplicationRow[];
}

/** A path of the right shape: <org>/<job>/<random uuid>.pdf, lowercase as the database writes ids. */
const pathFor = (orgId: string, jobId: string) => `${orgId}/${jobId}/${randomUUID()}.pdf`;

/** Stores a small PDF with the service client and remembers it for cleanup. */
async function storeFile(path: string) {
  const res = await svc.storage.from(BUCKET).upload(path, PDF, PDF_OPTIONS);
  expect(res.error, res.error?.message).toBeNull();
  stored.push(path);
}

beforeAll(async () => {
  if (!hasService) return;
  svc = serviceClient();
  owner = await ownedOrg('Hire Candidate Owner Sdn Bhd');
  other = await ownedOrg('Hire Candidate Other Sdn Bhd');
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
  draftJob = await newJob(owner, 'draft', { status: 'draft' });
  closedJob = await newJob(owner, 'closed', {
    ...openFields(),
    status: 'closed',
    closed_at: new Date().toISOString(),
  });
  otherJob = await newJob(other, 'open', openFields());
}, 120_000);

// Runs first inside the helper's cleanup, while the workspaces still exist and even if the delete is skipped:
// switch the careers board off and remove every stored object this run uploaded. A failed removal fails the cleanup.
beforeCleanup(async () => {
  if (!hasService || !svc) return;
  if (owner) await owner.c.from('hire_settings').update({ careers_enabled: false }).eq('org_id', owner.orgId);
  for (let i = 0; i < stored.length; i += 50) {
    const removed = await svc.storage.from(BUCKET).remove(stored.slice(i, i + 50));
    if (removed.error) throw new Error(`storage removal failed: ${removed.error.message}`);
  }
});

// The cases run in file order: later ones may read what earlier ones wrote.

testWithSupabase('1. a visitor is refused outright on add and update, and a member or visitor on attach', async () => {
  const before = await candidates(owner.c, owner.orgId);
  expectRefusedOutright(await add(visitor, owner.orgId, { name: 'Visitor Added' }), 'visitor add');
  expectRefusedOutright(await update(visitor, NONE, { phone: '012' }), 'visitor update');
  expectRefusedOutright(await attach(visitor, NONE, pathFor(owner.orgId, openJob.id)), 'visitor attach');
  expectRefusedOutright(await attach(owner.c, NONE, pathFor(owner.orgId, openJob.id)), 'member attach');
  expect(await candidates(owner.c, owner.orgId)).toEqual(before);
}, 60_000);

testWithSupabase('2. another workspace gets not_found, a demo viewer gets forbidden, and nothing is written', async () => {
  const email = uniqueEmail();
  const ownerBefore = await candidates(owner.c, owner.orgId);
  const demoSeeded = await candidates(viewer, demoId);
  expect(demoSeeded.length, 'the demo workspace should hold seeded candidates').toBeGreaterThan(0);

  // The owner of another workspace names this workspace's id: it reads as missing.
  expectWord(await add(other.c, owner.orgId, { name: 'Outsider Added', email }), 'not_found');
  // The demo viewer, a stranger here, gets the same word.
  expectWord(await add(viewer, owner.orgId, { name: 'Outsider Added', email }), 'not_found');
  // A viewer who IS a member of the workspace: forbidden.
  expectWord(await add(viewer, demoId, { name: 'Viewer Added', email }), 'forbidden');

  expect(await candidates(owner.c, owner.orgId)).toEqual(ownerBefore);
  // Only this run's own unique email is looked for in the shared workspace: no other row can make this fail.
  expect(await candidatesByEmail(viewer, demoId, email)).toHaveLength(0);

  // The same three on update, against a seeded demo candidate.
  // `forbidden` is the real assertion: a viewer is a member without write access, and the function refuses
  // before it reads the changes. The row is not compared before and after (a reseed could rewrite it mid-test);
  // instead the viewer sends a value no seed holds and the row must not carry it. A reseed cannot break that.
  const demoTarget = demoSeeded[0];
  const sentPhone = `rls-viewer-${RUN}`;
  expectWord(await update(viewer, demoTarget.id, { phone: sentPhone }), 'forbidden');
  const after = await viewer.from('hire_candidates').select('id, phone').eq('id', demoTarget.id).maybeSingle();
  expect(after.error, after.error?.message).toBeNull();
  expect(after.data?.phone ?? null, 'the viewer\'s phone was not written').not.toBe(sentPhone);
}, 60_000);

testWithSupabase('3. the owner adds a person with no job and no email: created, no application, added by hand', async () => {
  const before = await candidates(owner.c, owner.orgId);
  const res = await add(owner.c, owner.orgId, { name: '  Nurul   Huda  ' });
  const added = expectAdded(res, 'created', 'none');
  expect(added.application_id ?? null).toBeNull();

  const row = await readCandidate(owner.c, added.candidate_id!);
  expect(row).toMatchObject({
    name: 'Nurul Huda',
    email: null,
    phone: null,
    headline: null,
    location: null,
    skills: [],
    source: 'Added by hand',
    pool_status: 'none',
  });
  expect(await candidates(owner.c, owner.orgId)).toHaveLength(before.length + 1);
  expect(await applicationsOf(owner.c, row.id)).toHaveLength(0);

  // A cover note or CV link sent without a job is dropped before anything is checked: even an over-long note is ok.
  const dropped = await add(owner.c, owner.orgId, {
    name: 'Dropped Note',
    cover_letter: 'x'.repeat(4001),
    cv_url: 'not a link',
  });
  const droppedAdded = expectAdded(dropped, 'created', 'none');
  expect(await applicationsOf(owner.c, droppedAdded.candidate_id!)).toHaveLength(0);
}, 60_000);

let farid: { email: string; candidateId: string; applicationId: string };

testWithSupabase('4. the owner adds a person with an email and an open job: applied, active, no consent date', async () => {
  const email = uniqueEmail();
  const res = await add(owner.c, owner.orgId, {
    name: 'Farid Osman',
    email,
    phone: '012-345 6789',
    headline: 'Sales lead',
    location: 'Penang',
    skills: ['Selling', ' Selling ', 'Negotiation', ''],
    source: 'Referral',
    job_id: openJob.id,
    cover_letter: 'Referred by Aina.',
    cv_url: 'https://example.com/farid.pdf',
  });
  const added = expectAdded(res, 'created', 'created');
  const row = await readCandidate(owner.c, added.candidate_id!);
  expect(row).toMatchObject({
    name: 'Farid Osman',
    email,
    phone: '012-345 6789',
    headline: 'Sales lead',
    location: 'Penang',
    skills: ['Selling', 'Negotiation'],
    source: 'Referral',
    pool_status: 'none',
  });
  const apps = await applicationsOf(owner.c, row.id);
  expect(apps).toHaveLength(1);
  expect(apps[0]).toMatchObject({
    id: added.application_id,
    job_id: openJob.id,
    stage: 'applied',
    outcome: 'active',
    source: 'Referral',
    consented_at: null,
    cv_path: null,
    cover_letter: 'Referred by Aina.',
    cv_url: 'https://example.com/farid.pdf',
  });
  farid = { email, candidateId: row.id, applicationId: apps[0].id };
}, 60_000);

testWithSupabase('5. the same email again, in another case with spaces, finds the person and the application', async () => {
  const before = await readCandidate(owner.c, farid.candidateId);
  const res = await add(owner.c, owner.orgId, {
    name: 'Someone Else Entirely',
    email: `  ${farid.email.toUpperCase()}  `,
    phone: '019-999 9999',
    headline: 'Changed headline',
    job_id: openJob.id,
  });
  const added = expectAdded(res, 'existing', 'existing');
  expect(added.candidate_id).toBe(farid.candidateId);
  expect(added.application_id).toBe(farid.applicationId);

  expect(await candidatesByEmail(owner.c, owner.orgId, farid.email)).toHaveLength(1);
  expect(await readCandidate(owner.c, farid.candidateId), 'the person on file is left exactly as they were').toEqual(before);
  expect(await applicationsOf(owner.c, farid.candidateId)).toHaveLength(1);
}, 60_000);

testWithSupabase('6. the same email to a second job finds the person and makes the application', async () => {
  const before = await readCandidate(owner.c, farid.candidateId);
  const res = await add(owner.c, owner.orgId, { name: 'Farid Osman', email: farid.email, job_id: secondJob.id });
  const added = expectAdded(res, 'existing', 'created');
  expect(added.candidate_id).toBe(farid.candidateId);
  expect(added.application_id).not.toBe(farid.applicationId);

  expect(await readCandidate(owner.c, farid.candidateId)).toEqual(before);
  const apps = await applicationsOf(owner.c, farid.candidateId);
  expect(apps.map((a) => a.job_id).sort()).toEqual([openJob.id, secondJob.id].sort());
}, 60_000);

testWithSupabase('7. refusals write nothing: no candidate is left behind', async () => {
  const before = await candidates(owner.c, owner.orgId);
  const applicationsBefore = await owner.c.from('hire_applications').select('id').eq('org_id', owner.orgId);
  expect(applicationsBefore.error, applicationsBefore.error?.message).toBeNull();

  const refusals: Array<[string, AddArgs, string]> = [
    ['a blank name', { name: '   ' }, 'invalid_name'],
    ['a bad email', { name: 'Bad Email', email: 'not-an-email' }, 'invalid_email'],
    ['a draft job', { name: 'Draft Job', email: uniqueEmail(), job_id: draftJob.id }, 'job_not_open'],
    ['a closed job', { name: 'Closed Job', email: uniqueEmail(), job_id: closedJob.id }, 'job_not_open'],
    ['another workspace\'s job', { name: 'Other Job', email: uniqueEmail(), job_id: otherJob.id }, 'job_not_found'],
    ['a job that does not exist', { name: 'No Job', email: uniqueEmail(), job_id: NONE }, 'job_not_found'],
    [
      '21 skills',
      { name: 'Many Skills', email: uniqueEmail(), skills: Array.from({ length: 21 }, (_, i) => `skill ${i + 1}`) },
      'too_long',
    ],
    ['a 121-character name', { name: 'n'.repeat(121), email: uniqueEmail() }, 'too_long'],
    [
      'a CV link that is not http(s)',
      { name: 'Bad Link', email: uniqueEmail(), job_id: openJob.id, cv_url: 'ftp://example.com/cv.pdf' },
      'invalid_url',
    ],
  ];
  for (const [label, args, word] of refusals) {
    const res = await add(owner.c, owner.orgId, args);
    expect(res.error, `${label}: ${res.error?.message}`).toBeNull();
    expectWord(res, word);
    expect(await candidates(owner.c, owner.orgId), `after ${label}`).toHaveLength(before.length);
  }
  expect(await candidates(owner.c, owner.orgId)).toEqual(before);
  const applicationsAfter = await owner.c.from('hire_applications').select('id').eq('org_id', owner.orgId);
  expect(applicationsAfter.data ?? []).toHaveLength((applicationsBefore.data ?? []).length);
}, 120_000);

// Case 8 sends an owner add and a visitor's public application at once for one new email on one job. Both take
// the same lock, so they take turns: whichever goes second finds the person and the application the first made.
testWithSupabase('8. an add racing the public form for one new email makes one candidate and one application', async () => {
  const email = uniqueEmail();
  const [added, sent] = (await Promise.all([
    add(owner.c, owner.orgId, { name: 'Race Runner', email, job_id: openJob.id }),
    visitor.rpc('submit_public_application', {
      p_org_id: owner.orgId,
      p_job_id: openJob.id,
      p_name: 'Race Runner',
      p_email: email,
      p_phone: null,
      p_cover_letter: null,
      p_cv_url: null,
      p_portfolio_url: null,
      p_expected_salary_cents: null,
      p_consent: true,
      p_honeypot: null,
    }),
  ])) as [Res, Res];
  expectWord(added, 'ok');
  expect(sent.error, sent.error?.message).toBeNull();
  expect(sent.data).toBe('ok');

  const people = await candidatesByEmail(owner.c, owner.orgId, email);
  expect(people).toHaveLength(1);
  const apps = await applicationsOf(owner.c, people[0].id);
  expect(apps).toHaveLength(1);
  expect(apps[0].job_id).toBe(openJob.id);
}, 90_000);

let target: CandidateRow;
let neighbour: CandidateRow;

testWithSupabase('9. the owner edits: only named fields change, null clears, an unknown key and a taken email are refused', async () => {
  const targetEmail = uniqueEmail();
  const neighbourEmail = uniqueEmail();
  const made = expectAdded(
    await add(owner.c, owner.orgId, {
      name: 'Update Target',
      email: targetEmail,
      phone: '011-111 1111',
      headline: 'Barista',
      location: 'Ipoh',
      skills: ['Latte art', 'Cashiering'],
      source: 'Referral',
    }),
    'created',
    'none',
  );
  const madeNeighbour = expectAdded(
    await add(owner.c, owner.orgId, { name: 'Update Neighbour', email: neighbourEmail }),
    'created',
    'none',
  );
  target = await readCandidate(owner.c, made.candidate_id!);
  neighbour = await readCandidate(owner.c, madeNeighbour.candidate_id!);
  expect(target.pool_status).toBe('none');

  // The phone only: everything else is as it was.
  expectWord(await update(owner.c, target.id, { phone: ' 012-345   6789 ' }), 'ok');
  let row = await readCandidate(owner.c, target.id);
  expect(row).toEqual({ ...target, phone: '012-345 6789' });

  // A null clears the headline; nothing else moves.
  expectWord(await update(owner.c, target.id, { headline: null }), 'ok');
  row = await readCandidate(owner.c, target.id);
  expect(row).toEqual({ ...target, phone: '012-345 6789', headline: null });

  // Skills are replaced, trimmed and deduplicated.
  expectWord(await update(owner.c, target.id, { skills: ['Sales', '  Sales ', '', 'Excel'] }), 'ok');
  row = await readCandidate(owner.c, target.id);
  expect(row.skills).toEqual(['Sales', 'Excel']);
  expect(row.pool_status).toBe('none');
  const held = row;

  // A blank name is refused and changes nothing.
  expectWord(await update(owner.c, target.id, { name: '   ' }), 'invalid_name');
  // An unknown key, even one that names the workspace, is refused whole.
  expectWord(await update(owner.c, target.id, { nickname: 'Bean' }), 'invalid_changes');
  expectWord(await update(owner.c, target.id, { phone: '000', org_id: other.orgId }), 'invalid_changes');
  expectWord(await update(owner.c, target.id, { pool_status: 'talent' }), 'invalid_changes');
  expectWord(await update(owner.c, target.id, ['phone']), 'invalid_changes');
  // An email another candidate has, in any case with spaces, is taken.
  expectWord(await update(owner.c, target.id, { email: `  ${neighbourEmail.toUpperCase()} ` }), 'email_taken');
  expect(await readCandidate(owner.c, target.id), 'after the refusals').toEqual(held);
  expect(await readCandidate(owner.c, neighbour.id)).toEqual(neighbour);

  // The candidate's own email in another case is fine, and is stored in lower case.
  expectWord(await update(owner.c, target.id, { email: targetEmail.toUpperCase() }), 'ok');
  row = await readCandidate(owner.c, target.id);
  expect(row).toEqual({ ...held, email: targetEmail });
  expect(row.pool_status).toBe('none');
}, 120_000);

testWithSupabase('10. a viewer, another workspace\'s owner and a visitor cannot edit that candidate', async () => {
  const before = await readCandidate(owner.c, target.id);
  expectWord(await update(viewer, target.id, { phone: '000' }), 'not_found');
  expectWord(await update(other.c, target.id, { phone: '000' }), 'not_found');
  expectRefusedOutright(await update(visitor, target.id, { phone: '000' }), 'visitor update');
  expect(await readCandidate(owner.c, target.id)).toEqual(before);
}, 60_000);

testWithSupabase('11. the server attaches a CV to a hand-added application once, and only under its own workspace and job', async () => {
  const handAdded = async (name: string) => {
    const added = expectAdded(
      await add(owner.c, owner.orgId, { name, email: uniqueEmail(), job_id: openJob.id }),
      'created',
      'created',
    );
    return added.application_id!;
  };
  const first = await handAdded('Attach One');
  const second = await handAdded('Attach Two');

  // A made-up application.
  expect((await attach(svc, NONE, pathFor(owner.orgId, openJob.id))).data).toBe('not_found');

  // A path under another job, another workspace, or the wrong shape.
  const wrongJob = pathFor(owner.orgId, secondJob.id);
  await storeFile(wrongJob);
  const wrongWorkspace = pathFor(other.orgId, openJob.id);
  expect((await attach(svc, first, wrongJob)).data).toBe('invalid_path');
  expect((await attach(svc, first, wrongWorkspace)).data).toBe('invalid_path');
  expect((await attach(svc, first, `${owner.orgId}/${openJob.id}/not-a-uuid.pdf`)).data).toBe('invalid_path');
  expect((await readApplication(owner.c, first)).cv_path).toBeNull();

  // The right path attaches.
  const path = pathFor(owner.orgId, openJob.id);
  await storeFile(path);
  const done = await attach(svc, first, path);
  expect(done.error, done.error?.message).toBeNull();
  expect(done.data).toBe('ok');
  expect((await readApplication(owner.c, first)).cv_path).toBe(path);

  // A second attach finds a file already there and changes nothing.
  const again = pathFor(owner.orgId, openJob.id);
  await storeFile(again);
  expect((await attach(svc, first, again)).data).toBe('already_attached');
  expect((await readApplication(owner.c, first)).cv_path).toBe(path);

  // A file another application already holds is not shared: invalid_path, and nothing raised.
  const shared = await attach(svc, second, path);
  expect(shared.error, shared.error?.message).toBeNull();
  expect(shared.data).toBe('invalid_path');
  expect((await readApplication(owner.c, second)).cv_path).toBeNull();

  // An application an applicant sent themselves carries a consent date and takes no file by hand.
  const email = uniqueEmail();
  const sent = await visitor.rpc('submit_public_application', {
    p_org_id: owner.orgId,
    p_job_id: openJob.id,
    p_name: 'Public Applicant',
    p_email: email,
    p_phone: null,
    p_cover_letter: null,
    p_cv_url: null,
    p_portfolio_url: null,
    p_expected_salary_cents: null,
    p_consent: true,
    p_honeypot: null,
  });
  expect(sent.error, sent.error?.message).toBeNull();
  expect(sent.data).toBe('ok');
  const [person] = await candidatesByEmail(owner.c, owner.orgId, email);
  const [theirs] = await applicationsOf(owner.c, person.id);
  expect(theirs.consented_at).not.toBeNull();
  const forTheirs = pathFor(owner.orgId, openJob.id);
  await storeFile(forTheirs);
  expect((await attach(svc, theirs.id, forTheirs)).data).toBe('not_by_hand');
  expect((await readApplication(owner.c, theirs.id)).cv_path).toBeNull();
}, 120_000);

testWithSupabase('12. a direct insert or update on hire_candidates is refused for the owner', async () => {
  const before = await candidates(owner.c, owner.orgId);

  const inserted = await owner.c
    .from('hire_candidates')
    .insert({ org_id: owner.orgId, name: 'Direct Insert', pool_status: 'none' })
    .select('id');
  // No INSERT grant: PostgREST answers with an error (42501). If a policy alone stopped it, no row comes back.
  expect(Boolean(inserted.error) || (inserted.data ?? []).length === 0, 'insert refused').toBe(true);

  const updated = await owner.c.from('hire_candidates').update({ name: 'Direct Update' }).eq('id', target.id).select('id');
  expect(Boolean(updated.error) || (updated.data ?? []).length === 0, 'update refused').toBe(true);

  expect(await candidates(owner.c, owner.orgId)).toEqual(before);
}, 30_000);
