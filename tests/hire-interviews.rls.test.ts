// tests/hire-interviews.rls.test.ts
//
// Live checks of the six functions that are the only way a row of public.hire_interviews changes (Lekir slice 4a):
// hire_schedule_interview, hire_record_past_interview, hire_reschedule_interview, hire_cancel_interview,
// hire_set_interview_outcome and hire_reopen_interview.
// Needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY; without all
// three every case is skipped.
// WRITTEN, NOT YET RUN: it fails until the migrations 20261107090000_hire_interviews_columns.sql and
// 20261107090100_hire_interviews_writes.sql are applied (case 17 also needs 3c's
// 20261028093000_hire_deletions.sql, for hire_delete_application).
//
// The cases are numbered as in the design's section 10, "Database, live" (1 to 25). Cases 26 to 29 are added after
// the migrations were written: the time is sent as TEXT and must carry a zone (26), hire_reschedule_interview answers
// { word, moved } (27), the text PostgREST returns for a timestamp is one the app can read (28), and the state
// machine's remaining moves, including the duplicate that "Mark as scheduled again" is allowed to make (29).
// Cases 30 and 31 are not about the six functions: they run the READ behind every assistant card about an existing
// interview (readInterviewCard in src/lib/hire/namesakes.ts, seven queries), through the same data object the app
// builds from a session client. Until these two ran, that read had only ever met a stand-in client.
//
// Who calls what. All six functions are granted to `authenticated` only, so every call is made by a signed-in
// client or by the signed-out visitor client, which must be refused outright (42501). The service key is never
// used to call a function: it is only what the shared helper needs to create confirmed test users and to clean up.
// That the server's own role is refused is pinned by the migration's grants test.
//
// The people. `owner` owns a throwaway workspace. `member` and `viewerIn` were invited to THAT workspace with the
// roles member and viewer (create_invite, accept_invite), so "a member can", and "a viewer is told forbidden and
// nothing changes", are tested on rows this file made and can read back whole. `other` owns a second workspace: to
// it every id of the first reads as missing. `visitor` has no session. `demoGuest` joined the DEMO workspace, where
// every guest is a viewer: it must be told `forbidden` for a seeded demo row. Nothing is written to the demo
// workspace and the shared workspace is never compared before and after (another run or a reseed changes it): the
// one seeded interview that was targeted is read again by id and its status must be what it was. The demo part is
// skipped in minutes :00 to :02 of every hour (UTC), while the demo is re-seeded and its interviews get new ids.
//
// Times. Nothing here is a fixed date. A Kuala Lumpur day is worked out from Date.now() (Kuala Lumpur is UTC+8 all
// year, so this does not depend on the machine's time zone) and sent the way the app sends it:
// 'YYYY-MM-DDTHH:MM:00+08:00'. A case that needs the same instant twice keeps the text it sent.
//
// What stays behind. An interview cannot be removed by a user, so every row this file creates goes with the
// throwaway workspaces when the shared live-workspaces helper deletes them, and the test users, at the end.
import { randomBytes } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAnonymousClient } from '@/lib/supabase/anonymous';
import { instantMs } from '@/lib/hire/interview-time';
import { createSupabaseHireData } from '@/lib/hire/supabase';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import {
  createConfirmedTestUser, createOrg, joinDemo, liveClient, signInAnon, signInOwner,
} from './helpers/live-workspaces';

const hasService = hasSupabaseEnv && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const testWithSupabase = hasService ? test : test.skip;
if (!hasService) {
  console.warn(
    hasSupabaseEnv
      ? 'Set SUPABASE_SERVICE_ROLE_KEY in .env.local to run the interview checks'
      : supabaseEnvSkipReason,
  );
}

const client = liveClient;

const PREFIX = 'RLS interview job';
const RUN = Date.now();
const NONE = '00000000-0000-4000-8000-000000000000';
const ROW = 'id, org_id, application_id, scheduled_at, duration_minutes, kind, place, interviewer_name, notes, status, created_at, updated_at';

// ─── times ───────────────────────────────────────────────────────────────────
const KL_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
/** The calendar date in Kuala Lumpur `days` from today, as YYYY-MM-DD. */
const klDate = (days: number) => new Date(Date.now() + KL_OFFSET_MS + days * DAY_MS).toISOString().slice(0, 10);
/** A Kuala Lumpur clock time on the day `days` from today, as the app sends an instant. */
const klAt = (days: number, time: string) => `${klDate(days)}T${time}:00+08:00`;
/** The instant `minutes` from now (negative: ago). */
const fromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);

let emailCounter = 0;
/** A lowercase address that no earlier run can have used. */
const uniqueEmail = () => `rls-interview-${RUN}-${++emailCounter}@example.com`;

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

