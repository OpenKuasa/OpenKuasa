// tests/hire-interview-feedback.rls.test.ts
//
// Live checks of the two functions that are the only way an interview's feedback changes (Lekir slice 4b),
// hire_save_interview_feedback and hire_clear_interview_feedback, and of the one rule 4b adds to 4a's
// hire_reopen_interview. Needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY; without all three every case is skipped.
// WRITTEN, NOT YET RUN: it fails until 20261113090000_hire_interview_feedback_columns.sql and
// 20261113090100_hire_interview_feedback_writes.sql are applied.
//
// The cases are numbered as in the design's section 10, "Database, live" (1 to 15). Cases 16 and 17 are added:
// `mark_completed` for an interview that is already completed, and the reads the app makes (the list a screen and
// the assistant read, and the read behind every Approve card), through the same data object the app builds.
//
// Who calls what. All three functions are granted to `authenticated` only: every call is made by a signed-in client,
// or by the signed-out visitor, who must be refused outright (42501). The service key is never used to call a
// function. `owner` owns a throwaway workspace; `member` and `viewerIn` were invited to it; `other` owns a second
// workspace, to which every id of the first reads as missing. The demo workspace is never read or written here.
//
// Times. Nothing is a fixed date, and no interview is on the hour. A completed interview is made with 4a's
// hire_record_past_interview some minutes ago; a scheduled one with hire_schedule_interview three days ahead.
// Every row this file makes goes with the throwaway workspaces when the shared helper deletes them.
import { randomBytes } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAnonymousClient } from '@/lib/supabase/anonymous';
import { createSupabaseHireData } from '@/lib/hire/supabase';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';

const hasService = hasSupabaseEnv && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const testWithSupabase = hasService ? test : test.skip;
if (!hasService) {
  console.warn(hasSupabaseEnv ? 'Set SUPABASE_SERVICE_ROLE_KEY in .env.local to run the interview feedback checks' : supabaseEnvSkipReason);
}

const RUN = Date.now();
const ROW = 'id, status, updated_at, feedback_rating, feedback_recommendation, feedback_comments, feedback_at';
type Row = {
  id: string; status: string; updated_at: string;
  feedback_rating: number | null; feedback_recommendation: string | null; feedback_comments: string | null; feedback_at: string | null;
};
type Res = { data: unknown; error: { message: string; code?: string } | null };

const KL_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
/** A Kuala Lumpur clock time on the day `days` from today, as the app sends an instant. Never on the hour. */
const klAt = (days: number, time: string) => `${new Date(Date.now() + KL_OFFSET_MS + days * DAY_MS).toISOString().slice(0, 10)}T${time}:00+08:00`;
/** The instant `minutes` ago, as text with its zone. */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

let emailCounter = 0;
const uniqueEmail = () => `rls-feedback-${RUN}-${++emailCounter}@example.com`;

async function ownedOrg(name: string) {
  const c = liveClient();
  const { error: e1 } = await signInOwner(c);
  expect(e1, e1?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, name);
  expect(error, error?.message).toBeNull();
  return { c, orgId: orgId as string };
}
type Owned = Awaited<ReturnType<typeof ownedOrg>>;

let owner: Owned;
let other: Owned;
let member: SupabaseClient;
let viewerIn: SupabaseClient;
let visitor: SupabaseClient;
let job: { id: string };

/** A confirmed test user who accepted an invite to the owner's workspace with this role. */
async function invited(role: 'member' | 'viewer'): Promise<SupabaseClient> {
  const c = liveClient();
  const signUp = await createConfirmedTestUser(c, `Qa-${randomBytes(16).toString('hex')}`);
  const invite = await owner.c.rpc('create_invite', { p_email: signUp.email, p_role: role });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await c.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  expect(accepted.data, `${role} joined the owner's workspace`).toBe(owner.orgId);
  return c;
}

/** The word a call answered with: the text itself, or the `word` of a jsonb answer. Null when it raised. */
function wordOf(res: Res): string | null {
  if (res.error) return null;
  const got = res.data && typeof res.data === 'object' ? (res.data as { word?: unknown }).word : res.data;
  return typeof got === 'string' ? got : null;
}
/** The function must answer with exactly this word and no error. */
function expectWord(res: Res, word: string) {
  expect(res.error, res.error?.message).toBeNull();
  expect(wordOf(res)).toBe(word);
}
/** An `ok` from hire_save_interview_feedback, with what it says it did. */
function expectSaved(res: Res, did: { replaced: boolean; completed: boolean }) {
  expectWord(res, 'ok');
  expect(res.data).toEqual({ word: 'ok', ...did });
}
/** A signed-out caller is refused before the function runs. */
function expectRefusedOutright(res: Res, label: string) {
  expect(res.error, `${label}: expected a permission error`).not.toBeNull();
  expect(res.error?.code, `${label}: ${res.error?.message}`).toBe('42501');
  expect(res.data ?? null, `${label}: no answer`).toBeNull();
}

