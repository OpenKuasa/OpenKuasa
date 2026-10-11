/**
 * Live test of the goal, review, training and announcement write paths against the real database. It needs the
 * three 202610280900xx migrations applied; until then it fails at the first call (the functions do not exist).
 * Skipped without Supabase env vars. First run: Task 6 of the L6a plan, after the owner's go-ahead.
 *
 * A fresh workspace with an owner and a confirmed member (linked to one employee record) and a colleague with
 * another. A member's own goal round trip, and a colleague's goal refused; a draft review invisible to the person
 * it is about, visible once released and invisible again after it is pulled back; courses with real dates around
 * today for self-enrol, withdraw and the admin's completion; an announcement that is invisible as a draft, unread
 * for the member only once published, read once marked, with the owner's count unaffected; every owner-only write
 * refused to the member with its sentence; the demo guest changes nothing.
 *
 * Workspaces and users come from tests/helpers/live-workspaces.ts, which also removes them. Every sentence comes
 * from PERFORMANCE_REFUSALS, never a literal. No score is worked out here.
 *
 * The demo part is skipped in minutes :00 to :02 of every hour (UTC), while the demo is re-seeded.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import {
  deleteAnnouncement,
  markAnnouncementsRead,
  publishAnnouncement,
  saveAnnouncement,
  unpublishAnnouncement,
  unreadAnnouncements,
} from '@/lib/people/announcement-writes';
import { createEmployee, linkEmployeeToMember } from '@/lib/people/capabilities';
import { addDays, todayInMalaysia } from '@/lib/people/dates';
import {
  PERFORMANCE_REFUSALS,
  deleteGoal,
  deleteReview,
  deleteTraining,
  enrol,
  releaseReview,
  saveGoal,
  saveReview,
  saveTraining,
  setTrainingCompleted,
  unenrol,
  unreleaseReview,
} from '@/lib/people/performance-writes';
import { createSupabasePeopleData } from '@/lib/people/supabase';
import { DEMO_EMPLOYEE_ID } from '@/lib/people/types';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, joinDemo, liveClient, signInAnon } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const client = liveClient;

const PASSWORD = 'performance-live-pass-123';
const SCORES = { Delivery: 4, Teamwork: 3.5, Ownership: 5, Communication: 2 };
const TODAY = todayInMalaysia(new Date());

const PERF_NOT_ALLOWED = { ok: false, error: PERFORMANCE_REFUSALS.PERF_NOT_ALLOWED };
const PERF_NOT_FOUND = { ok: false, error: PERFORMANCE_REFUSALS.PERF_NOT_FOUND };
const ANN_NOT_ALLOWED = { ok: false, error: PERFORMANCE_REFUSALS.ANN_NOT_ALLOWED };
const ANN_NOT_FOUND = { ok: false, error: PERFORMANCE_REFUSALS.ANN_NOT_FOUND };

let owner: { c: SupabaseClient; orgId: string };
let member: { c: SupabaseClient; userId: string };
// Signed in inside the demo test, after its minute guard: the demo is not joined at any other time.
let guest: { c: SupabaseClient; demoId: string } | undefined;

// Filled in by the first test, used by the rest.
const mine = { employeeId: '' };
const colleague = { employeeId: '' };

const ownerCtx = () => ({ client: owner.c, orgId: owner.orgId });
const memberCtx = () => ({ client: member.c, orgId: owner.orgId });
const ownerData = () => createSupabasePeopleData(owner.c, owner.orgId);
const memberData = () => createSupabasePeopleData(member.c, owner.orgId);

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const c = client();
  expect((await signInAnon(c)).error).toBeNull();
  const org = await createOrg(c, 'People Performance Sdn Bhd');
  expect(org.error, org.error?.message).toBeNull();
  owner = { c, orgId: org.data as string };

  // A member needs an address to accept an invite sent to it. The user is created already confirmed (a plain
  // sign-up returns no session while the project requires email confirmation) and signed in at once.
  const m = client();
  const signUp = await createConfirmedTestUser(m, PASSWORD);
  const invite = await owner.c.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  member = { c: m, userId: signUp.userId as string };
});
afterAll(async () => {
  await owner?.c.auth.signOut();
  await member?.c.auth.signOut();
  await guest?.c.auth.signOut();
});

testWithSupabase('a member keeps their own goals, and cannot touch a colleague\'s', async () => {
  const a = await createEmployee(ownerCtx(), { name: 'Farah Idris', join_date: '2025-01-06' });
  const b = await createEmployee(ownerCtx(), { name: 'Hakim Rosli', join_date: '2025-01-06' });
  expect(a.ok && b.ok, JSON.stringify([a, b])).toBe(true);
  if (!a.ok || !b.ok) return;
  mine.employeeId = a.data.id;
  colleague.employeeId = b.data.id;
  expect((await linkEmployeeToMember(ownerCtx(), { id: a.data.id, user_id: member.userId })).ok).toBe(true);

  // Add, change (status follows progress), read back through the provider, remove.
  const added = await saveGoal(memberCtx(), { employee_id: mine.employeeId, title: 'Ship the thing', progress: 40, due_date: '2030-12-01' });
  expect(added.ok, JSON.stringify(added)).toBe(true);
  if (!added.ok) return;
  expect(added.data).toMatchObject({ title: 'Ship the thing', progress: 40, due_date: '2030-12-01', status: 'on_track' });
  const risky = await saveGoal(memberCtx(), { employee_id: mine.employeeId, goal_id: added.data.id, title: 'Ship the thing', progress: 40, at_risk: true });
  expect(risky).toMatchObject({ ok: true, data: { status: 'at_risk', due_date: null } });
  const done = await saveGoal(memberCtx(), { employee_id: mine.employeeId, goal_id: added.data.id, title: 'Ship the thing', progress: 100, at_risk: true });
  expect(done).toMatchObject({ ok: true, data: { status: 'done' } });
  expect((await memberData().listGoals()).map((g) => g.id)).toEqual([added.data.id]);

  // A colleague's goal: the member can neither add one for them nor change or remove one that exists.
  expect(await saveGoal(memberCtx(), { employee_id: colleague.employeeId, title: 'Not mine', progress: 1 })).toEqual(PERF_NOT_FOUND);
  const theirs = await saveGoal(ownerCtx(), { employee_id: colleague.employeeId, title: 'Hakim\'s goal', progress: 10 });
  expect(theirs.ok, JSON.stringify(theirs)).toBe(true);
  if (!theirs.ok) return;
  expect(await saveGoal(memberCtx(), { employee_id: mine.employeeId, goal_id: theirs.data.id, title: 'Taken', progress: 1 })).toEqual(PERF_NOT_FOUND);
  expect(await deleteGoal(memberCtx(), { goal_id: theirs.data.id })).toEqual(PERF_NOT_FOUND);
  expect((await memberData().listGoals()).some((g) => g.id === theirs.data.id)).toBe(false);

  expect(await deleteGoal(memberCtx(), { goal_id: added.data.id })).toEqual({
    ok: true,
    data: { id: added.data.id, employee_id: mine.employeeId },
  });
  // An owner removes anyone's.
  expect((await deleteGoal(ownerCtx(), { goal_id: theirs.data.id })).ok).toBe(true);
});

testWithSupabase('a draft review is invisible to the person it is about, visible once released, invisible again once pulled back', async () => {
  const saved = await saveReview(ownerCtx(), {
    employee_id: mine.employeeId, period: 'H1 2026', competencies: SCORES, rating: 'meets', comment: 'Solid half.',
  });
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
  if (!saved.ok) return;
  const id = saved.data.id;
  expect(saved.data).toMatchObject({ status: 'draft', released_at: null, comment: 'Solid half.', competencies: SCORES });

  // The owner reads it; the member reads nothing of it, not a row.
  expect((await ownerData().listReviews()).find((r) => r.id === id)).toMatchObject({ status: 'draft', employee_name: 'Farah Idris' });
  expect(await memberData().listReviews()).toEqual([]);
  // The member cannot release it, and is not told it exists.
  expect(await releaseReview(memberCtx(), { review_id: id })).toEqual(PERF_NOT_FOUND);

  // Another review for the same period is refused.
  expect(
    await saveReview(ownerCtx(), { employee_id: mine.employeeId, period: 'H1 2026', competencies: SCORES, rating: 'below' }),
  ).toEqual({ ok: false, error: PERFORMANCE_REFUSALS.PERF_REVIEW_EXISTS });

  const released = await releaseReview(ownerCtx(), { review_id: id });
  expect(released).toMatchObject({ ok: true, data: { status: 'released' } });
  expect(released.ok && released.data.released_at).toBeTruthy();
  const seen = await memberData().listReviews();
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ id, status: 'released', comment: 'Solid half.', competencies: SCORES });

  // A released review cannot be changed or deleted until it is pulled back.
  expect(
    await saveReview(ownerCtx(), { employee_id: mine.employeeId, review_id: id, period: 'H1 2026', competencies: SCORES, rating: 'meets' }),
  ).toEqual({ ok: false, error: PERFORMANCE_REFUSALS.PERF_NOT_DRAFT });
  expect(await deleteReview(ownerCtx(), { review_id: id })).toEqual({ ok: false, error: PERFORMANCE_REFUSALS.PERF_NOT_DRAFT });

  expect(await unreleaseReview(memberCtx(), { review_id: id })).toEqual(PERF_NOT_FOUND);
  expect(await unreleaseReview(ownerCtx(), { review_id: id })).toMatchObject({ ok: true, data: { status: 'draft', released_at: null } });
  expect(await memberData().listReviews()).toEqual([]);

  expect(await deleteReview(ownerCtx(), { review_id: id })).toEqual({ ok: true, data: { id, employee_id: mine.employeeId } });
});

testWithSupabase('a member enrols and withdraws themselves by the dates, and an admin marks completion', async () => {
  const course = (title: string, from: number, to: number) =>
    saveTraining(ownerCtx(), { title, category: 'Skills', starts_on: addDays(TODAY, from), ends_on: addDays(TODAY, to) });
  const later = await course('Later course', 5, 6);
  const running = await course('Running course', -1, 1);
  const over = await course('Ended course', -5, -4);
  expect(later.ok && running.ok && over.ok, JSON.stringify([later, running, over])).toBe(true);
  if (!later.ok || !running.ok || !over.ok) return;

  // Before the start: enrol, twice is refused, withdraw.
  expect(await enrol(memberCtx(), { training_id: later.data.id, employee_id: mine.employeeId })).toEqual({
    ok: true, data: { training_id: later.data.id, employee_id: mine.employeeId, completed: false },
  });
  expect(await enrol(memberCtx(), { training_id: later.data.id, employee_id: mine.employeeId })).toEqual({
    ok: false, error: PERFORMANCE_REFUSALS.PERF_ALREADY_ENROLLED,
  });
  expect((await memberData().listTrainingEnrolments()).filter((e) => e.employee_id === mine.employeeId)).toHaveLength(1);
  expect((await unenrol(memberCtx(), { training_id: later.data.id, employee_id: mine.employeeId })).ok).toBe(true);
  expect(await unenrol(memberCtx(), { training_id: later.data.id, employee_id: mine.employeeId })).toEqual({
    ok: false, error: PERFORMANCE_REFUSALS.PERF_NOT_ENROLLED,
  });

  // A colleague cannot be enrolled by a member; a course that has ended cannot be joined.
  expect(await enrol(memberCtx(), { training_id: later.data.id, employee_id: colleague.employeeId })).toEqual(PERF_NOT_FOUND);
  expect(await enrol(memberCtx(), { training_id: over.data.id, employee_id: mine.employeeId })).toEqual({
    ok: false, error: PERFORMANCE_REFUSALS.PERF_COURSE_ENDED,
  });

  // During the course: a member may still enrol, but not withdraw.
  expect((await enrol(memberCtx(), { training_id: running.data.id, employee_id: mine.employeeId })).ok).toBe(true);
  expect(await unenrol(memberCtx(), { training_id: running.data.id, employee_id: mine.employeeId })).toEqual({
    ok: false, error: PERFORMANCE_REFUSALS.PERF_COURSE_STARTED,
  });

  // An admin marks completion once the course has started, and not before.
  expect(await setTrainingCompleted(ownerCtx(), { training_id: later.data.id, employee_id: mine.employeeId, completed: true })).toEqual({
    ok: false, error: PERFORMANCE_REFUSALS.PERF_NOT_ENROLLED,
  });
  expect(await enrol(ownerCtx(), { training_id: later.data.id, employee_id: colleague.employeeId })).toMatchObject({ ok: true });
  expect(await setTrainingCompleted(ownerCtx(), { training_id: later.data.id, employee_id: colleague.employeeId, completed: true })).toEqual({
    ok: false, error: PERFORMANCE_REFUSALS.PERF_COURSE_NOT_STARTED,
  });
  expect(await setTrainingCompleted(memberCtx(), { training_id: running.data.id, employee_id: mine.employeeId, completed: true })).toEqual(PERF_NOT_FOUND);
  expect(await setTrainingCompleted(ownerCtx(), { training_id: running.data.id, employee_id: mine.employeeId, completed: true })).toEqual({
    ok: true, data: { training_id: running.data.id, employee_id: mine.employeeId, completed: true },
  });
  const marked = (await memberData().listTrainingEnrolments()).find((e) => e.training_id === running.data.id);
  expect(marked).toMatchObject({ completed: true });
  expect(marked?.completed_at).toBeTruthy();

  // Someone marked completed cannot withdraw, and their course cannot be deleted until it is undone.
  expect(await deleteTraining(ownerCtx(), { training_id: running.data.id })).toEqual({ ok: false, error: PERFORMANCE_REFUSALS.PERF_COMPLETED });
  expect(await unenrol(ownerCtx(), { training_id: running.data.id, employee_id: mine.employeeId })).toEqual({
    ok: false, error: PERFORMANCE_REFUSALS.PERF_COMPLETED,
  });
  expect((await setTrainingCompleted(ownerCtx(), { training_id: running.data.id, employee_id: mine.employeeId, completed: false })).ok).toBe(true);
  expect((await deleteTraining(ownerCtx(), { training_id: running.data.id })).ok).toBe(true);

  // The course a member may read is the course as the database holds it: no stored status is read.
  const read = (await memberData().listTrainings()).find((t) => t.id === later.data.id);
  expect(read).toMatchObject({ title: 'Later course', starts_on: addDays(TODAY, 5), ends_on: addDays(TODAY, 6) });
  expect(read).not.toHaveProperty('status');
});

testWithSupabase('an announcement is a draft nobody else reads, then unread for the member only, then read', async () => {
  const draft = await saveAnnouncement(ownerCtx(), { title: 'Town hall', body: 'Friday at 3pm.', category: 'general' });
  expect(draft.ok, JSON.stringify(draft)).toBe(true);
  if (!draft.ok) return;
  const id = draft.data.id;
  expect(draft.data).toMatchObject({ status: 'draft', published_at: null });

  // Invisible to the member, and not counted.
  expect((await memberData().listAnnouncements()).find((a) => a.id === id)).toBeUndefined();
  expect(await unreadAnnouncements(memberCtx())).toBe(0);
  expect((await ownerData().listAnnouncements()).find((a) => a.id === id)).toMatchObject({ status: 'draft', unread: false });

  // Published: the member sees it as unread, and so does the owner by the same rule (they joined earlier).
  expect(await publishAnnouncement(ownerCtx(), { announcement_id: id })).toMatchObject({ ok: true, data: { status: 'published' } });
  const before = await memberData().listAnnouncements();
  expect(before.find((a) => a.id === id)).toMatchObject({ status: 'published', unread: true });
  expect(await unreadAnnouncements(memberCtx())).toBe(1);
  const ownerBefore = await unreadAnnouncements(ownerCtx());

  // The member marks them read: only their own mark changes.
  expect(await markAnnouncementsRead(memberCtx())).toEqual({ ok: true, data: { marked: 1 } });
  expect(await unreadAnnouncements(memberCtx())).toBe(0);
  expect((await memberData().listAnnouncements()).find((a) => a.id === id)?.unread).toBe(false);
  expect(await unreadAnnouncements(ownerCtx())).toBe(ownerBefore);
  expect((await ownerData().listAnnouncements()).find((a) => a.id === id)?.unread).toBe(ownerBefore > 0);

  // Marking again marks nothing; an edit does not make it unread again.
  expect(await markAnnouncementsRead(memberCtx())).toEqual({ ok: true, data: { marked: 0 } });
  const edited = await saveAnnouncement(ownerCtx(), { announcement_id: id, title: 'Town hall (moved)', body: 'Friday at 4pm.', category: 'general' });
  expect(edited).toMatchObject({ ok: true, data: { status: 'published' } });
  expect(edited.ok && edited.data.edited_at).toBeTruthy();
  expect(await unreadAnnouncements(memberCtx())).toBe(0);

  // Pulled back, the member no longer reads it; deleting it is the owner's.
  expect(await unpublishAnnouncement(ownerCtx(), { announcement_id: id })).toMatchObject({ ok: true, data: { status: 'draft', published_at: null } });
  expect((await memberData().listAnnouncements()).find((a) => a.id === id)).toBeUndefined();
  expect(await deleteAnnouncement(ownerCtx(), { announcement_id: id })).toEqual({ ok: true, data: { id } });
});

testWithSupabase('every owner-only write is refused to the member, with its sentence', async () => {
  const course = await saveTraining(ownerCtx(), { title: 'Owner course', starts_on: addDays(TODAY, 8), ends_on: addDays(TODAY, 9) });
  const post = await saveAnnouncement(ownerCtx(), { title: 'Owner post', body: 'x', category: 'policy' });
  const review = await saveReview(ownerCtx(), { employee_id: colleague.employeeId, period: 'FY 2025', competencies: SCORES, rating: 'meets' });
  expect(course.ok && post.ok && review.ok, JSON.stringify([course, post, review])).toBe(true);
  if (!course.ok || !post.ok || !review.ok) return;

  const ctx = memberCtx();
  // Naming no existing row: not allowed.
  expect(await saveTraining(ctx, { title: 'Mine', starts_on: addDays(TODAY, 8), ends_on: addDays(TODAY, 9) })).toEqual(PERF_NOT_ALLOWED);
  expect(await saveAnnouncement(ctx, { title: 'Mine', body: 'x', category: 'general', publish: true })).toEqual(ANN_NOT_ALLOWED);
  // Naming a row that exists: not found, so the answer does not say which ids are real.
  expect(await saveReview(ctx, { employee_id: mine.employeeId, period: 'FY 2024', competencies: SCORES, rating: 'meets' })).toEqual(PERF_NOT_FOUND);
  expect(await releaseReview(ctx, { review_id: review.data.id })).toEqual(PERF_NOT_FOUND);
  expect(await unreleaseReview(ctx, { review_id: review.data.id })).toEqual(PERF_NOT_FOUND);
  expect(await deleteReview(ctx, { review_id: review.data.id })).toEqual(PERF_NOT_FOUND);
  expect(await saveTraining(ctx, { training_id: course.data.id, title: 'Taken', starts_on: addDays(TODAY, 8), ends_on: addDays(TODAY, 9) })).toEqual(PERF_NOT_FOUND);
  expect(await deleteTraining(ctx, { training_id: course.data.id })).toEqual(PERF_NOT_FOUND);
  expect(await setTrainingCompleted(ctx, { training_id: course.data.id, employee_id: mine.employeeId, completed: true })).toEqual(PERF_NOT_FOUND);
  expect(await saveAnnouncement(ctx, { announcement_id: post.data.id, title: 'Taken', body: 'x', category: 'general' })).toEqual(ANN_NOT_FOUND);
  expect(await publishAnnouncement(ctx, { announcement_id: post.data.id })).toEqual(ANN_NOT_FOUND);
  expect(await unpublishAnnouncement(ctx, { announcement_id: post.data.id })).toEqual(ANN_NOT_FOUND);
  expect(await deleteAnnouncement(ctx, { announcement_id: post.data.id })).toEqual(ANN_NOT_FOUND);

  // Nothing changed.
  const rows = await ownerData().listAnnouncements();
  expect(rows.find((a) => a.id === post.data.id)).toMatchObject({ title: 'Owner post', status: 'draft' });
  expect((await ownerData().listTrainings()).find((t) => t.id === course.data.id)?.title).toBe('Owner course');
  expect((await ownerData().listReviews()).find((r) => r.id === review.data.id)).toMatchObject({ status: 'draft' });
});

testWithSupabase('a demo guest changes nothing, and has no unread', async () => {
  // The demo is rebuilt at the top of every hour; its rows are not there to be tried in the first minutes of it.
  if (new Date().getUTCMinutes() <= 2) {
    console.warn('Skipped the demo part of the performance live test: the demo is being re-seeded (minutes :00 to :02).');
    return;
  }
  const g = client();
  expect((await signInAnon(g)).error).toBeNull();
  const demo = await joinDemo(g);
  expect(demo.error, demo.error?.message).toBeNull();
  guest = { c: g, demoId: demo.data as string };
  const ctx = { client: guest.c, orgId: guest.demoId };
  const data = createSupabasePeopleData(guest.c, guest.demoId);
  const [goals, reviews, trainings, announcements] = await Promise.all([
    data.listGoals(), data.listReviews(), data.listTrainings(), data.listAnnouncements(),
  ]);
  const goal = goals[0];
  const review = reviews[0];
  const course = trainings[0];
  const post = announcements[0];
  expect(goal && review && course && post, 'the demo has a goal, a review, a course and an announcement to try').toBeTruthy();
  if (!goal || !review || !course || !post) return;

  const results = [
    await saveGoal(ctx, { employee_id: DEMO_EMPLOYEE_ID, title: 'Demo goal', progress: 1 }),
    await deleteGoal(ctx, { goal_id: goal.id }),
    await saveReview(ctx, { employee_id: review.employee_id, period: 'FY 2020', competencies: SCORES, rating: 'meets' }),
    await releaseReview(ctx, { review_id: review.id }),
    await unreleaseReview(ctx, { review_id: review.id }),
    await deleteReview(ctx, { review_id: review.id }),
    await saveTraining(ctx, { title: 'Demo course', starts_on: addDays(TODAY, 8), ends_on: addDays(TODAY, 9) }),
    await deleteTraining(ctx, { training_id: course.id }),
    await enrol(ctx, { training_id: course.id, employee_id: DEMO_EMPLOYEE_ID }),
    await unenrol(ctx, { training_id: course.id, employee_id: DEMO_EMPLOYEE_ID }),
    await setTrainingCompleted(ctx, { training_id: course.id, employee_id: DEMO_EMPLOYEE_ID, completed: true }),
  ];
  for (const result of results) expect(result).toEqual(PERF_NOT_ALLOWED);
  const announcementResults = [
    await saveAnnouncement(ctx, { title: 'Demo post', body: 'x', category: 'general' }),
    await publishAnnouncement(ctx, { announcement_id: post.id }),
    await unpublishAnnouncement(ctx, { announcement_id: post.id }),
    await deleteAnnouncement(ctx, { announcement_id: post.id }),
    await markAnnouncementsRead(ctx),
  ];
  for (const result of announcementResults) expect(result).toEqual(ANN_NOT_ALLOWED);

  expect(await unreadAnnouncements(ctx)).toBe(0);
  // The demo's rows are as they were.
  expect((await data.listAnnouncements()).length).toBe(announcements.length);
  expect((await data.listReviews()).length).toBe(reviews.length);
});
