// tests/hire-application-changes.rls.test.ts
//
// Live checks of the four functions that move, close, reopen and rate a job application (Lekir slice 3a):
// public.hire_move_application, hire_close_application, hire_reopen_application and hire_rate_application.
// Needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY; without both every case is skipped.
// WRITTEN, NOT YET RUN: it runs only after the migration 20261023090000_hire_application_changes.sql is applied.
//
// Who calls what. The functions are granted to `authenticated` only, so the service client cannot call them
// (it has no user). Every call here is made by a signed-in client (the owner, the owner of another
// workspace, a demo viewer) or by the signed-out visitor client, which must be refused outright.
//
// The viewer case. A viewer made the way the other live files make one (joining the demo workspace) is not a
// member of a throwaway workspace, so on the OWNER's application that viewer is a stranger and the right word is
// `not_found`. The word `forbidden` is only true for a viewer who is a member of the application's workspace,
// and no helper can make a viewer of a throwaway workspace. So `forbidden` is tested against an application of
// the DEMO workspace (seeded, read by the demo viewer's own select): the word is asserted and the row is
// read again to be unchanged. The same viewer against the owner's application is asserted `not_found`.
//
// Applications to act on. A member cannot create an application, so each is made by the visitor through
// `submit_public_application` (the careers board of the owner's workspace is on) with a fresh address, then
// looked up by the owner. Fewer than 15 are made on one job, well under the 30 a minute the function accepts.
// Nothing here uploads to storage.
//
// What stays behind. Every candidate, application, notification and rate-limit tick this file creates cannot be
// removed by a user, so they go with the two throwaway workspaces when the shared live-workspaces helper deletes
// them (and the anonymous users) at the end. The demo workspace is only ever read and refused: no row of it is
// changed. If the helper cannot clean up (missing service key or migration), the helper logs what it left; a
// beforeCleanup step here switches the careers boards off first so a leaked workspace has no public page.
import { beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { createAnonymousClient } from '@/lib/supabase/anonymous';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, liveClient, signInAnon, beforeCleanup } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const client = liveClient;

const PREFIX = 'RLS change job';
const ALL_OFF = { require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false };
const RUN = Date.now();
const NAME = 'Aina Rahman';
const SELECT = 'id, stage, outcome, rating, reject_reason, offered_at, hired_at';

let emailCounter = 0;
/** A lowercase address that no earlier run can have used. */
const uniqueEmail = () => `rls-change-${RUN}-${++emailCounter}@example.com`;

async function ownedOrg(name: string) {
  const c = client();
  const { error: e1 } = await signInAnon(c);
  expect(e1, e1?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, name);
  expect(error, error?.message).toBeNull();
  return { c, orgId: orgId as string };
}

type Owned = Awaited<ReturnType<typeof ownedOrg>>;

type Row = {
  id: string;
  stage: string;
  outcome: string;
  rating: number | null;
  reject_reason: string | null;
  offered_at: string | null;
  hired_at: string | null;
};

let owner: Owned;
let other: Owned;
let viewer: SupabaseClient; // a viewer of the DEMO workspace
let visitor: SupabaseClient; // no session
let demoApplicationId: string;
let demoBefore: Row;

let job: { id: string; title: string };

async function switchBoardOn(who: Owned) {
  const res = await who.c
    .from('hire_settings')
    .insert({ org_id: who.orgId, careers_enabled: true })
    .select('org_id, careers_enabled')
    .single();
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data!.careers_enabled).toBe(true);
}

/** Reads one application with the given client; the row must be visible to them. */
async function readRow(c: SupabaseClient, id: string): Promise<Row> {
  const res = await c.from('hire_applications').select(SELECT).eq('id', id).single();
  expect(res.error, res.error?.message).toBeNull();
  return res.data as Row;
}