/** A new person with an active application to the owner's job. Returns the application's id. */
async function applied(name: string): Promise<string> {
  const res = await owner.c.rpc('hire_add_candidate', {
    p_org_id: owner.orgId, p_name: name, p_email: uniqueEmail(), p_phone: null, p_headline: null, p_location: null, p_skills: null, p_source: null,
    p_job_id: job.id, p_cover_letter: null, p_cv_url: null,
  });
  expectWord(res, 'ok');
  return (res.data as { application_id: string }).application_id;
}
/** An interview recorded as already held: `completed` or `no_show`. Returns its id. */
async function held(applicationId: string, outcome: 'completed' | 'no_show' = 'completed', minutesAgo = 90): Promise<string> {
  const res = await owner.c.rpc('hire_record_past_interview', {
    p_application_id: applicationId, p_scheduled_at: ago(minutesAgo), p_duration_minutes: 60, p_kind: 'video', p_outcome: outcome,
    p_place: null, p_interviewer_name: null, p_notes: null,
  });
  expectWord(res, 'ok');
  return (res.data as { id: string }).id;
}
/** A scheduled interview three days ahead. Returns its id. */
async function scheduled(applicationId: string, time = '10:30'): Promise<string> {
  const res = await owner.c.rpc('hire_schedule_interview', {
    p_application_id: applicationId, p_scheduled_at: klAt(3, time), p_duration_minutes: 60, p_kind: 'video', p_place: null, p_interviewer_name: null, p_notes: null,
  });
  expectWord(res, 'ok');
  return (res.data as { id: string }).id;
}
/** A completed interview of a new person. */
const completedInterview = async (name: string) => held(await applied(name));

type Save = { rating?: number | null; recommendation?: string | null; comments?: string | null; mark?: boolean; replace?: boolean; ifAt?: string };
/** hire_save_interview_feedback. A switch left out is the function's default (false, false, no version). */
const save = (c: SupabaseClient, id: string, f: Save = {}) =>
  c.rpc('hire_save_interview_feedback', {
    p_interview_id: id,
    p_rating: f.rating === undefined ? 4 : f.rating,
    p_recommendation: f.recommendation === undefined ? 'advance' : f.recommendation,
    p_comments: f.comments ?? null,
    ...(f.mark === undefined ? {} : { p_mark_completed: f.mark }),
    ...(f.replace === undefined ? {} : { p_replace: f.replace }),
    ...(f.ifAt === undefined ? {} : { p_if_feedback_at: f.ifAt }),
  });
const clear = (c: SupabaseClient, id: string) => c.rpc('hire_clear_interview_feedback', { p_interview_id: id });
const reopen = (c: SupabaseClient, id: string) => c.rpc('hire_reopen_interview', { p_interview_id: id });

async function read(c: SupabaseClient, id: string): Promise<Row | null> {
  const res = await c.from('hire_interviews').select(ROW).eq('id', id).maybeSingle();
  expect(res.error, res.error?.message).toBeNull();
  return (res.data as Row | null) ?? null;
}
/** The row, which must be there, as its workspace's owner reads it. */
async function row(id: string): Promise<Row> {
  const found = await read(owner.c, id);
  expect(found, `interview ${id} should exist`).not.toBeNull();
  return found!;
}
const NO_FEEDBACK = { feedback_rating: null, feedback_recommendation: null, feedback_comments: null, feedback_at: null };

beforeAll(async () => {
  if (!hasService) return;
  owner = await ownedOrg('Hire Feedback Owner Sdn Bhd');
  other = await ownedOrg('Hire Feedback Other Sdn Bhd');
  member = await invited('member');
  viewerIn = await invited('viewer');
  visitor = createAnonymousClient();
  const made = await owner.c.from('hire_jobs')
    .insert({ org_id: owner.orgId, title: `RLS feedback job ${RUN}`, status: 'open', description: 'A real description of the role.', opened_at: new Date().toISOString() })
    .select('id').single();
  expect(made.error, made.error?.message).toBeNull();
  job = made.data as { id: string };
}, 180_000);

