// tests/hire-cv-upload.rls.test.ts
//
// Live checks of the private `hire-cvs` bucket and of who may attach a file to a job application
// (Lekir slice 2e). Needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY; without all three every case is skipped.
//
// Cleanup: a beforeCleanup step removes every stored object this run uploaded (with the service client, so an
// application row may keep a cv_path whose file is gone). That has to happen while the workspaces still
// exist; the shared live-workspaces helper then deletes the workspaces (and with them the jobs,
// applications, candidates, notifications and settings this file made) and the anonymous users. The deletion trigger is not exercised here: Task 7 proves it by hand.
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createAnonymousClient } from '@/lib/supabase/anonymous';
import { createCvReader } from '@/lib/hire/cv-read';
import { createSupabaseHireData } from '@/lib/hire/supabase';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, liveClient, signInAnon, beforeCleanup, signInOwner } from './helpers/live-workspaces';
import { publicWriter } from './helpers/public-writer';

const hasService = hasSupabaseEnv && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const testWithSupabase = hasService ? test : test.skip;
if (!hasService) {
  console.warn(
    hasSupabaseEnv
      ? 'Set SUPABASE_SERVICE_ROLE_KEY in .env.local to run the CV upload checks'
      : supabaseEnvSkipReason,
  );
}

const client = liveClient;
const serviceClient = (): SupabaseClient =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const BUCKET = 'hire-cvs';
const PREFIX = 'RLS cv job';
const ALL_OFF = { require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false };
const RUN = Date.now();
const NAME = 'Aina Rahman';
const PDF = new TextEncoder().encode('%PDF-1.4\n%test\n');
const PDF_OPTIONS = { contentType: 'application/pdf', upsert: false };
const FIVE_MB = 5 * 1024 * 1024;

let emailCounter = 0;
/** A lowercase address that no earlier run can have used. */
const uniqueEmail = () => `rls-cv-${RUN}-${++emailCounter}@example.com`;

async function ownedOrg(name: string) {
  const c = client();
  const { error: e1 } = await signInOwner(c);
  expect(e1, e1?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, name);
  expect(error, error?.message).toBeNull();
  return { c, orgId: orgId as string };
}

type Owned = Awaited<ReturnType<typeof ownedOrg>>;

let svc: SupabaseClient;
let owner: Owned;
let other: Owned;
let viewer: SupabaseClient;
let stranger: SupabaseClient; // signed in anonymously, in no workspace
let visitor: SupabaseClient; // no session
let writer: SupabaseClient; // who sends an application without a file: the server, or the visitor on an older database
/** True once the database takes applications from the server alone. */
let serverOnly = false;
let demoId: string;

let openJob: { id: string; title: string };
let secondJob: { id: string; title: string };

// Every object path this run stored, so the cleanup can remove it.
const stored: string[] = [];

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

/** A path of the right shape: <org>/<job>/<random uuid>.pdf */
const pathFor = (orgId: string, jobId: string) => `${orgId}/${jobId}/${randomUUID()}.pdf`;

/** Stores a small PDF with the service client and remembers it for cleanup. */
async function storeFile(path: string) {
  const res = await svc.storage.from(BUCKET).upload(path, PDF, PDF_OPTIONS);
  expect(res.error, res.error?.message).toBeNull();
  stored.push(path);
}

/** Asks with the service client whether the bucket holds the object. */
async function objectExists(path: string) {
  const res = await svc.storage.from(BUCKET).download(path);
  return !res.error && Boolean(res.data);
}

async function objectText(path: string) {
  const res = await svc.storage.from(BUCKET).download(path);
  expect(res.error, res.error?.message).toBeNull();
  return await res.data!.text();
}

type Params = Partial<{
  p_org_id: string;
  p_job_id: string;
  p_name: string | null;
  p_email: string | null;
  p_cv_url: string | null;
  p_consent: boolean;
  p_cv_path: string | null;
}>;