/** A fresh application on the job, made the way a real applicant makes one, then found by the owner. */
async function newApplication(): Promise<string> {
  const email = uniqueEmail();
  const sent = await visitor.rpc('submit_public_application', {
    p_org_id: owner.orgId,
    p_job_id: job.id,
    p_name: NAME,
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
  const cand = await owner.c.from('hire_candidates').select('id').eq('org_id', owner.orgId).eq('email', email);
  expect(cand.error, cand.error?.message).toBeNull();
  expect(cand.data).toHaveLength(1);
  const app = await owner.c.from('hire_applications').select('id').eq('candidate_id', cand.data![0].id);
  expect(app.error, app.error?.message).toBeNull();
  expect(app.data).toHaveLength(1);
  return app.data![0].id as string;
}

type Res = { data: unknown; error: { message: string; code?: string } | null };

const move = (c: SupabaseClient, id: string, stage: string) =>
  c.rpc('hire_move_application', { p_application_id: id, p_stage: stage });
const close = (c: SupabaseClient, id: string, outcome: string, reason: string | null = null) =>
  c.rpc('hire_close_application', { p_application_id: id, p_outcome: outcome, p_reason: reason });
const reopen = (c: SupabaseClient, id: string) => c.rpc('hire_reopen_application', { p_application_id: id });
const rate = (c: SupabaseClient, id: string, rating: number | null) =>
  c.rpc('hire_rate_application', { p_application_id: id, p_rating: rating });

/** The function must answer with exactly this word and no error: an error for another reason cannot pass. */
function expectWord(res: Res, word: string) {
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data).toBe(word);
}

/**
 * A signed-out caller is refused by the database before the function runs: the permission error
 * (42501, execute is not granted), and no answer. Any other error would be a different failure.
 */
function expectRefusedOutright(res: Res, label: string) {
  expect(res.error, `${label}: expected a permission error`).not.toBeNull();
  expect(res.error?.code, `${label}: ${res.error?.message}`).toBe('42501');
  expect(res.data ?? null, `${label}: no answer`).toBeNull();
}

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  owner = await ownedOrg('Hire Change Owner Sdn Bhd');
  other = await ownedOrg('Hire Change Other Sdn Bhd');
  viewer = client();
  await signInAnon(viewer);
  const joined = await joinDemo(viewer);
  expect(joined.error, joined.error?.message).toBeNull();
  visitor = createAnonymousClient();

  await switchBoardOn(owner);
  const set = await owner.c.from('hire_settings').update(ALL_OFF).eq('org_id', owner.orgId).select('org_id').single();
  expect(set.error, set.error?.message).toBeNull();

  const ins = await owner.c
    .from('hire_jobs')
    .insert({
      org_id: owner.orgId,
      title: `${PREFIX} open`,
      status: 'open',
      description: 'A real description of the role.',
      opened_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  expect(ins.error, ins.error?.message).toBeNull();
  job = { id: (ins.data as { id: string }).id, title: `${PREFIX} open` };

  // One seeded application of the demo workspace, found by the demo viewer's own select.
  const demo = await viewer.from('hire_applications').select(SELECT).limit(1);
  expect(demo.error, demo.error?.message).toBeNull();
  expect(demo.data?.length, 'the demo workspace should hold a seeded application').toBeGreaterThan(0);
  demoBefore = demo.data![0] as Row;
  demoApplicationId = demoBefore.id;
}, 120_000);

beforeCleanup(async () => {
  if (!hasSupabaseEnv) return;
  for (const who of [owner, other]) {
    if (!who) continue;
    await who.c.from('hire_settings').update({ careers_enabled: false }).eq('org_id', who.orgId);
  }
});

// The cases run in file order: later ones may read what earlier ones wrote (each uses its own application).

testWithSupabase('1. a visitor, another workspace and a viewer are refused by all four functions and nothing changes', async () => {
  const id = await newApplication();
  const before = await readRow(owner.c, id);

  const calls: Array<[string, (c: SupabaseClient, appId: string) => PromiseLike<Res>]> = [
    ['move', (c, a) => move(c, a, 'interview')],
    ['close', (c, a) => close(c, a, 'rejected', 'skills')],
    ['reopen', (c, a) => reopen(c, a)],
    ['rate', (c, a) => rate(c, a, 3)],
  ];

  for (const [name, call] of calls) {
    // Signed out: refused outright (execute is not granted to anon).
    expectRefusedOutright(await call(visitor, id), `visitor ${name}`);
    // The owner of another workspace is no member here: the id reads as missing.
    expectWord(await call(other.c, id), 'not_found');
    // A viewer of the demo workspace is no member here either.
    expectWord(await call(viewer, id), 'not_found');
    expect(await readRow(owner.c, id), `after ${name} by outsiders`).toEqual(before);
  }

  // A viewer who IS a member of the application's workspace: forbidden, and the row stays as it was.
  const demoCalls: Array<[string, (c: SupabaseClient, appId: string) => PromiseLike<Res>]> = [
    ['move', (c, a) => move(c, a, 'screening')],
    ['close', (c, a) => close(c, a, 'rejected', 'skills')],
    ['reopen', (c, a) => reopen(c, a)],
    ['rate', (c, a) => rate(c, a, 3)],
  ];
  for (const [name, call] of demoCalls) {
    expectWord(await call(viewer, demoApplicationId), 'forbidden');
    expect(await readRow(viewer, demoApplicationId), `demo row after viewer ${name}`).toEqual(demoBefore);
  }
  // An unknown id is the same word as another workspace's id.
  expectWord(await move(owner.c, '00000000-0000-4000-8000-000000000000', 'interview'), 'not_found');
}, 120_000);

testWithSupabase('2. a direct update of stage, outcome, rating or reject_reason is refused for the owner too', async () => {
  const id = await newApplication();
  const before = await readRow(owner.c, id);
  const attempts: Array<Record<string, unknown>> = [
    { stage: 'hired' },
    { outcome: 'rejected' },
    { rating: 5 },
    { reject_reason: 'skills' },
  ];
  for (const fields of attempts) {
    const res = await owner.c.from('hire_applications').update(fields).eq('id', id).select('id');
    // No UPDATE grant: PostgREST answers with an error (42501). If a policy alone stopped it, no row comes back.
    // Either way nothing may have been written.
    expect(Boolean(res.error) || (res.data ?? []).length === 0, `update ${Object.keys(fields)[0]} refused`).toBe(true);
    expect(await readRow(owner.c, id), `after update ${Object.keys(fields)[0]}`).toEqual(before);
  }
}, 60_000);

testWithSupabase('3. the owner moves an application and the offer and hire dates follow the stage', async () => {
  const id = await newApplication();

  expectWord(await move(owner.c, id, 'interview'), 'ok');
  let row = await readRow(owner.c, id);
  expect(row).toMatchObject({ stage: 'interview', offered_at: null, hired_at: null });

  expectWord(await move(owner.c, id, 'hired'), 'ok');
  row = await readRow(owner.c, id);
  expect(row.stage).toBe('hired');
  expect(row.offered_at).not.toBeNull();
  expect(row.hired_at).not.toBeNull();
  const offeredAt = row.offered_at;

  // Back to offer: the hire date goes, the offer date stays as it was.
  expectWord(await move(owner.c, id, 'offer'), 'ok');
  row = await readRow(owner.c, id);
  expect(row.stage).toBe('offer');
  expect(row.hired_at).toBeNull();
  expect(row.offered_at).toBe(offeredAt);

  // Back to interview: the offer date goes too.
  expectWord(await move(owner.c, id, 'interview'), 'ok');
  row = await readRow(owner.c, id);
  expect(row).toMatchObject({ stage: 'interview', offered_at: null, hired_at: null });

  // Refusals leave the row exactly as it was.
  const held = await readRow(owner.c, id);
  expectWord(await move(owner.c, id, 'applied'), 'too_far_back'); // two back from interview
  expectWord(await move(owner.c, id, 'interview'), 'same_stage');
  expectWord(await move(owner.c, id, 'bogus'), 'invalid_stage');
  expect(await readRow(owner.c, id)).toEqual(held);
}, 60_000);

testWithSupabase('3b. a hired application marked withdrawn keeps its hire date, and reopens as hired', async () => {
  const id = await newApplication();
  expectWord(await move(owner.c, id, 'hired'), 'ok');
  const hired = await readRow(owner.c, id);
  expect(hired.stage).toBe('hired');
  expect(hired.hired_at).not.toBeNull();

  // The person pulled out after being hired: the hire happened, so its date stays.
  expectWord(await close(owner.c, id, 'withdrawn'), 'ok');
  const withdrawn = await readRow(owner.c, id);
  expect(withdrawn).toMatchObject({ stage: 'hired', outcome: 'withdrawn' });
  expect(withdrawn.hired_at).toBe(hired.hired_at);
  expect(withdrawn.offered_at).toBe(hired.offered_at);

  expectWord(await reopen(owner.c, id), 'ok');
  const reopened = await readRow(owner.c, id);
  expect(reopened).toMatchObject({ stage: 'hired', outcome: 'active', reject_reason: null });
  expect(reopened.hired_at).toBe(hired.hired_at);
  expect(reopened.offered_at).toBe(hired.offered_at);
}, 60_000);

let closedId: string; // left rejected at the offer stage for case 5

testWithSupabase('4. the owner closes an application with a reason, and a closed one cannot be closed or moved', async () => {
  const id = await newApplication();
  expectWord(await move(owner.c, id, 'offer'), 'ok');
  const atOffer = await readRow(owner.c, id);

  expectWord(await close(owner.c, id, 'rejected', 'experience'), 'ok');
  const closed = await readRow(owner.c, id);
  expect(closed).toMatchObject({ outcome: 'rejected', reject_reason: 'experience' });
  // The stage and the dates stay as they were.
  expect({ stage: closed.stage, offered_at: closed.offered_at, hired_at: closed.hired_at }).toEqual({
    stage: atOffer.stage,
    offered_at: atOffer.offered_at,
    hired_at: atOffer.hired_at,
  });

  expectWord(await close(owner.c, id, 'withdrawn', 'other'), 'not_active');
  expectWord(await move(owner.c, id, 'hired'), 'not_active');
  expect(await readRow(owner.c, id)).toEqual(closed);
  closedId = id;

  // An unknown reason and an unknown outcome are refused and change nothing.
  const live = await newApplication();
  const liveBefore = await readRow(owner.c, live);
  expectWord(await close(owner.c, live, 'rejected', 'age'), 'invalid_reason');
  expectWord(await close(owner.c, live, 'hired'), 'invalid_outcome');
  expectWord(await close(owner.c, live, 'active'), 'invalid_outcome');
  expect(await readRow(owner.c, live)).toEqual(liveBefore);

  // A withdrawal with no reason is allowed, and stores a null reason.
  expectWord(await close(owner.c, live, 'withdrawn'), 'ok');
  expect(await readRow(owner.c, live)).toMatchObject({ outcome: 'withdrawn', reject_reason: null });
}, 90_000);

testWithSupabase('5. the owner reopens: active again, reason cleared, stage and dates kept; a live one is not closed', async () => {
  const closedBefore = await readRow(owner.c, closedId);
  expect(closedBefore.outcome).toBe('rejected');

  expectWord(await reopen(owner.c, closedId), 'ok');
  const reopened = await readRow(owner.c, closedId);
  expect(reopened).toMatchObject({ outcome: 'active', reject_reason: null });
  expect(reopened.stage).toBe(closedBefore.stage);
  expect(reopened.offered_at).toBe(closedBefore.offered_at);

  expectWord(await reopen(owner.c, closedId), 'not_closed');
  expect(await readRow(owner.c, closedId)).toEqual(reopened);

  // After forward, reject, reopen, the move back by one still clears the offer date: stage and dates agree.
  expectWord(await move(owner.c, closedId, 'interview'), 'ok');
  expect(await readRow(owner.c, closedId)).toMatchObject({ stage: 'interview', offered_at: null, hired_at: null });
}, 60_000);

testWithSupabase('6. the owner rates 1 to 5 or clears the rating; 0 and 6 are refused; a rejected application can be rated', async () => {
  const id = await newApplication();

  expectWord(await rate(owner.c, id, 4), 'ok');
  expect((await readRow(owner.c, id)).rating).toBe(4);

  expectWord(await rate(owner.c, id, 0), 'invalid_rating');
  expectWord(await rate(owner.c, id, 6), 'invalid_rating');
  expect((await readRow(owner.c, id)).rating).toBe(4);

  expectWord(await rate(owner.c, id, null), 'ok');
  expect((await readRow(owner.c, id)).rating).toBeNull();

  expectWord(await close(owner.c, id, 'rejected', 'salary'), 'ok');
  expectWord(await rate(owner.c, id, 2), 'ok');
  expect(await readRow(owner.c, id)).toMatchObject({ outcome: 'rejected', rating: 2 });
}, 60_000);

// Case 7 sends two calls at once. The row lock makes them take turns, so the second sees what the first did.
//
// The pairs are chosen so that every legal order gives the same answers (an ambiguous pair, such as
// interview -> offer together with interview -> screening, can end two different ways and would make the
// test guess):
//   7a. two moves to the SAME stage, from interview: whichever goes first is `ok`, the other finds the
//       application already there and is `same_stage`. Exactly one `ok`; the final row is hired with both dates.
//   7b. two closes with different outcomes: whichever goes first is `ok`, the other is `not_active`. Exactly
//       one `ok`; the final row carries the winner's outcome and reason, never a mix of the two.
testWithSupabase('7. two changes sent at once take turns: one answers ok and the other the refusal that then applies', async () => {
  const a = await newApplication();
  expectWord(await move(owner.c, a, 'interview'), 'ok');
  const answers = (await Promise.all([move(owner.c, a, 'hired'), move(owner.c, a, 'hired')])) as Res[];
  for (const r of answers) expect(r.error, r.error?.message).toBeNull();
  expect(answers.map((r) => r.data).sort()).toEqual(['ok', 'same_stage']);
  const rowA = await readRow(owner.c, a);
  expect(rowA.stage).toBe('hired');
  expect(rowA.offered_at).not.toBeNull();
  expect(rowA.hired_at).not.toBeNull();

  const b = await newApplication();
  const closes = (await Promise.all([
    close(owner.c, b, 'rejected', 'skills'),
    close(owner.c, b, 'withdrawn', 'other'),
  ])) as Res[];
  for (const r of closes) expect(r.error, r.error?.message).toBeNull();
  expect(closes.map((r) => r.data).sort()).toEqual(['not_active', 'ok']);
  const winner =
    closes[0].data === 'ok'
      ? { outcome: 'rejected', reject_reason: 'skills' }
      : { outcome: 'withdrawn', reject_reason: 'other' };
  expect(await readRow(owner.c, b)).toMatchObject(winner);
}, 90_000);

testWithSupabase('8. no application in the owner\'s workspace holds a reason while it is active', async () => {
  // Read as the owner (a member sees every row of the workspace); the service client is not needed.
  const active = await owner.c
    .from('hire_applications')
    .select('id')
    .eq('org_id', owner.orgId)
    .eq('outcome', 'active')
    .not('reject_reason', 'is', null);
  expect(active.error, active.error?.message).toBeNull();
  expect(active.data ?? []).toHaveLength(0);

  // And the check is not vacuous: closed applications with a reason exist.
  const closedWithReason = await owner.c
    .from('hire_applications')
    .select('id')
    .eq('org_id', owner.orgId)
    .neq('outcome', 'active')
    .not('reject_reason', 'is', null);
  expect(closedWithReason.error, closedWithReason.error?.message).toBeNull();
  expect((closedWithReason.data ?? []).length).toBeGreaterThan(0);
}, 30_000);