testWithSupabase('1. an owner saves feedback on a completed interview: the row holds it, with the time it was saved', async () => {
  const id = await completedInterview('Feedback One');
  expectSaved(await save(owner.c, id, { rating: 4, recommendation: 'advance', comments: '  Strong on key accounts.\nClear about targets.  ' }), { replaced: false, completed: false });
  const after = await row(id);
  expect(after).toMatchObject({ status: 'completed', feedback_rating: 4, feedback_recommendation: 'advance', feedback_comments: 'Strong on key accounts.\nClear about targets.' });
  expect(after.feedback_at).not.toBeNull();
});

testWithSupabase('2. comments are optional and a blank is stored as none; a value outside the rules is answered with its word and nothing is saved', async () => {
  const none = await completedInterview('Feedback Two A');
  expectSaved(await save(owner.c, none), { replaced: false, completed: false });
  expect((await row(none)).feedback_comments).toBeNull();
  const blank = await completedInterview('Feedback Two B');
  expectSaved(await save(owner.c, blank, { comments: '   \n ' }), { replaced: false, completed: false });
  expect((await row(blank)).feedback_comments).toBeNull();
  const id = await completedInterview('Feedback Two C');
  expectWord(await save(owner.c, id, { comments: 'c'.repeat(2001) }), 'invalid_comments');
  for (const rating of [0, 6, null]) expectWord(await save(owner.c, id, { rating }), 'invalid_rating');
  for (const recommendation of ['maybe', 'Advance', null]) expectWord(await save(owner.c, id, { recommendation }), 'invalid_recommendation');
  expect(await row(id)).toMatchObject(NO_FEEDBACK);
  expectSaved(await save(owner.c, id, { comments: 'c'.repeat(2000) }), { replaced: false, completed: false });
});

testWithSupabase('3. a scheduled interview: refused without mark_completed, and with it marked completed and given its feedback in one write', async () => {
  const id = await scheduled(await applied('Feedback Three'));
  expectWord(await save(owner.c, id), 'not_completed');
  expectWord(await save(owner.c, id, { mark: false }), 'not_completed');
  expect(await row(id)).toMatchObject({ status: 'scheduled', ...NO_FEEDBACK });
  expectSaved(await save(owner.c, id, { mark: true, rating: 5, recommendation: 'hold' }), { replaced: false, completed: true });
  expect(await row(id)).toMatchObject({ status: 'completed', feedback_rating: 5, feedback_recommendation: 'hold' });
});

testWithSupabase('4. a cancelled interview and a no-show take no feedback, with or without mark_completed', async () => {
  const cancelled = await scheduled(await applied('Feedback Four A'), '14:15');
  expectWord(await owner.c.rpc('hire_cancel_interview', { p_interview_id: cancelled }), 'ok');
  const missed = await held(await applied('Feedback Four B'), 'no_show');
  for (const id of [cancelled, missed]) {
    expectWord(await save(owner.c, id), 'not_completed');
    expectWord(await save(owner.c, id, { mark: true }), 'not_completed');
    expect(await row(id)).toMatchObject(NO_FEEDBACK);
  }
  expect((await row(cancelled)).status).toBe('cancelled');
  expect((await row(missed)).status).toBe('no_show');
});

testWithSupabase('5. a second save is refused unless it says replace; a replacement overwrites all three values and says it replaced', async () => {
  const id = await completedInterview('Feedback Five');
  expectSaved(await save(owner.c, id, { rating: 3, recommendation: 'hold', comments: 'First.' }), { replaced: false, completed: false });
  const first = await row(id);
  expectWord(await save(owner.c, id, { rating: 5, recommendation: 'advance' }), 'has_feedback');
  expectWord(await save(owner.c, id, { rating: 5, recommendation: 'advance', replace: false }), 'has_feedback');
  expect(await row(id)).toEqual(first);
  expectSaved(await save(owner.c, id, { rating: 5, recommendation: 'advance', replace: true }), { replaced: true, completed: false });
  const second = await row(id);
  expect(second).toMatchObject({ feedback_rating: 5, feedback_recommendation: 'advance', feedback_comments: null });
  expect(Date.parse(second.feedback_at!)).toBeGreaterThan(Date.parse(first.feedback_at!));
  // Replace with nothing to replace is a first save, and says so.
  const fresh = await completedInterview('Feedback Five B');
  expectSaved(await save(owner.c, fresh, { replace: true }), { replaced: false, completed: false });
});