/** Calls the submit function as the given client, with good defaults a case can override. */
const applyAs = (c: SupabaseClient, overrides: Params = {}) =>
  c.rpc('submit_public_application', {
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

/**
 * A visitor naming a file is turned away: by the function's own word while a visitor may still call it,
 * and outright (no EXECUTE) once only the server may.
 */
function expectVisitorRefused(res: { data: unknown; error: { code?: string; message: string } | null }) {
  if (serverOnly) {
    expect(res.error?.code, res.error?.message).toBe('42501');
    return;
  }
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data).toBe('invalid_cv_path');
}

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

async function candidatesByEmail(email: string) {
  const res = await owner.c.from('hire_candidates').select('id').eq('org_id', owner.orgId).eq('email', email);
  expect(res.error, res.error?.message).toBeNull();
  return res.data as Array<{ id: string }>;
}

async function applicationsOf(candidateId: string) {
  const res = await owner.c
    .from('hire_applications')
    .select('id, job_id, cv_url, cv_path')
    .eq('candidate_id', candidateId);
  expect(res.error, res.error?.message).toBeNull();
  return res.data as Array<{ id: string; job_id: string; cv_url: string | null; cv_path: string | null }>;
}

/** A storage call was refused: it errored, or it came back with nothing. */
const refused = (res: { data: unknown; error: unknown }) => {
  const empty = res.data === null || res.data === undefined || (Array.isArray(res.data) && res.data.length === 0);
  return Boolean(res.error) || empty;
};

/**
 * The five things a caller outside the workspace must not be able to do to the bucket. Each is refused,
 * and the service client then checks that the bucket is unchanged.
 */
async function expectBucketClosedTo(c: SupabaseClient, realPath: string, folder: string) {
  const files = c.storage.from(BUCKET);

  const newPath = pathFor(owner.orgId, openJob.id);
  const up = await files.upload(newPath, PDF, PDF_OPTIONS);
  expect(refused(up), 'upload is refused').toBe(true);
  expect(await objectExists(newPath), 'the refused upload created no object').toBe(false);

  const listRoot = await files.list('');
  expect(refused(listRoot), 'list of the root returns nothing').toBe(true);
  const listFolder = await files.list(folder);
  expect(refused(listFolder), 'list of the real folder returns nothing').toBe(true);

  const dl = await files.download(realPath);
  expect(refused(dl), 'download is refused').toBe(true);

  await files.remove([realPath]);
  // Whatever the call said, the object must still be there, and still be the original.
  expect(await objectExists(realPath), 'remove left the object in place').toBe(true);
  expect(await objectText(realPath)).toBe(new TextDecoder().decode(PDF));

  const signed = await files.createSignedUrl(realPath, 60);
  expect(Boolean(signed.error) || !signed.data?.signedUrl, 'signing a link is refused').toBe(true);
}

let ownerFile: string;
let demoFile: string;

beforeAll(async () => {
  if (!hasService) return;
  svc = serviceClient();
  owner = await ownedOrg('Hire CV Owner Sdn Bhd');
  other = await ownedOrg('Hire CV Other Sdn Bhd');
  viewer = client();
  await signInAnon(viewer);
  const { data, error } = await joinDemo(viewer);
  expect(error, error?.message).toBeNull();
  demoId = data as string;
  stranger = client();
  const signedIn = await signInAnon(stranger);
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  visitor = createAnonymousClient();
  ({ writer, serverOnly } = await publicWriter(visitor));

  await switchBoardOn(owner);
  await switchBoardOn(other);

  openJob = await newJob(owner, 'open', openFields());
  secondJob = await newJob(owner, 'second', openFields());

  // One real file in the owner's workspace, and one in the demo workspace the viewer belongs to.
  ownerFile = pathFor(owner.orgId, openJob.id);
  await storeFile(ownerFile);
  demoFile = pathFor(demoId, randomUUID());
  await storeFile(demoFile);
}, 60_000);

// Runs first inside the helper's cleanup (before the workspaces go, and even if the delete is
// skipped): remove every stored object this run uploaded, and switch the boards and forms back off
// so a leaked workspace does not keep a public careers board. A failed removal fails the cleanup.
beforeCleanup(async () => {
  if (!hasService || !svc) return;
  for (const who of [owner, other]) {
    if (!who) continue;
    await who.c.from('hire_settings').update({ careers_enabled: false, ...ALL_OFF }).eq('org_id', who.orgId);
  }
  for (let i = 0; i < stored.length; i += 50) {
    const removed = await svc.storage.from(BUCKET).remove(stored.slice(i, i + 50));
    if (removed.error) throw new Error(`storage removal failed: ${removed.error.message}`);
  }
});

// The cases run in file order: later ones read what earlier ones wrote.

testWithSupabase('1. a signed-out visitor cannot use the bucket', async () => {
  await expectBucketClosedTo(visitor, ownerFile, `${owner.orgId}/${openJob.id}`);
}, 60_000);

testWithSupabase('2. an anonymous signed-in user in no workspace cannot use the bucket', async () => {
  await expectBucketClosedTo(stranger, ownerFile, `${owner.orgId}/${openJob.id}`);
}, 60_000);

testWithSupabase('3. members sign links for their own workspace only, and never write', async () => {
  // The owner signs a link and the link serves the PDF.
  const signed = await owner.c.storage.from(BUCKET).createSignedUrl(ownerFile, 60);
  expect(signed.error, signed.error?.message).toBeNull();
  const fetchPdf = async (link: string) => {
    const res = await fetch(link);
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  };
  await fetchPdf(signed.data!.signedUrl);

  // A viewer of a workspace can too (the viewer belongs to the demo workspace).
  const viewerSigned = await viewer.storage.from(BUCKET).createSignedUrl(demoFile, 60);
  expect(viewerSigned.error, viewerSigned.error?.message).toBeNull();
  await fetchPdf(viewerSigned.data!.signedUrl);

  // The owner of the other workspace cannot sign the owner's file; nor can a viewer of another one.
  const otherSigned = await other.c.storage.from(BUCKET).createSignedUrl(ownerFile, 60);
  expect(Boolean(otherSigned.error) || !otherSigned.data?.signedUrl, 'other workspace cannot sign').toBe(true);
  const viewerCross = await viewer.storage.from(BUCKET).createSignedUrl(ownerFile, 60);
  expect(Boolean(viewerCross.error) || !viewerCross.data?.signedUrl, 'viewer cannot sign another workspace').toBe(true);

  // A member cannot upload, update or remove, in their own workspace's folder or anyone's.
  const original = new TextDecoder().decode(PDF);
  const writers: Array<[string, SupabaseClient, string]> = [
    ['owner', owner.c, ownerFile],
    ['viewer', viewer, demoFile],
  ];
  for (const [label, c, realPath] of writers) {
    const orgId = realPath.split('/')[0];
    const newPath = pathFor(orgId, randomUUID());
    const up = await c.storage.from(BUCKET).upload(newPath, PDF, PDF_OPTIONS);
    expect(refused(up), `${label} upload is refused`).toBe(true);
    expect(await objectExists(newPath), `${label}: no object was created`).toBe(false);

    const changed = new TextEncoder().encode('%PDF-1.4\n%changed\n');
    const upd = await c.storage.from(BUCKET).update(realPath, changed, { contentType: 'application/pdf' });
    expect(refused(upd), `${label} update is refused`).toBe(true);
    expect(await objectText(realPath), `${label}: the object is unchanged`).toBe(original);

    await c.storage.from(BUCKET).remove([realPath]);
    expect(await objectExists(realPath), `${label}: the object is still there`).toBe(true);
  }
}, 60_000);

testWithSupabase('4. the bucket refuses a text file and a file over 5 MB, even from the service client', async () => {
  const textPath = pathFor(owner.orgId, openJob.id);
  const text = await svc.storage
    .from(BUCKET)
    .upload(textPath, new TextEncoder().encode('just words'), { contentType: 'text/plain', upsert: false });
  expect(text.error, 'text/plain is refused').not.toBeNull();
  expect(await objectExists(textPath)).toBe(false);

  const big = new Uint8Array(FIVE_MB + 1);
  big.set(PDF);
  const bigPath = pathFor(owner.orgId, openJob.id);
  const over = await svc.storage.from(BUCKET).upload(bigPath, big, PDF_OPTIONS);
  expect(over.error, 'over 5 MB is refused').not.toBeNull();
  expect(await objectExists(bigPath)).toBe(false);
}, 60_000);

testWithSupabase('5. a visitor naming a file is refused, and nothing is written, not even a rate-limit tick', async () => {
  const before = await snapshot();
  const email = uniqueEmail();
  expectVisitorRefused(await applyAs(visitor, { p_email: email, p_cv_path: pathFor(owner.orgId, openJob.id) }));
  expect(await snapshot()).toEqual(before);
  expect(await candidatesByEmail(email)).toHaveLength(0);

  // A tick would count toward the job's 30 a minute. Refuse 31 times, then a plain application still goes in.
  const job = await freshOpenJob('no ticks');
  for (let i = 0; i < 31; i++) {
    expectVisitorRefused(await applyAs(visitor, { p_job_id: job.id, p_cv_path: pathFor(owner.orgId, job.id) }));
  }
  expect(await countRows('hire_applications', owner, job.id)).toBe(0);
  expectWord(await applyAs(writer, { p_job_id: job.id }), 'ok');
}, 120_000);

testWithSupabase('6. the service client is refused a path under another workspace or job, or a bad name', async () => {
  const before = await snapshot();
  const uuid = randomUUID();
  const cases: Array<[string, string]> = [
    ['another workspace', `${other.orgId}/${openJob.id}/${uuid}.pdf`],
    ['another job', `${owner.orgId}/${secondJob.id}/${uuid}.pdf`],
    ['a name that is not a uuid', `${owner.orgId}/${openJob.id}/not-a-uuid.pdf`],
    ['a .txt name', `${owner.orgId}/${openJob.id}/${uuid}.txt`],
  ];
  for (const [label, path] of cases) {
    const email = uniqueEmail();
    const res = await applyAs(svc, { p_email: email, p_cv_path: path });
    expect(res.error, `${label}: ${res.error?.message}`).toBeNull();
    expect(res.data, label).toBe('invalid_cv_path');
    expect(await candidatesByEmail(email), `${label} wrote a candidate`).toHaveLength(0);
  }
  expect(await snapshot()).toEqual(before);
}, 60_000);

// Cases 7 to 9 share one job, one email and one stored file.
let cvJob: { id: string; title: string };
const cvEmail = uniqueEmail();
let firstPath: string;

testWithSupabase('7. the service client attaches a file on a job that requires a CV and gives no link', async () => {
  await setSettings(owner, { require_cv: true });
  {
    cvJob = await freshOpenJob('cv required');
    firstPath = pathFor(owner.orgId, cvJob.id);
    await storeFile(firstPath);
    expect(await svc.rpc('hire_cv_attached', { p_path: firstPath }), 'not attached before the application').toMatchObject({
      data: false,
      error: null,
    });

    expectWord(await applyAs(svc, { p_job_id: cvJob.id, p_email: cvEmail, p_cv_path: firstPath }), 'ok');
    const candidates = await candidatesByEmail(cvEmail);
    expect(candidates).toHaveLength(1);
    const apps = await applicationsOf(candidates[0].id);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ job_id: cvJob.id, cv_path: firstPath, cv_url: null });

    // The server can ask whether a file is held: yes for this one, no for a made-up well-shaped one.
    expect(await svc.rpc('hire_cv_attached', { p_path: firstPath })).toMatchObject({ data: true, error: null });
    expect(await svc.rpc('hire_cv_attached', { p_path: pathFor(owner.orgId, cvJob.id) })).toMatchObject({
      data: false,
      error: null,
    });
  }
}, 60_000);

