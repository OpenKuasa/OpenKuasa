// tests/hire-feedback-version.rls.test.ts
//
// Live checks of 20261125090100_hire_feedback_version.sql: hire_clear_interview_feedback takes the version the caller
// saw (p_if_feedback_at) and refuses with 'changed' when the stored feedback is another; a call with the interview's
// id alone still works. Also the save rule the assistant leans on when it saw no feedback: a save that does not say
// "replace" is refused once a colleague has added feedback. Needs NEXT_PUBLIC_SUPABASE_URL,
// NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY; without all three every case is skipped.
// WRITTEN, NOT YET RUN: it fails until 20261125090100_hire_feedback_version.sql is applied.
//
// Every call is made by a signed-in client or by the signed-out visitor; the service key never calls a function.
// Every row made here goes with the throwaway workspaces when the shared helper deletes them.
import { randomBytes } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAnonymousClient } from '@/lib/supabase/anonymous';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';

const hasService = hasSupabaseEnv && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const testWithSupabase = hasService ? test : test.skip;
if (!hasService) {
  console.warn(hasSupabaseEnv ? 'Set SUPABASE_SERVICE_ROLE_KEY in .env.local to run the feedback version checks' : supabaseEnvSkipReason);
}

const RUN = Date.now();
type Res = { data: unknown; error: { message: string; code?: string } | null };
type Row = { feedback_rating: number | null; feedback_recommendation: string | null; feedback_comments: string | null; feedback_at: string | null };
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
let emailCounter = 0;
const uniqueEmail = () => `rls-feedback-version-${RUN}-${++emailCounter}@example.com`;

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

function wordOf(res: Res): string | null {
  if (res.error) return null;
  const got = res.data && typeof res.data === 'object' ? (res.data as { word?: unknown }).word : res.data;
  return typeof got === 'string' ? got : null;
}
function expectWord(res: Res, word: string) {
  expect(res.error, res.error?.message).toBeNull();
  expect(wordOf(res)).toBe(word);
}

/** A completed interview of a new person, with feedback saved by the owner. Returns its id and the saved time. */
async function withFeedback(name: string): Promise<{ id: string; at: string }> {
  const added = await owner.c.rpc('hire_add_candidate', {
    p_org_id: owner.orgId, p_name: name, p_email: uniqueEmail(), p_phone: null, p_headline: null, p_location: null, p_skills: null, p_source: null,
    p_job_id: job.id, p_cover_letter: null, p_cv_url: null,
  });
  expectWord(added, 'ok');
  const past = await owner.c.rpc('hire_record_past_interview', {
    p_application_id: (added.data as { application_id: string }).application_id, p_scheduled_at: ago(90), p_duration_minutes: 60, p_kind: 'video',
    p_outcome: 'completed', p_place: null, p_interviewer_name: null, p_notes: null,
  });
  expectWord(past, 'ok');
  const id = (past.data as { id: string }).id;
  expectWord(await save(owner.c, id, {}), 'ok');
  return { id, at: (await row(id)).feedback_at! };
}

type Save = { rating?: number; replace?: boolean; ifAt?: string };
const save = (c: SupabaseClient, id: string, f: Save) =>
  c.rpc('hire_save_interview_feedback', {
    p_interview_id: id, p_rating: f.rating ?? 4, p_recommendation: 'advance', p_comments: null,
    ...(f.replace === undefined ? {} : { p_replace: f.replace }),
    ...(f.ifAt === undefined ? {} : { p_if_feedback_at: f.ifAt }),
  });
const clear = (c: SupabaseClient, id: string, ifAt?: string) =>
  c.rpc('hire_clear_interview_feedback', { p_interview_id: id, ...(ifAt === undefined ? {} : { p_if_feedback_at: ifAt }) });

async function row(id: string): Promise<Row> {
  const res = await owner.c.from('hire_interviews').select('feedback_rating, feedback_recommendation, feedback_comments, feedback_at').eq('id', id).maybeSingle();
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data, `interview ${id} should exist`).not.toBeNull();
  return res.data as Row;
}

beforeAll(async () => {
  if (!hasService) return;
  owner = await ownedOrg('Hire Feedback Version Owner Sdn Bhd');
  other = await ownedOrg('Hire Feedback Version Other Sdn Bhd');
  member = await invited('member');
  viewerIn = await invited('viewer');
  visitor = createAnonymousClient();
  const made = await owner.c.from('hire_jobs')
    .insert({ org_id: owner.orgId, title: `RLS feedback version job ${RUN}`, status: 'open', description: 'A real description of the role.', opened_at: new Date().toISOString() })
    .select('id').single();
  expect(made.error, made.error?.message).toBeNull();
  job = made.data as { id: string };
}, 180_000);

testWithSupabase('1. a clear that sends the version it saw clears the feedback', async () => {
  const { id, at } = await withFeedback('Version One');
  expectWord(await clear(member, id, at), 'ok');
  expect((await row(id)).feedback_at).toBeNull();
});

testWithSupabase('2. a colleague saved again after the version was read: the clear is refused and the newer feedback stays', async () => {
  const { id, at } = await withFeedback('Version Two');
  expectWord(await save(member, id, { rating: 2, replace: true, ifAt: at }), 'ok');
  const newer = await row(id);
  expect(newer.feedback_at).not.toBe(at);
  expectWord(await clear(owner.c, id, at), 'changed');
  expect(await row(id)).toEqual(newer);
});

testWithSupabase('3. the feedback was already cleared: no_feedback, not changed', async () => {
  const { id, at } = await withFeedback('Version Three');
  expectWord(await clear(member, id), 'ok');
  expectWord(await clear(owner.c, id, at), 'no_feedback');
});

testWithSupabase('4. a call with the id alone works as before (the one-argument function is gone, not ambiguous)', async () => {
  const { id } = await withFeedback('Version Four');
  expectWord(await clear(owner.c, id), 'ok');
  expect((await row(id)).feedback_at).toBeNull();
});

testWithSupabase('5. who may call: a viewer is forbidden, another workspace reads it as missing, a visitor is refused outright', async () => {
  const { id, at } = await withFeedback('Version Five');
  expectWord(await clear(viewerIn, id, at), 'forbidden');
  expectWord(await clear(other.c, id, at), 'not_found');
  const res = await clear(visitor, id, at);
  expect(res.error?.code, res.error?.message).toBe('42501');
  expect((await row(id)).feedback_at).toBe(at);
});

testWithSupabase('6. a save that saw no feedback (no version, no replace) is refused once a colleague added some', async () => {
  const { id, at } = await withFeedback('Version Six');
  // The colleague's feedback is there; a save prepared when there was none says neither replace nor a version.
  expectWord(await save(owner.c, id, { rating: 1 }), 'has_feedback');
  expect((await row(id)).feedback_at).toBe(at);
});