testWithSupabase('6. a save that names the version it saw saves nothing when that is no longer the stored one, even because it was cleared', async () => {
  const id = await completedInterview('Feedback Six');
  expectSaved(await save(owner.c, id, { rating: 3, recommendation: 'hold' }), { replaced: false, completed: false });
  const seen = (await row(id)).feedback_at!;
  // A colleague's edit lands first.
  expectSaved(await save(member, id, { rating: 4, recommendation: 'advance', replace: true, ifAt: seen }), { replaced: true, completed: false });
  const current = await row(id);
  expectWord(await save(owner.c, id, { rating: 1, recommendation: 'reject', replace: true, ifAt: seen }), 'changed');
  expect(await row(id)).toEqual(current);
  // The text exactly as it was read is the stored version: it saves.
  expectSaved(await save(owner.c, id, { rating: 2, recommendation: 'hold', replace: true, ifAt: current.feedback_at! }), { replaced: true, completed: false });
  // Cleared meanwhile: any version named is no longer the stored one.
  const stale = (await row(id)).feedback_at!;
  expectWord(await clear(member, id), 'ok');
  expectWord(await save(owner.c, id, { replace: true, ifAt: stale }), 'changed');
  expect(await row(id)).toMatchObject(NO_FEEDBACK);
});

testWithSupabase('7. clear: the four columns go and the interview stays completed; a second clear says there is none', async () => {
  const id = await completedInterview('Feedback Seven');
  expectSaved(await save(owner.c, id, { comments: 'To be cleared.' }), { replaced: false, completed: false });
  expectWord(await clear(owner.c, id), 'ok');
  expect(await row(id)).toMatchObject({ status: 'completed', ...NO_FEEDBACK });
  expectWord(await clear(owner.c, id), 'no_feedback');
});

testWithSupabase('8. an interview that has feedback is not marked as scheduled again until the feedback is cleared', async () => {
  const id = await completedInterview('Feedback Eight');
  expectSaved(await save(owner.c, id), { replaced: false, completed: false });
  const before = await row(id);
  expectWord(await reopen(owner.c, id), 'has_feedback');
  expect(await row(id)).toEqual(before);
  expectWord(await clear(owner.c, id), 'ok');
  expectWord(await reopen(owner.c, id), 'ok');
  expect(await row(id)).toMatchObject({ status: 'scheduled', ...NO_FEEDBACK });
});

testWithSupabase('9. a recommendation changes nothing but the interview: the application\'s stage, outcome and rating are as they were', async () => {
  const applicationId = await applied('Feedback Nine');
  expectWord(await owner.c.rpc('hire_rate_application', { p_application_id: applicationId, p_rating: 2 }), 'ok');
  const state = async () => (await owner.c.from('hire_applications').select('stage, outcome, rating').eq('id', applicationId).single()).data;
  const before = await state();
  expect(before).toEqual({ stage: 'applied', outcome: 'active', rating: 2 });
  const id = await held(applicationId);
  expectSaved(await save(owner.c, id, { rating: 1, recommendation: 'reject' }), { replaced: false, completed: false });
  expect(await state()).toEqual(before);
  expectSaved(await save(owner.c, id, { rating: 5, recommendation: 'advance', replace: true }), { replaced: true, completed: false });
  expect(await state()).toEqual(before);
});

testWithSupabase('10. feedback can be recorded on a completed interview of a rejected application', async () => {
  const applicationId = await applied('Feedback Ten');
  const id = await held(applicationId);
  expectWord(await owner.c.rpc('hire_close_application', { p_application_id: applicationId, p_outcome: 'rejected', p_reason: 'experience' }), 'ok');
  expectSaved(await save(owner.c, id, { rating: 2, recommendation: 'reject' }), { replaced: false, completed: false });
});

testWithSupabase('11. a member can save and clear; a viewer is told forbidden and can read; another workspace and a signed-out caller get nothing', async () => {
  const id = await completedInterview('Feedback Eleven');
  expectSaved(await save(member, id, { comments: 'By a member.' }), { replaced: false, completed: false });
  expectWord(await clear(member, id), 'ok');
  expectSaved(await save(owner.c, id, { comments: 'For the viewer to read.' }), { replaced: false, completed: false });
  const before = await row(id);
  expectWord(await save(viewerIn, id, { replace: true }), 'forbidden');
  expectWord(await clear(viewerIn, id), 'forbidden');
  expect(await read(viewerIn, id)).toEqual(before);
  expectWord(await save(other.c, id, { replace: true }), 'not_found');
  expectWord(await clear(other.c, id), 'not_found');
  expect(await read(other.c, id)).toBeNull();
  expectRefusedOutright(await save(visitor, id, { replace: true }), 'visitor save');
  expectRefusedOutright(await clear(visitor, id), 'visitor clear');
  expect(await row(id)).toEqual(before);
});