testWithSupabase('7b. a member reads that CV with their own client; another workspace gets missing and a visitor is refused', async () => {
  const applicationId = (await applicationsOf((await candidatesByEmail(cvEmail))[0].id))[0].id as string;
  const readAs = (who: SupabaseClient, orgId: string) =>
    createCvReader(who, createSupabaseHireData(who, orgId)).readCv(applicationId);

  const own = await readAs(owner.c, owner.orgId);
  expect(own.state).toBe('ok');
  if (own.state === 'ok') {
    expect(new TextDecoder().decode(own.bytes.slice(0, 5))).toBe('%PDF-');
    expect(own.job).toBe(cvJob.title);
  }
  expect(await readAs(other.c, other.orgId)).toEqual({ state: 'missing' });
  // A signed-out visitor may not read the table at all, so the lookup itself is refused: no file either way.
  expect(await readAs(visitor, owner.orgId)).toEqual({ state: 'failed' });
}, 60_000);

testWithSupabase('8. the same email and job again with a second path answers ok_duplicate and keeps the first path', async () => {
  const secondPath = pathFor(owner.orgId, cvJob.id);
  await storeFile(secondPath);
  const before = await countRows('hire_applications', owner, cvJob.id);
  expectWord(await applyAs(svc, { p_job_id: cvJob.id, p_email: cvEmail, p_cv_path: secondPath }), 'ok_duplicate');
  expect(await countRows('hire_applications', owner, cvJob.id)).toBe(before);
  const apps = await applicationsOf((await candidatesByEmail(cvEmail))[0].id);
  expect(apps).toHaveLength(1);
  expect(apps[0].cv_path).toBe(firstPath);
  // The second file is held by no application, so the server may remove it.
  expect(await svc.rpc('hire_cv_attached', { p_path: secondPath })).toMatchObject({ data: false, error: null });
}, 60_000);