type Row = {
  id: string;
  org_id: string;
  application_id: string;
  scheduled_at: string;
  duration_minutes: number;
  kind: string;
  place: string | null;
  interviewer_name: string | null;
  notes: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

let owner: Owned;
let other: Owned;
let member: SupabaseClient; // role member in the owner's workspace
let viewerIn: SupabaseClient; // role viewer in the owner's workspace
let demoGuest: SupabaseClient; // a viewer of the DEMO workspace
let visitor: SupabaseClient; // no session
let demoId: string;

let openJob: { id: string; title: string };
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

/** A confirmed test user who accepted an invite to the owner's workspace with this role. */
async function invited(role: 'member' | 'viewer'): Promise<SupabaseClient> {
  const c = client();
  // A member needs an address to accept an invite sent to it, and a session at once: a plain sign-up has neither.
  const signUp = await createConfirmedTestUser(c, `Qa-${randomBytes(16).toString('hex')}`);
  const invite = await owner.c.rpc('create_invite', { p_email: signUp.email, p_role: role });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await c.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  expect(accepted.data, `${role} joined the owner's workspace`).toBe(owner.orgId);
  return c;
}

type AddArgs = Partial<{ name: string | null; email: string | null; job_id: string | null }>;

/** hire_add_candidate with every optional argument defaulting to null, as the function does. */
const add = (c: SupabaseClient, orgId: string, a: AddArgs = {}) =>
  c.rpc('hire_add_candidate', {
    p_org_id: orgId,
    p_name: a.name === undefined ? 'Interview Candidate' : a.name,
    p_email: a.email ?? null,
    p_phone: null,
    p_headline: null,
    p_location: null,
    p_skills: null,
    p_source: null,
    p_job_id: a.job_id ?? null,
    p_cover_letter: null,
    p_cv_url: null,
  });

/** hire_close_application as a rejection: the only way an application stops being active here. */
const reject = (c: SupabaseClient, applicationId: string) =>
  c.rpc('hire_close_application', { p_application_id: applicationId, p_outcome: 'rejected', p_reason: 'experience' });

type Details = {
  at: string | null;
  duration?: number | null;
  kind?: string | null;
  place?: string | null;
  interviewer?: string | null;
  notes?: string | null;
};

const schedule = (c: SupabaseClient, applicationId: string, d: Details) =>
  c.rpc('hire_schedule_interview', {
    p_application_id: applicationId,
    p_scheduled_at: d.at,
    p_duration_minutes: d.duration === undefined ? 60 : d.duration,
    p_kind: d.kind === undefined ? 'video' : d.kind,
    p_place: d.place ?? null,
    p_interviewer_name: d.interviewer ?? null,
    p_notes: d.notes ?? null,
  });

const recordPast = (c: SupabaseClient, applicationId: string, d: Details & { outcome: string | null }) =>
  c.rpc('hire_record_past_interview', {
    p_application_id: applicationId,
    p_scheduled_at: d.at,
    p_duration_minutes: d.duration === undefined ? 60 : d.duration,
    p_kind: d.kind === undefined ? 'video' : d.kind,
    p_outcome: d.outcome,
    p_place: d.place ?? null,
    p_interviewer_name: d.interviewer ?? null,
    p_notes: d.notes ?? null,
  });

/** `ifUpdatedAt` left out entirely is the function's default (null): no check against a stale screen. */
const reschedule = (c: SupabaseClient, id: string, changes: unknown, ifUpdatedAt?: string) =>
  c.rpc('hire_reschedule_interview', {
    p_interview_id: id,
    p_changes: changes,
    ...(ifUpdatedAt === undefined ? {} : { p_if_updated_at: ifUpdatedAt }),
  });

const cancel = (c: SupabaseClient, id: string) => c.rpc('hire_cancel_interview', { p_interview_id: id });
const setOutcome = (c: SupabaseClient, id: string, outcome: string | null) =>
  c.rpc('hire_set_interview_outcome', { p_interview_id: id, p_outcome: outcome });
const reopen = (c: SupabaseClient, id: string) => c.rpc('hire_reopen_interview', { p_interview_id: id });

/** The word a call answered with: the text itself, or the `word` of a jsonb answer. Null when it raised. */
function wordOf(res: Res): string | null {
  if (res.error) return null;
  const answer = res.data;
  const got = answer && typeof answer === 'object' ? (answer as { word?: unknown }).word : answer;
  return typeof got === 'string' ? got : null;
}

/** The function must answer with exactly this word and no error: an error for another reason cannot pass. */
function expectWord(res: Res, word: string) {
  expect(res.error, res.error?.message).toBeNull();
  expect(wordOf(res)).toBe(word);
}

/** An `ok` from hire_reschedule_interview, with whether the stored time became another instant. */
function expectMoved(res: Res, moved: boolean) {
  expectWord(res, 'ok');
  expect((res.data as { moved?: unknown }).moved, 'moved').toBe(moved);
}

/** An `ok` from one of the two functions that create a row, with the new interview's id. */
function expectCreated(res: Res): string {
  expectWord(res, 'ok');
  const id = (res.data as { id?: unknown }).id;
  expect(typeof id, 'the answer carries the new id').toBe('string');
  return id as string;
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

async function readInterview(c: SupabaseClient, id: string): Promise<Row | null> {
  const res = await c.from('hire_interviews').select(ROW).eq('id', id).maybeSingle();
  expect(res.error, res.error?.message).toBeNull();
  return (res.data as Row | null) ?? null;
}

/** The row, which must be there. */
async function row(id: string): Promise<Row> {
  const found = await readInterview(owner.c, id);
  expect(found, `interview ${id} should exist`).not.toBeNull();
  return found!;
}

/** Every interview of one application, as its workspace's owner reads them, soonest first. */
async function interviewsOf(applicationId: string): Promise<Row[]> {
  const res = await owner.c.from('hire_interviews').select(ROW).eq('application_id', applicationId).order('scheduled_at');
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? []) as Row[];
}

async function outcomeOf(applicationId: string): Promise<string | null> {
  const res = await owner.c.from('hire_applications').select('outcome').eq('id', applicationId).maybeSingle();
  expect(res.error, res.error?.message).toBeNull();
  return (res.data as { outcome: string } | null)?.outcome ?? null;
}

/** A new person with an active application to a job of the owner's workspace. Returns the application's id. */
async function applied(name: string, job: { id: string } = openJob): Promise<string> {
  const added = expectAdded(await add(owner.c, owner.orgId, { name, email: uniqueEmail(), job_id: job.id }), 'created', 'created');
  return added.application_id!;
}

/** A seeded interview of the demo workspace, or null in the minutes the demo is being re-seeded. */
async function demoInterview(label: string): Promise<{ id: string; application_id: string; status: string } | null> {
  if (new Date().getUTCMinutes() <= 2) {
    console.warn(`Skipped the demo part of ${label}: the demo is being re-seeded (minutes :00 to :02).`);
    return null;
  }
  const seeded = await demoGuest.from('hire_interviews').select('id, application_id, status').eq('org_id', demoId).limit(1);
  expect(seeded.error, seeded.error?.message).toBeNull();
  const found = (seeded.data ?? [])[0] as { id: string; application_id: string; status: string } | undefined;
  expect(found, 'the demo workspace should hold a seeded interview').toBeTruthy();
  return found!;
}

/** The targeted demo row, read again by id: its status is what it was. Nothing else about the shared workspace is compared. */
async function expectDemoRowAsItWas(target: { id: string; status: string }) {
  const again = await demoGuest.from('hire_interviews').select('status').eq('id', target.id).maybeSingle();
  expect(again.error, again.error?.message).toBeNull();
  expect((again.data as { status: string } | null)?.status).toBe(target.status);
}

beforeAll(async () => {
  if (!hasService) return;
  owner = await ownedOrg('Hire Interview Owner Sdn Bhd');
  other = await ownedOrg('Hire Interview Other Sdn Bhd');
  member = await invited('member');
  viewerIn = await invited('viewer');
  demoGuest = client();
  await signInAnon(demoGuest);
  const joined = await joinDemo(demoGuest);
  expect(joined.error, joined.error?.message).toBeNull();
  demoId = joined.data as string;
  visitor = createAnonymousClient();

  openJob = await newJob(owner, 'open', openFields());
  otherJob = await newJob(other, 'open', openFields());
}, 180_000);

// The cases run in file order: later ones may read what earlier ones wrote.

testWithSupabase('1. the owner schedules for an active application: ok with an id, and the row holds what was sent', async () => {
  const applicationId = await applied('Schedule One');
  const at = klAt(2, '10:30');
  const id = expectCreated(await schedule(owner.c, applicationId, {
    at,
    duration: 45,
    kind: 'onsite',
    place: 'Level 3, Menara Contoh, Kuala Lumpur',
    interviewer: 'Puan Salmah Harun',
    notes: 'First round. Bring the portfolio.',
  }));

  const saved = await row(id);
  expect(saved).toMatchObject({
    id,
    org_id: owner.orgId, // the application's own workspace: the caller never supplies one
    application_id: applicationId,
    status: 'scheduled',
    duration_minutes: 45,
    kind: 'onsite',
    place: 'Level 3, Menara Contoh, Kuala Lumpur',
    interviewer_name: 'Puan Salmah Harun',
    notes: 'First round. Bring the portfolio.',
  });
  expect(sameInstant(saved.scheduled_at, at), `${saved.scheduled_at} is ${at}`).toBe(true);
  expect(Number.isFinite(Date.parse(saved.updated_at)), 'updated_at is set').toBe(true);
  expect(Date.parse(saved.updated_at)).toBeGreaterThanOrEqual(Date.parse(saved.created_at));
  // Scheduling does not move the application.
  expect(await outcomeOf(applicationId)).toBe('active');
}, 60_000);

testWithSupabase('2. a time sent as 15:00+08:00 is stored as 07:00 UTC', async () => {
  const applicationId = await applied('Zone Check');
  const day = klDate(1);
  const id = expectCreated(await schedule(owner.c, applicationId, { at: `${day}T15:00:00+08:00` }));
  const saved = await row(id);
  expect(new Date(saved.scheduled_at).toISOString()).toBe(`${day}T07:00:00.000Z`);
}, 60_000);

testWithSupabase('3. defaults: only the application, the time, 60 minutes and a type store no place, interviewer or notes', async () => {
  const applicationId = await applied('Defaults Only');
  const id = expectCreated(await schedule(owner.c, applicationId, { at: klAt(1, '09:00'), duration: 60, kind: 'phone' }));
  expect(await row(id)).toMatchObject({
    status: 'scheduled', duration_minutes: 60, kind: 'phone', place: null, interviewer_name: null, notes: null,
  });
}, 60_000);

testWithSupabase('4. a rejected application: not_active, and no row', async () => {
  const applicationId = await applied('Rejected First');
  expectWord(await reject(owner.c, applicationId), 'ok');
  expectWord(await schedule(owner.c, applicationId, { at: klAt(1, '10:00') }), 'not_active');
  expect(await interviewsOf(applicationId)).toHaveLength(0);
}, 60_000);

testWithSupabase('5. ten minutes ago is in_past, two minutes ago is ok, 400 days ahead is too_far_ahead', async () => {
  const applicationId = await applied('Time Limits');
  expectWord(await schedule(owner.c, applicationId, { at: fromNow(-10) }), 'in_past');
  expect(await interviewsOf(applicationId)).toHaveLength(0);

  // Inside the five minutes allowed for a form that was filled in a moment ago.
  expectCreated(await schedule(owner.c, applicationId, { at: fromNow(-2) }));
  expect(await interviewsOf(applicationId)).toHaveLength(1);

  expectWord(await schedule(owner.c, applicationId, { at: fromNow(400 * 24 * 60) }), 'too_far_ahead');
  expect(await interviewsOf(applicationId)).toHaveLength(1);
}, 60_000);

testWithSupabase('6. a length, a type, a place, an interviewer, notes or a time outside the rules: its own word, and no row', async () => {
  const applicationId = await applied('Bad Details');
  const at = klAt(1, '11:00');
  const refusals: Array<[string, Details, string]> = [
    ['10 minutes', { at, duration: 10 }, 'invalid_duration'],
    ['500 minutes', { at, duration: 500 }, 'invalid_duration'],
    ['a type of lunch', { at, kind: 'lunch' }, 'invalid_kind'],
    // Not spaces: a run of spaces is made one before the length is checked.
    ['a place of 301 characters', { at, place: 'x'.repeat(301) }, 'invalid_place'],
    ['an interviewer of 121 characters', { at, interviewer: 'y'.repeat(121) }, 'invalid_interviewer'],
    ['notes of 2,001 characters', { at, notes: 'z'.repeat(2001) }, 'invalid_notes'],
    ['no time', { at: null }, 'invalid_time'],
  ];
  for (const [label, details, word] of refusals) {
    const res = (await schedule(owner.c, applicationId, details)) as Res;
    expect(res.error, `${label}: ${res.error?.message}`).toBeNull();
    expect(wordOf(res), label).toBe(word);
    expect(await interviewsOf(applicationId), `after ${label}`).toHaveLength(0);
  }
  // The limits themselves are allowed.
  expectCreated(await schedule(owner.c, applicationId, { at, duration: 15, place: 'x'.repeat(300) }));
  expectCreated(await schedule(owner.c, applicationId, { at: klAt(1, '14:00'), duration: 480 }));
}, 120_000);

testWithSupabase('7. the same application at the same instant again: duplicate, still one row; another application at that instant: ok', async () => {
  const applicationId = await applied('Twice Over');
  const at = klAt(3, '15:00');
  expectCreated(await schedule(owner.c, applicationId, { at }));
  expectWord(await schedule(owner.c, applicationId, { at }), 'duplicate');
  // The same instant written another way is still the same instant.
  expectWord(await schedule(owner.c, applicationId, { at: new Date(at).toISOString() }), 'duplicate');
  expect(await interviewsOf(applicationId)).toHaveLength(1);

  const anotherId = await applied('Twice Over Other');
  expectCreated(await schedule(owner.c, anotherId, { at }));
  expect(await interviewsOf(anotherId)).toHaveLength(1);

  // A second round at another time is allowed.
  expectCreated(await schedule(owner.c, applicationId, { at: klAt(5, '15:00') }));
  expect(await interviewsOf(applicationId)).toHaveLength(2);

  // A double press: the same call sent twice at once, by two people. Both answer with a word, neither raises, and
  // exactly one row is made.
  for (let round = 0; round < 3; round += 1) {
    const racedId = await applied(`Double Press ${round}`);
    const racedAt = klAt(4, '16:00');
    const both = (await Promise.all([
      schedule(owner.c, racedId, { at: racedAt }),
      schedule(member, racedId, { at: racedAt }),
    ])) as Res[];
    for (const res of both) expect(res.error, `round ${round}: ${res.error?.message}`).toBeNull();
    expect(both.map(wordOf).sort(), `round ${round}`).toEqual(['duplicate', 'ok']);
    expect(await interviewsOf(racedId), `round ${round}`).toHaveLength(1);
  }
}, 180_000);

testWithSupabase('8. reschedule: what is sent is saved, what is not sent stays, null clears, and nothing new means unchanged', async () => {
  const applicationId = await applied('Moved Around');
  const id = expectCreated(await schedule(owner.c, applicationId, {
    at: klAt(2, '15:00'), place: 'https://meet.example.com/first', interviewer: 'Encik Rosli Daud',
  }));
  const first = await row(id);

  // A new time and a new place.
  const movedTo = klAt(3, '11:00');
  expectMoved(await reschedule(owner.c, id, { scheduled_at: movedTo, place: 'https://meet.example.com/second' }), true);
  const moved = await row(id);
  expect(sameInstant(moved.scheduled_at, movedTo), `${moved.scheduled_at} is ${movedTo}`).toBe(true);
  expect(moved.place).toBe('https://meet.example.com/second');
  expect(moved).toMatchObject({ interviewer_name: 'Encik Rosli Daud', duration_minutes: 60, kind: 'video', status: 'scheduled' });
  expect(Date.parse(moved.updated_at), 'updated_at moved').toBeGreaterThan(Date.parse(first.updated_at));
  expect(moved.created_at).toBe(first.created_at);

  // Only the notes: the time is left alone.
  expectMoved(await reschedule(owner.c, id, { notes: 'Second round.' }), false);
  const noted = await row(id);
  expect(noted.notes).toBe('Second round.');
  expect(noted.scheduled_at).toBe(moved.scheduled_at);
  expect(noted.place).toBe('https://meet.example.com/second');

  // null clears the place.
  expectMoved(await reschedule(owner.c, id, { place: null }), false);
  const cleared = await row(id);
  expect(cleared.place).toBeNull();
  expect(cleared.notes).toBe('Second round.');

  // A key outside the list, and something that is not an object: invalid_changes, nothing saved.
  for (const bad of [{ colour: 'red' }, { status: 'completed' }, { notes: 'x', org_id: other.orgId }, 'tomorrow', ['notes']]) {
    expectWord(await reschedule(owner.c, id, bad), 'invalid_changes');
    expect(await row(id), `after ${JSON.stringify(bad)}`).toEqual(cleared);
  }

  // The stored values sent back, every one of them: unchanged, and updated_at does not move.
  expectWord(
    await reschedule(owner.c, id, {
      scheduled_at: movedTo,
      duration_minutes: cleared.duration_minutes,
      kind: cleared.kind,
      place: null,
      interviewer_name: cleared.interviewer_name,
      notes: cleared.notes,
    }),
    'unchanged',
  );
  expectWord(await reschedule(owner.c, id, { scheduled_at: movedTo }), 'unchanged');
  expect(await row(id)).toEqual(cleared);
}, 120_000);

testWithSupabase('9. reschedule with an old p_if_updated_at: changed, and nothing is saved', async () => {
  const applicationId = await applied('Stale Screen');
  const id = expectCreated(await schedule(owner.c, applicationId, { at: klAt(2, '14:00') }));
  // The value is passed back exactly as it was read. Never through a JS Date: that keeps milliseconds only, and
  // the column holds microseconds.
  const stale = (await row(id)).updated_at;

  // A colleague changes it.
  expectWord(await reschedule(member, id, { notes: 'Changed by a colleague.' }), 'ok');
  const afterColleague = await row(id);
  expect(afterColleague.updated_at).not.toBe(stale);

  // The first screen, not yet refreshed, sends its change with what it last saw.
  expectWord(await reschedule(owner.c, id, { scheduled_at: klAt(4, '09:00'), notes: 'Mine.' }, stale), 'changed');
  expect(await row(id)).toEqual(afterColleague);

  // With the value it has now, the change goes through.
  expectWord(await reschedule(owner.c, id, { notes: 'Mine.' }, afterColleague.updated_at), 'ok');
  expect((await row(id)).notes).toBe('Mine.');
}, 60_000);

testWithSupabase('10. the notes of a scheduled interview whose time has passed can be edited; moving it to another past time is in_past', async () => {
  const applicationId = await applied('Already Begun');
  // The only way to a scheduled interview in the past: two minutes ago is inside the five minutes allowed.
  const id = expectCreated(await schedule(owner.c, applicationId, { at: fromNow(-2) }));
  const before = await row(id);

  expectWord(await reschedule(owner.c, id, { notes: 'Ran over by ten minutes.' }), 'ok');
  const noted = await row(id);
  expect(noted.notes).toBe('Ran over by ten minutes.');
  expect(noted.scheduled_at).toBe(before.scheduled_at);

  expectWord(await reschedule(owner.c, id, { scheduled_at: fromNow(-10) }), 'in_past');
  expectWord(await reschedule(owner.c, id, { scheduled_at: fromNow(400 * 24 * 60) }), 'too_far_ahead');
  expect(await row(id)).toEqual(noted);
}, 60_000);

testWithSupabase('11. cancel, then reschedule: not_scheduled; cancel again: not_scheduled', async () => {
  const applicationId = await applied('Called Off');
  const id = expectCreated(await schedule(owner.c, applicationId, { at: klAt(2, '10:00') }));
  expectWord(await cancel(owner.c, id), 'ok');
  const cancelled = await row(id);
  expect(cancelled.status).toBe('cancelled');

  expectWord(await reschedule(owner.c, id, { scheduled_at: klAt(3, '10:00') }), 'not_scheduled');
  expectWord(await cancel(owner.c, id), 'not_scheduled');
  expect(await row(id)).toEqual(cancelled);
  // It stays in the list.
  expect(await interviewsOf(applicationId)).toHaveLength(1);
}, 60_000);

testWithSupabase('12. completed, then no-show: not_scheduled; reopen: ok; reopen again: not_closed; then no-show: ok', async () => {
  const applicationId = await applied('Marked Twice');
  const id = expectCreated(await schedule(owner.c, applicationId, { at: fromNow(-2) }));

  // An outcome outside the two: invalid_outcome, and it is still scheduled.
  for (const outcome of ['scheduled', 'cancelled', 'done', '', null]) {
    expectWord(await setOutcome(owner.c, id, outcome), 'invalid_outcome');
  }
  expect((await row(id)).status).toBe('scheduled');

  expectWord(await setOutcome(owner.c, id, 'completed'), 'ok');
  expect((await row(id)).status).toBe('completed');
  expectWord(await setOutcome(owner.c, id, 'no_show'), 'not_scheduled');
  expect((await row(id)).status).toBe('completed');

  const before = await row(id);
  expectWord(await reopen(owner.c, id), 'ok');
  const reopened = await row(id);
  expect(reopened.status).toBe('scheduled');
  // Its time and details are as they were.
  expect({ ...reopened, status: before.status, updated_at: before.updated_at }).toEqual(before);

  expectWord(await reopen(owner.c, id), 'not_closed');
  expectWord(await setOutcome(owner.c, id, 'no_show'), 'ok');
  expect((await row(id)).status).toBe('no_show');
}, 60_000);

testWithSupabase('13. an interview whose time is still ahead can be marked completed', async () => {
  const applicationId = await applied('Early Finish');
  const id = expectCreated(await schedule(owner.c, applicationId, { at: klAt(3, '10:00') }));
  expectWord(await setOutcome(owner.c, id, 'completed'), 'ok');
  expect((await row(id)).status).toBe('completed');
}, 60_000);

testWithSupabase('14. after its application is rejected, an interview cannot be rescheduled (not_active) but can be cancelled', async () => {
  const applicationId = await applied('Rejected Later');
  const id = expectCreated(await schedule(owner.c, applicationId, { at: klAt(2, '10:00') }));
  expectWord(await reject(owner.c, applicationId), 'ok');
  // The rejection leaves the interview as it is.
  const kept = await row(id);
  expect(kept.status).toBe('scheduled');

  expectWord(await reschedule(owner.c, id, { scheduled_at: klAt(3, '10:00') }), 'not_active');
  expectWord(await reschedule(owner.c, id, { notes: 'Any change at all.' }), 'not_active');
  expect(await row(id)).toEqual(kept);

  expectWord(await cancel(owner.c, id), 'ok');
  expect((await row(id)).status).toBe('cancelled');
}, 60_000);

testWithSupabase('15. a member can do all of them; a viewer is told forbidden, another workspace not_found, a signed-out caller is refused; nothing changes', async () => {
  const applicationId = await applied('Role Check');

  // A member who is neither owner nor admin.
  const id = expectCreated(await schedule(member, applicationId, { at: klAt(2, '10:00') }));
  expectWord(await reschedule(member, id, { notes: 'From a member.' }), 'ok');
  expectWord(await cancel(member, id), 'ok');
  expectWord(await reopen(member, id), 'ok');
  expectWord(await setOutcome(member, id, 'completed'), 'ok');
  expectWord(await reopen(member, id), 'ok');
  expectCreated(await recordPast(member, applicationId, { at: klAt(-1, '10:00'), outcome: 'completed' }));

  const before = await row(id);
  expect(before.status).toBe('scheduled');
  const countBefore = (await interviewsOf(applicationId)).length;

  // A viewer of this very workspace: told so, for all five.
  expectWord(await schedule(viewerIn, applicationId, { at: klAt(3, '10:00') }), 'forbidden');
  expectWord(await reschedule(viewerIn, id, { notes: 'From a viewer.' }), 'forbidden');
  expectWord(await cancel(viewerIn, id), 'forbidden');
  expectWord(await setOutcome(viewerIn, id, 'no_show'), 'forbidden');
  expectWord(await reopen(viewerIn, id), 'forbidden');
  // The viewer can still read it.
  expect(await readInterview(viewerIn, id)).toEqual(before);

  // The owner of another workspace: every id of this one reads as missing, the application's included.
  expectWord(await schedule(other.c, applicationId, { at: klAt(3, '10:00') }), 'not_found');
  expectWord(await reschedule(other.c, id, { notes: 'From outside.' }), 'not_found');
  expectWord(await cancel(other.c, id), 'not_found');
  expectWord(await setOutcome(other.c, id, 'no_show'), 'not_found');
  expectWord(await reopen(other.c, id), 'not_found');
  expect(await readInterview(other.c, id), 'not readable from another workspace').toBeNull();
  const foreign = await other.c.from('hire_interviews').select('id').eq('org_id', other.orgId);
  expect(foreign.error, foreign.error?.message).toBeNull();
  expect(foreign.data ?? [], 'nothing landed in the other workspace').toHaveLength(0);

  // An id that does not exist reads the same.
  expectWord(await schedule(owner.c, NONE, { at: klAt(3, '10:00') }), 'not_found');
  expectWord(await reschedule(owner.c, NONE, { notes: 'Nobody.' }), 'not_found');
  expectWord(await cancel(owner.c, NONE), 'not_found');
  expectWord(await setOutcome(owner.c, NONE, 'completed'), 'not_found');
  expectWord(await reopen(owner.c, NONE), 'not_found');

  // No session: refused by the API before any function runs.
  expectRefusedOutright(await schedule(visitor, applicationId, { at: klAt(3, '10:00') }), 'visitor schedule');
  expectRefusedOutright(await reschedule(visitor, id, { notes: 'x' }), 'visitor reschedule');
  expectRefusedOutright(await cancel(visitor, id), 'visitor cancel');
  expectRefusedOutright(await setOutcome(visitor, id, 'completed'), 'visitor outcome');
  expectRefusedOutright(await reopen(visitor, id), 'visitor reopen');

  // Nothing changed.
  expect(await row(id)).toEqual(before);
  expect(await interviewsOf(applicationId)).toHaveLength(countBefore);

  // The demo workspace: every guest is a viewer, so a seeded row answers forbidden. Only that row is read again.
  const demo = await demoInterview('case 15');
  if (!demo) return;
  expectWord(await schedule(demoGuest, demo.application_id, { at: klAt(3, '10:00') }), 'forbidden');
  expectWord(await reschedule(demoGuest, demo.id, { notes: 'From a guest.' }), 'forbidden');
  expectWord(await cancel(demoGuest, demo.id), 'forbidden');
  expectWord(await setOutcome(demoGuest, demo.id, 'completed'), 'forbidden');
  expectWord(await reopen(demoGuest, demo.id), 'forbidden');
  await expectDemoRowAsItWas(demo);
}, 180_000);

// tests/hire.rls.test.ts has a case titled "an owner still cannot write candidates, applications or interviews"
// that only ever tries a candidate. This is where the interview half is really asserted.
testWithSupabase('16. a direct insert, update and delete on hire_interviews is refused for an owner', async () => {
  const applicationId = await applied('Direct Write');
  const id = expectCreated(await schedule(owner.c, applicationId, { at: klAt(2, '09:00') }));
  const before = await row(id);

  const inserted = await owner.c
    .from('hire_interviews')
    .insert({ org_id: owner.orgId, application_id: applicationId, scheduled_at: klAt(4, '09:00'), kind: 'video' })
    .select('id');
  expect(inserted.error, 'insert refused').not.toBeNull();
  expect(inserted.data ?? [], 'no row came back from the insert').toHaveLength(0);

  const updated = await owner.c.from('hire_interviews').update({ status: 'cancelled' }).eq('id', id).select('id');
  expect(Boolean(updated.error) || (updated.data ?? []).length === 0, 'update refused').toBe(true);

  const moved = await owner.c.from('hire_interviews').update({ scheduled_at: klAt(6, '09:00') }).eq('id', id).select('id');
  expect(Boolean(moved.error) || (moved.data ?? []).length === 0, 'update of the time refused').toBe(true);

  const deleted = await owner.c.from('hire_interviews').delete().eq('id', id).select('id');
  expect(Boolean(deleted.error) || (deleted.data ?? []).length === 0, 'delete refused').toBe(true);

  expect(await row(id)).toEqual(before);
  expect(await interviewsOf(applicationId)).toHaveLength(1);
}, 60_000);

testWithSupabase('17. after its application is deleted the interview is gone, and every function answers not_found', async () => {
  const applicationId = await applied('Deleted With It');
  const id = expectCreated(await schedule(owner.c, applicationId, { at: klAt(2, '10:00') }));

  const removed = await owner.c.rpc('hire_delete_application', { p_application_id: applicationId });
  expectWord(removed as Res, 'ok');
  expect((removed.data as { interviews?: number }).interviews, 'the deletion counted it').toBe(1);
  expect(await readInterview(owner.c, id)).toBeNull();

  expectWord(await reschedule(owner.c, id, { notes: 'Too late.' }), 'not_found');
  expectWord(await cancel(owner.c, id), 'not_found');
  expectWord(await setOutcome(owner.c, id, 'completed'), 'not_found');
  expectWord(await reopen(owner.c, id), 'not_found');
  // And nothing can be added to an application that is gone.
  expectWord(await schedule(owner.c, applicationId, { at: klAt(3, '10:00') }), 'not_found');
  expectWord(await recordPast(owner.c, applicationId, { at: klAt(-1, '10:00'), outcome: 'completed' }), 'not_found');
}, 60_000);

// The two take turns on the application's row. Rejection first: the schedule answers not_active and no row is made.
// Schedule first: it is saved, and the application is then rejected with one interview still scheduled. Nothing else
// is an allowed end state, and neither call may raise.
testWithSupabase('18. a schedule racing a rejection of the same application: both answer with a word, and the end state is one of the two', async () => {
  for (let round = 0; round < 5; round += 1) {
    const applicationId = await applied(`Race ${round}`);
    const [scheduled, rejected] = (await Promise.all([
      schedule(owner.c, applicationId, { at: klAt(2, '15:00') }),
      reject(member, applicationId),
    ])) as [Res, Res];
    expect(scheduled.error, `round ${round}: ${scheduled.error?.message}`).toBeNull();
    expect(rejected.error, `round ${round}: ${rejected.error?.message}`).toBeNull();

    // The rejection always goes through: nothing about an interview stops it.
    expect(wordOf(rejected), `round ${round}`).toBe('ok');
    const word = wordOf(scheduled);
    expect(['ok', 'not_active'], `round ${round}`).toContain(word);

    expect(await outcomeOf(applicationId), `round ${round}`).toBe('rejected');
    const rows = await interviewsOf(applicationId);
    expect(rows, `round ${round}: one row exactly when the schedule went first`).toHaveLength(word === 'ok' ? 1 : 0);
    if (word === 'ok') expect(rows[0].status, `round ${round}`).toBe('scheduled');
  }
}, 180_000);

// ─── recording a past interview ──────────────────────────────────────────────

let past: { applicationId: string; at: string; id: string };
let pastRejected: { applicationId: string; at: string; id: string };

testWithSupabase('19. a past interview recorded as completed, and one as a no-show: ok with an id, and the row holds what was sent', async () => {
  const applicationId = await applied('Already Held');
  const at = klAt(-1, '15:00');
  const id = expectCreated(await recordPast(owner.c, applicationId, {
    at,
    duration: 90,
    kind: 'onsite',
    outcome: 'completed',
    place: 'Level 3, Menara Contoh, Kuala Lumpur',
    interviewer: 'Puan Salmah Harun',
    notes: 'Entered the day after.',
  }));
  const saved = await row(id);
  expect(saved).toMatchObject({
    org_id: owner.orgId,
    application_id: applicationId,
    status: 'completed', // never created as scheduled
    duration_minutes: 90,
    kind: 'onsite',
    place: 'Level 3, Menara Contoh, Kuala Lumpur',
    interviewer_name: 'Puan Salmah Harun',
    notes: 'Entered the day after.',
  });
  expect(sameInstant(saved.scheduled_at, at), `${saved.scheduled_at} is ${at}`).toBe(true);
  past = { applicationId, at, id };

  const absentId = await applied('Never Came');
  const missedId = expectCreated(await recordPast(owner.c, absentId, { at: klAt(-3, '10:00'), outcome: 'no_show' }));
  expect(await row(missedId)).toMatchObject({
    org_id: owner.orgId, application_id: absentId, status: 'no_show', duration_minutes: 60, kind: 'video',
    place: null, interviewer_name: null, notes: null,
  });

  // A start a moment ago is past.
  const justNowId = await applied('Just Now');
  expectCreated(await recordPast(owner.c, justNowId, { at: fromNow(-1), outcome: 'completed' }));
}, 120_000);

testWithSupabase('20. a start ahead is not_past, 400 days ago is too_far_back, an outcome outside the two is invalid_outcome; no row in any of these', async () => {
  const applicationId = await applied('Bad Past');
  const yesterday = klAt(-1, '11:00');
  const refusals: Array<[string, Details & { outcome: string | null }, string]> = [
    ['an hour ahead', { at: fromNow(60), outcome: 'completed' }, 'not_past'],
    ['400 days ago', { at: fromNow(-400 * 24 * 60), outcome: 'completed' }, 'too_far_back'],
    ['an outcome of scheduled', { at: yesterday, outcome: 'scheduled' }, 'invalid_outcome'],
    ['an outcome of cancelled', { at: yesterday, outcome: 'cancelled' }, 'invalid_outcome'],
    ['no outcome', { at: yesterday, outcome: null }, 'invalid_outcome'],
    ['10 minutes long', { at: yesterday, outcome: 'completed', duration: 10 }, 'invalid_duration'],
    ['a type of lunch', { at: yesterday, outcome: 'completed', kind: 'lunch' }, 'invalid_kind'],
  ];
  for (const [label, details, word] of refusals) {
    const res = (await recordPast(owner.c, applicationId, details)) as Res;
    expect(res.error, `${label}: ${res.error?.message}`).toBeNull();
    expect(wordOf(res), label).toBe(word);
    expect(await interviewsOf(applicationId), `after ${label}`).toHaveLength(0);
  }
}, 120_000);

testWithSupabase('21. a past interview can be recorded for a rejected application', async () => {
  const applicationId = await applied('Rejected Yet Held');
  expectWord(await reject(owner.c, applicationId), 'ok');
  const at = klAt(-2, '14:00');
  const id = expectCreated(await recordPast(owner.c, applicationId, { at, outcome: 'completed' }));
  expect(await row(id)).toMatchObject({ application_id: applicationId, status: 'completed', org_id: owner.orgId });
  expect(await outcomeOf(applicationId), 'recording does not reopen it').toBe('rejected');
  pastRejected = { applicationId, at, id };
}, 60_000);

testWithSupabase('22. the same application at the same instant again: duplicate, and nothing is added', async () => {
  const before = (await interviewsOf(past.applicationId)).length;
  expectWord(await recordPast(owner.c, past.applicationId, { at: past.at, outcome: 'completed' }), 'duplicate');
  // Whatever its status would have been.
  expectWord(await recordPast(owner.c, past.applicationId, { at: past.at, outcome: 'no_show' }), 'duplicate');
  expect(await interviewsOf(past.applicationId)).toHaveLength(before);
  expectWord(await recordPast(owner.c, pastRejected.applicationId, { at: pastRejected.at, outcome: 'completed' }), 'duplicate');

  // Two people entering the same meeting at once: both answer with a word, neither raises, one row.
  for (let round = 0; round < 3; round += 1) {
    const racedId = await applied(`Entered Twice ${round}`);
    const racedAt = klAt(-1, '09:00');
    const both = (await Promise.all([
      recordPast(owner.c, racedId, { at: racedAt, outcome: 'completed' }),
      recordPast(member, racedId, { at: racedAt, outcome: 'completed' }),
    ])) as Res[];
    for (const res of both) expect(res.error, `round ${round}: ${res.error?.message}`).toBeNull();
    expect(both.map(wordOf).sort(), `round ${round}`).toEqual(['duplicate', 'ok']);
    expect(await interviewsOf(racedId), `round ${round}`).toHaveLength(1);
  }
}, 180_000);

testWithSupabase('23. hire_schedule_interview for that same past time still answers in_past', async () => {
  const before = (await interviewsOf(past.applicationId)).length;
  expectWord(await schedule(owner.c, past.applicationId, { at: past.at }), 'in_past');
  // On an application with no interview at that time, too: recording is never a way round the refusal.
  const freshId = await applied('Not A Way Round');
  expectWord(await schedule(owner.c, freshId, { at: past.at }), 'in_past');
  expect(await interviewsOf(past.applicationId)).toHaveLength(before);
  expect(await interviewsOf(freshId)).toHaveLength(0);
}, 60_000);

testWithSupabase('24. recording: a viewer is told forbidden, another workspace not_found, a signed-out caller is refused; nothing changes', async () => {
  const before = await interviewsOf(past.applicationId);
  const at = klAt(-2, '11:00');

  expectWord(await recordPast(viewerIn, past.applicationId, { at, outcome: 'completed' }), 'forbidden');
  expectWord(await recordPast(other.c, past.applicationId, { at, outcome: 'completed' }), 'not_found');
  expectWord(await recordPast(owner.c, NONE, { at, outcome: 'completed' }), 'not_found');
  expectRefusedOutright(await recordPast(visitor, past.applicationId, { at, outcome: 'completed' }), 'visitor record');

  expect(await interviewsOf(past.applicationId)).toEqual(before);
  const foreign = await other.c.from('hire_interviews').select('id').eq('org_id', other.orgId);
  expect(foreign.error, foreign.error?.message).toBeNull();
  expect(foreign.data ?? [], 'nothing landed in the other workspace').toHaveLength(0);
  // The other workspace's own job has no application this file made: nothing of the owner's leaked there either.
  const otherApplications = await other.c.from('hire_applications').select('id').eq('job_id', otherJob.id);
  expect(otherApplications.error, otherApplications.error?.message).toBeNull();
  expect(otherApplications.data ?? []).toHaveLength(0);

  const demo = await demoInterview('case 24');
  if (!demo) return;
  expectWord(await recordPast(demoGuest, demo.application_id, { at, outcome: 'completed' }), 'forbidden');
  await expectDemoRowAsItWas(demo);
}, 120_000);

testWithSupabase('25. a recorded interview can be marked as scheduled again, and then marked completed', async () => {
  const before = await row(past.id);
  expect(before.status).toBe('completed');

  expectWord(await reopen(owner.c, past.id), 'ok');
  const reopened = await row(past.id);
  expect(reopened.status).toBe('scheduled');
  expect(reopened.scheduled_at, 'its time is as it was, though it is in the past').toBe(before.scheduled_at);

  expectWord(await setOutcome(owner.c, past.id, 'completed'), 'ok');
  expect((await row(past.id)).status).toBe('completed');
}, 60_000);

// ─── added after the migrations were written ─────────────────────────────────

// The time arrives as TEXT and is turned into an instant by private.hire_zoned_instant, because a parameter typed
// timestamptz would be cast in the session's zone (UTC) before the function ran: "2026-10-20T15:00:00" would be
// stored as 15:00 UTC (23:00 in Kuala Lumpur) and answered ok. No unit test can show that, so it is pinned here.
testWithSupabase('26. a time with no zone, an impossible date or an empty string is invalid_time, and nothing is written', async () => {
  const day = klDate(2);
  const yesterday = klDate(-1);
  const badTimes: Array<[string, string]> = [
    ['no zone', `${day}T15:00:00`],
    ['no zone and no seconds', `${day}T15:00`],
    ['a date alone', day],
    ['a space for the T', `${day} 15:00:00+08:00`],
    ['an offset of +08', `${day}T15:00:00+08`],
    ['an offset of +0800', `${day}T15:00:00+0800`],
    ['30 February', '2027-02-30T10:00:00+08:00'],
    ['month 13', '2027-13-01T10:00:00+08:00'],
    ['hour 25', `${day}T25:00:00+08:00`],
    ['an empty string', ''],
    ['only spaces', '   '],
    ['words', 'tomorrow afternoon'],
  ];

  const applicationId = await applied('Zone Rules');
  for (const [label, at] of badTimes) {
    expectWord(await schedule(owner.c, applicationId, { at }), 'invalid_time');
    expect(await interviewsOf(applicationId), `schedule with ${label}`).toHaveLength(0);
  }

  const pastId = await applied('Zone Rules Past');
  const badPast: Array<[string, string]> = [
    ['no zone', `${yesterday}T10:00:00`],
    ['30 February', '2027-02-30T10:00:00+08:00'],
    ['an empty string', ''],
  ];
  for (const [label, at] of badPast) {
    expectWord(await recordPast(owner.c, pastId, { at, outcome: 'completed' }), 'invalid_time');
    expect(await interviewsOf(pastId), `record with ${label}`).toHaveLength(0);
  }

  const movedId = await applied('Zone Rules Moved');
  const id = expectCreated(await schedule(owner.c, movedId, { at: klAt(2, '10:00') }));
  const before = await row(id);
  for (const [label, at] of badTimes) {
    expectWord(await reschedule(owner.c, id, { scheduled_at: at }), 'invalid_time');
    expect(await row(id), `reschedule with ${label}`).toEqual(before);
  }
  // Not text at all: also a word, never an error.
  expectWord(await reschedule(owner.c, id, { scheduled_at: 12 }), 'invalid_time');
  expectWord(await reschedule(owner.c, id, { scheduled_at: null }), 'invalid_time');
  expect(await row(id)).toEqual(before);

  // With a zone it is the instant that counts, however it is written: +08:00, Z and +09:00 each store one instant.
  const plus8 = expectCreated(await schedule(owner.c, applicationId, { at: `${day}T15:00:00+08:00` }));
  expect(new Date((await row(plus8)).scheduled_at).toISOString()).toBe(`${day}T07:00:00.000Z`);
  const zulu = expectCreated(await schedule(owner.c, pastId, { at: `${day}T07:00:00Z` }));
  expect(new Date((await row(zulu)).scheduled_at).toISOString()).toBe(`${day}T07:00:00.000Z`);
  const plus9 = expectCreated(await schedule(owner.c, movedId, { at: `${day}T16:00:00+09:00` }));
  expect(new Date((await row(plus9)).scheduled_at).toISOString()).toBe(`${day}T07:00:00.000Z`);
  // Moving by text with an offset stores the instant too.
  expectMoved(await reschedule(owner.c, id, { scheduled_at: `${klDate(3)}T09:30:00+08:00` }), true);
  expect(new Date((await row(id)).scheduled_at).toISOString()).toBe(`${klDate(3)}T01:30:00.000Z`);
  // And a past interview recorded with an offset.
  const recorded = expectCreated(await recordPast(owner.c, pastId, { at: `${yesterday}T10:00:00+08:00`, outcome: 'completed' }));
  expect(new Date((await row(recorded)).scheduled_at).toISOString()).toBe(`${yesterday}T02:00:00.000Z`);
}, 180_000);

// hire_reschedule_interview answers { word: 'ok', moved }. The invitation's "has a new time" rests on `moved`, and a
// form often sends the time along unchanged with another edit, so only the database can say whether it moved.
testWithSupabase('27. reschedule answers moved: true for a new instant, false for the same instant written another way or no time', async () => {
  const applicationId = await applied('Moved Or Not');
  const at = klAt(2, '15:00');
  const id = expectCreated(await schedule(owner.c, applicationId, { at }));

  // The same instant, written with a different offset (the Z form), with another field changed.
  const zulu = new Date(at).toISOString();
  expect(zulu).not.toBe(at);
  expectMoved(await reschedule(owner.c, id, { scheduled_at: zulu, notes: 'Same time, new note.' }), false);
  expect(sameInstant((await row(id)).scheduled_at, at)).toBe(true);
  expect((await row(id)).notes).toBe('Same time, new note.');

  // The same instant written the original way, with another field changed.
  expectMoved(await reschedule(owner.c, id, { scheduled_at: at, duration_minutes: 90 }), false);

  // No time sent at all.
  expectMoved(await reschedule(owner.c, id, { place: 'Level 2' }), false);
  expectMoved(await reschedule(owner.c, id, { kind: 'onsite' }), false);

  // A different instant: one minute later.
  const later = klAt(2, '15:01');
  expectMoved(await reschedule(owner.c, id, { scheduled_at: later }), true);
  expect(sameInstant((await row(id)).scheduled_at, later)).toBe(true);

  // A different day at the same clock time.
  expectMoved(await reschedule(owner.c, id, { scheduled_at: klAt(4, '15:01'), notes: 'Another day.' }), true);

  // A refusal carries no `moved`: it is { word } alone.
  const refused = (await reschedule(owner.c, id, { scheduled_at: klAt(4, '15:01') })) as Res;
  expectWord(refused, 'unchanged');
  expect((refused.data as { moved?: unknown }).moved, 'a refusal has no moved').toBeUndefined();
}, 120_000);

// The app reads what PostgREST returns for a timestamptz with instantMs, which refuses text with no zone or with
// +00 / +0800. Task 2's reviewer asked for one live assertion that the text really carries a readable offset.
testWithSupabase('28. a timestamp read back through the member client carries an offset the app can read', async () => {
  const applicationId = await applied('Offset Shape');
  const at = klAt(2, '15:00');
  const id = expectCreated(await schedule(owner.c, applicationId, { at }));
  for (const [who, c] of [['member', member], ['owner', owner.c], ['viewer', viewerIn]] as const) {
    const seen = await readInterview(c, id);
    expect(seen, `${who} reads it`).not.toBeNull();
    for (const [column, text] of [
      ['scheduled_at', seen!.scheduled_at],
      ['updated_at', seen!.updated_at],
      ['created_at', seen!.created_at],
    ] as const) {
      const label = `${who} ${column} = ${text}`;
      expect(text, label).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
      expect(Number.isFinite(instantMs(text)), `instantMs accepts it: ${label}`).toBe(true);
      expect(instantMs(text), label).toBe(Date.parse(text));
    }
    expect(instantMs(seen!.scheduled_at)).toBe(Date.parse(at));
  }
}, 60_000);

// The remaining moves of the state machine, and the one duplicate that is allowed on purpose.
testWithSupabase('29. only a scheduled interview can be moved, cancelled or given an outcome; reopen only from a closed one; reopen may make a duplicate', async () => {
  const applicationId = await applied('State Machine');
  const first = expectCreated(await schedule(owner.c, applicationId, { at: klAt(3, '10:00') }));
  const second = expectCreated(await schedule(owner.c, applicationId, { at: klAt(4, '10:00') }));

  // Moving onto another scheduled interview's instant is a duplicate, written either way. Nothing changes.
  const secondBefore = await row(second);
  expectWord(await reschedule(owner.c, second, { scheduled_at: klAt(3, '10:00') }), 'duplicate');
  expectWord(await reschedule(owner.c, second, { scheduled_at: new Date(klAt(3, '10:00')).toISOString() }), 'duplicate');
  expect(await row(second)).toEqual(secondBefore);

  // A cancelled interview does not hold its instant: the second can take it.
  expectWord(await cancel(owner.c, first), 'ok');
  expectMoved(await reschedule(owner.c, second, { scheduled_at: klAt(3, '10:00') }), true);

  // "Mark as scheduled again" does not check for another scheduled interview at the same instant. The owner
  // accepted that: it is an undo, and both rows are visible and either can be cancelled. Do not "fix" it by accident.
  expectWord(await reopen(owner.c, first), 'ok');
  const both = (await interviewsOf(applicationId)).filter((r) => r.status === 'scheduled');
  expect(both).toHaveLength(2);
  expect(sameInstant(both[0].scheduled_at, both[1].scheduled_at), 'two scheduled interviews at one instant').toBe(true);
  expectWord(await cancel(owner.c, first), 'ok');

  // A no-show, a completed and a cancelled interview: none can be moved, cancelled or given an outcome.
  const closings = ['no_show', 'completed', 'cancelled'] as const;
  for (const [index, closing] of closings.entries()) {
    const id = expectCreated(await schedule(owner.c, applicationId, { at: klAt(10 + index, '11:00') }));
    expectWord(closing === 'cancelled' ? await cancel(owner.c, id) : await setOutcome(owner.c, id, closing), 'ok');
    const closed = await row(id);
    expect(closed.status).toBe(closing);
    expectWord(await reschedule(owner.c, id, { notes: `After ${closing}.` }), 'not_scheduled');
    expectWord(await reschedule(owner.c, id, { scheduled_at: klAt(20, '11:00') }), 'not_scheduled');
    expectWord(await cancel(owner.c, id), 'not_scheduled');
    expectWord(await setOutcome(owner.c, id, 'completed'), 'not_scheduled');
    expectWord(await setOutcome(owner.c, id, 'no_show'), 'not_scheduled');
    expect(await row(id), `after the refusals on a ${closing} interview`).toEqual(closed);
    // Reopening is allowed from each closed status, and only once.
    expectWord(await reopen(owner.c, id), 'ok');
    expect((await row(id)).status).toBe('scheduled');
    expectWord(await reopen(owner.c, id), 'not_closed');
  }

  // Recording a past interview at the instant of a cancelled one is allowed: only a live one blocks it.
  const heldAt = fromNow(-3);
  const cancelledPast = expectCreated(await schedule(owner.c, applicationId, { at: heldAt }));
  expectWord(await cancel(owner.c, cancelledPast), 'ok');
  expectCreated(await recordPast(owner.c, applicationId, { at: heldAt, outcome: 'no_show' }));
  // And a second recording of the same meeting is a duplicate.
  expectWord(await recordPast(owner.c, applicationId, { at: heldAt, outcome: 'completed' }), 'duplicate');
}, 180_000);

// ─── the read behind an assistant card ───────────────────────────────────────

/** The read as the app makes it: the data object built from a session client and a workspace, then its `interviewCard`. */
const cardRead = (c: SupabaseClient, orgId: string, id: unknown) => createSupabaseHireData(c, orgId).interviewCard!(id);
const NO_CARD = { target: null, others: [], cut: false, also: [], alsoClosed: [], application_outcome: null };

testWithSupabase('30. the read behind a card: the interview itself, the same candidate\'s other interviews under another job, and never a namesake\'s as hers', async () => {
  const secondJob = await newJob(owner, 'card second job', openFields());
  const name = `Card Read Person ${RUN}`;
  const email = uniqueEmail();

  // One candidate with two applications (the second add finds her by her email), and a namesake with one.
  const first = expectAdded(await add(owner.c, owner.orgId, { name, email, job_id: openJob.id }), 'created', 'created');
  const second = expectAdded(await add(owner.c, owner.orgId, { name, email, job_id: secondJob.id }), 'existing', 'created');
  expect(second.candidate_id, 'the same candidate').toBe(first.candidate_id);
  const namesake = expectAdded(await add(owner.c, owner.orgId, { name, email: uniqueEmail(), job_id: openJob.id }), 'created', 'created');
  expect(namesake.candidate_id, 'another candidate with the same name').not.toBe(first.candidate_id);
  const [firstApp, secondApp, namesakeApp] = [first.application_id!, second.application_id!, namesake.application_id!];

  const at = klAt(5, '15:00');
  const place = 'https://meet.example.com/card-read';
  const target = expectCreated(await schedule(owner.c, firstApp, { at, duration: 45, kind: 'video', place, interviewer: 'Farah Lim', notes: 'Never read by the card.' }));
  // Her other scheduled interview, for the other job; one of hers that is over; and the namesake's, for the same job.
  const otherJobs = expectCreated(await schedule(owner.c, secondApp, { at: klAt(6, '10:00'), kind: 'onsite', place: 'Level 3' }));
  const over = expectCreated(await schedule(owner.c, firstApp, { at: klAt(7, '11:00'), kind: 'phone' }));
  expectWord(await cancel(owner.c, over), 'ok');
  const theirs = expectCreated(await schedule(owner.c, namesakeApp, { at: klAt(8, '09:00') }));

  const read = await cardRead(owner.c, owner.orgId, target);

  // Every field the card's line and the last check use.
  expect(read.target).toMatchObject({
    id: target, application_id: firstApp, candidate: name, job: openJob.title, kind: 'video', status: 'scheduled', duration_minutes: 45, place,
  });
  expect(Number.isNaN(instantMs(read.target!.scheduled_at)), 'the stored time is text the app can read').toBe(false);
  expect(sameInstant(read.target!.scheduled_at, at), 'the stored time is the one sent').toBe(true);
  expect(read.application_outcome).toBe('active');
  expect(read.cut).toBe(false);
  // No notes, no interviewer, no contact detail in anything the read answers.
  expect(JSON.stringify(read)).not.toMatch(/Never read by the card|Farah Lim|example\.com(?!\/card-read)/);

  // "Also scheduled": hers under the other job, with that job's title. Not the cancelled one, and not the namesake's.
  expect(read.also.map((i) => i.id)).toEqual([otherJobs]);
  expect(read.also[0]).toMatchObject({ application_id: secondApp, candidate: name, job: secondJob.title, kind: 'onsite', status: 'scheduled', duration_minutes: 60, place: 'Level 3' });
  // "Also closed": hers that is over.
  expect(read.alsoClosed.map((i) => i.id)).toEqual([over]);
  expect(read.alsoClosed[0]).toMatchObject({ application_id: firstApp, job: openJob.title, kind: 'phone', status: 'cancelled' });
  // The ones a card could be taken for: the same name AND the same job, hers or the namesake's. Not the other job's.
  expect(read.others.map((i) => i.id).sort()).toEqual([over, theirs].sort());
  expect(read.others.find((i) => i.id === theirs)).toMatchObject({ application_id: namesakeApp, candidate: name, job: openJob.title });

  // The namesake's own card lists nothing of hers.
  const namesakeRead = await cardRead(owner.c, owner.orgId, theirs);
  expect(namesakeRead.target?.id).toBe(theirs);
  expect(namesakeRead.also).toEqual([]);
  expect(namesakeRead.alsoClosed).toEqual([]);
  expect(namesakeRead.others.map((i) => i.id).sort()).toEqual([target, over].sort());

  // The closed one read as the target (what a "mark as scheduled again" card is about).
  const closedRead = await cardRead(owner.c, owner.orgId, over);
  expect(closedRead.target).toMatchObject({ id: over, status: 'cancelled' });
  expect(closedRead.also.map((i) => i.id).sort()).toEqual([target, otherJobs].sort());
  expect(closedRead.alsoClosed).toEqual([]);

  // A member and a viewer of the same workspace read the same card: the read is what row-level security lets them see.
  for (const [who, label] of [[member, 'member'], [viewerIn, 'viewer']] as const) {
    const theirRead = await cardRead(who, owner.orgId, target);
    expect(theirRead.target?.id, label).toBe(target);
    expect(theirRead.also.map((i) => i.id), label).toEqual([otherJobs]);
  }

  // The application's outcome follows the application.
  expectWord(await reject(owner.c, firstApp), 'ok');
  expect((await cardRead(owner.c, owner.orgId, target)).application_outcome).toBe('rejected');
}, 120_000);

testWithSupabase('31. the read behind a card answers nothing to another workspace, to a demo guest, for an id that is not one, and once the interview is gone', async () => {
  const applicationId = await applied(`Card Gone Person ${RUN}`);
  const id = expectCreated(await schedule(owner.c, applicationId, { at: klAt(4, '10:00') }));
  expect((await cardRead(owner.c, owner.orgId, id)).target?.id).toBe(id);

  // Another workspace's owner: through their own workspace, and when they name the first one.
  expect(await cardRead(other.c, other.orgId, id)).toEqual(NO_CARD);
  expect(await cardRead(other.c, owner.orgId, id)).toEqual(NO_CARD);
  // A viewer of the demo workspace: the same two ways.
  expect(await cardRead(demoGuest, demoId, id)).toEqual(NO_CARD);
  expect(await cardRead(demoGuest, owner.orgId, id)).toEqual(NO_CARD);
  // An id that names nothing, and things that are not ids: no query error, nothing found.
  expect(await cardRead(owner.c, owner.orgId, NONE)).toEqual(NO_CARD);
  for (const odd of [undefined, null, '', 7]) expect(await cardRead(owner.c, owner.orgId, odd)).toEqual(NO_CARD);

  // Its application is deleted, and the interview with it: the read says it is gone, it does not fail.
  expectWord((await owner.c.rpc('hire_delete_application', { p_application_id: applicationId })) as Res, 'ok');
  expect(await cardRead(owner.c, owner.orgId, id)).toEqual(NO_CARD);
}, 120_000);