testWithSupabase('12. feedback cannot be written to the table directly, even by an owner', async () => {
  const id = await completedInterview('Feedback Twelve');
  const before = await row(id);
  const direct = await owner.c.from('hire_interviews').update({ feedback_rating: 5, feedback_recommendation: 'advance', feedback_at: new Date().toISOString() }).eq('id', id).select('id');
  // Refused outright, or no row matched for a caller with no update right: either way nothing changed.
  expect(direct.error !== null || (direct.data ?? []).length === 0).toBe(true);
  expect(await row(id)).toEqual(before);
});

testWithSupabase('13. after its application is deleted, both functions say the interview could not be found', async () => {
  const applicationId = await applied('Feedback Thirteen');
  const id = await held(applicationId);
  expectSaved(await save(owner.c, id), { replaced: false, completed: false });
  const removed = await owner.c.rpc('hire_delete_application', { p_application_id: applicationId });
  expect(removed.error, removed.error?.message).toBeNull();
  expect(await read(owner.c, id)).toBeNull();
  expectWord(await save(owner.c, id, { replace: true }), 'not_found');
  expectWord(await clear(owner.c, id), 'not_found');
});

testWithSupabase('14. two first saves sent together: every call answers with a word, exactly one is saved, the other is told it already has feedback', async () => {
  for (let round = 0; round < 3; round += 1) {
    const id = await completedInterview(`Feedback Fourteen ${round}`);
    const answers = await Promise.all([save(owner.c, id, { rating: 2, recommendation: 'hold' }), save(member, id, { rating: 5, recommendation: 'advance' })]);
    for (const answer of answers) expect(answer.error, answer.error?.message).toBeNull();
    expect(answers.map(wordOf).sort(), `round ${round}`).toEqual(['has_feedback', 'ok']);
    const winner = answers.findIndex((answer) => wordOf(answer) === 'ok');
    expect((await row(id)).feedback_rating).toBe(winner === 0 ? 2 : 5);
  }
});

testWithSupabase('15. an interview recorded as already held takes feedback when it was completed, and none when it was a no-show', async () => {
  const done = await held(await applied('Feedback Fifteen A'), 'completed', 200);
  expectSaved(await save(owner.c, done), { replaced: false, completed: false });
  const missed = await held(await applied('Feedback Fifteen B'), 'no_show', 200);
  expectWord(await save(owner.c, missed), 'not_completed');
});

testWithSupabase('16. mark_completed for an interview a colleague already completed: saved, and the answer says it did not complete it', async () => {
  const id = await scheduled(await applied('Feedback Sixteen'), '14:15');
  expectWord(await member.rpc('hire_set_interview_outcome', { p_interview_id: id, p_outcome: 'completed' }), 'ok');
  expectSaved(await save(owner.c, id, { mark: true }), { replaced: false, completed: false });
  expect((await row(id)).status).toBe('completed');
});

testWithSupabase('17. the app\'s own reads return the feedback: the list, and the read behind every Approve card', async () => {
  const id = await completedInterview('Feedback Seventeen');
  expectSaved(await save(owner.c, id, { rating: 3, recommendation: 'hold', comments: 'Read back through the app.' }), { replaced: false, completed: false });
  const stored = await row(id);
  const data = createSupabaseHireData(owner.c, owner.orgId);
  const listed = (await data.listInterviews()).find((i) => i.id === id);
  // The saved time is the text exactly as stored: an edit form sends it back as the version it saw.
  expect(listed?.feedback).toEqual({ rating: 3, recommendation: 'hold', comments: 'Read back through the app.', recorded_at: stored.feedback_at });
  const card = await data.interviewCard!(id);
  expect(card.target).toMatchObject({ id, status: 'completed', feedback: { rating: 3, recommendation: 'hold', recorded_at: stored.feedback_at } });
  expect(JSON.stringify(card)).not.toContain('Read back through the app.');
  // An interview without feedback has no such key in either read.
  const bare = await completedInterview('Feedback Seventeen B');
  expect(Object.keys((await data.listInterviews()).find((i) => i.id === bare)!)).not.toContain('feedback');
  expect(Object.keys((await data.interviewCard!(bare)).target!)).not.toContain('feedback');
});