testWithSupabase('9. a visitor repeating an application without a path still gets ok', async () => {
  const before = await countRows('hire_applications', owner, cvJob.id);
  // The workspace still requires a CV: the visitor sends a link, as the 2d form did.
  expectWord(
    await applyAs(writer, { p_job_id: cvJob.id, p_email: cvEmail, p_cv_url: 'https://example.com/cv.pdf' }),
    'ok',
  );
  expect(await countRows('hire_applications', owner, cvJob.id)).toBe(before);
  const apps = await applicationsOf((await candidatesByEmail(cvEmail))[0].id);
  expect(apps[0].cv_path).toBe(firstPath);
  await setSettings(owner, ALL_OFF);
}, 60_000);

testWithSupabase('10. the four service-only functions refuse a visitor and a member, and answer the service client', async () => {
  const somePath = pathFor(owner.orgId, openJob.id);
  const calls: Array<[string, Record<string, unknown>]> = [
    ['hire_apply_throttled', { p_job_id: openJob.id }],
    ['hire_cv_deletions_due', { p_limit: 1 }],
    ['hire_cv_deletions_done', { p_paths: [somePath] }],
    ['hire_cv_attached', { p_path: somePath }],
  ];
  for (const [name, args] of calls) {
    for (const [label, c] of [['visitor', visitor], ['member', owner.c]] as Array<[string, SupabaseClient]>) {
      const res = await c.rpc(name, args);
      expect(res.error?.code, `${label} calling ${name}`).toBe('42501');
      expect(res.data ?? null, `${label} calling ${name} got data`).toBeNull();
    }
  }

  const throttled = await svc.rpc('hire_apply_throttled', { p_job_id: openJob.id });
  expect(throttled.error, throttled.error?.message).toBeNull();
  expect(typeof throttled.data).toBe('boolean');

  const due = await svc.rpc('hire_cv_deletions_due', { p_limit: 1 });
  expect(due.error, due.error?.message).toBeNull();
  expect(Array.isArray(due.data)).toBe(true);

  const done = await svc.rpc('hire_cv_deletions_done', { p_paths: [somePath] });
  expect(done.error, done.error?.message).toBeNull();
  expect(done.data).toBe(0);

  const attached = await svc.rpc('hire_cv_attached', { p_path: somePath });
  expect(attached.error, attached.error?.message).toBeNull();
  expect(typeof attached.data).toBe('boolean');
}, 60_000);

testWithSupabase('11. a member cannot read the deletion list through the API', async () => {
  const res = await owner.c.from('hire_cv_deletions').select('*');
  expect(res.error, 'public schema has no such table').not.toBeNull();
  expect(res.data ?? []).toHaveLength(0);
  const priv = await owner.c.schema('private').from('hire_cv_deletions').select('*');
  expect(priv.error, 'the private schema is not exposed').not.toBeNull();
  expect(priv.data ?? []).toHaveLength(0);
}, 30_000);

testWithSupabase('12. get_public_job still returns its 18 columns and says nothing about a path', async () => {
  const res = await visitor.rpc('get_public_job', { p_org_id: owner.orgId, p_job_id: openJob.id });
  expect(res.error, res.error?.message).toBeNull();
  const rows = res.data as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  const keys = Object.keys(rows[0]);
  expect(keys).toHaveLength(18);
  for (const key of keys) expect(key.toLowerCase()).not.toContain('path');
  expect(JSON.stringify(rows[0])).not.toContain(owner.orgId + '/');
}, 30_000);
