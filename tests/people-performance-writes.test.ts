import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERFORMANCE_REFUSALS } from '@/lib/people/performance-refusals';
import {
  PERFORMANCE_REFUSALS as REEXPORTED,
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
import { fakeSupabase } from './setup/fake-supabase';

const ORG = '99999999-9999-4999-8999-999999999999';
const EMP = '44444444-4444-4444-8444-444444444444';
const GOAL = '11111111-1111-4111-8111-111111111111';
const REVIEW = '22222222-2222-4222-8222-222222222222';
const COURSE = '33333333-3333-4333-8333-333333333333';
const ctxOf = (client: never) => ({ client, orgId: ORG });
const GENERIC = 'That change could not be saved. Please try again.';
const SCORES = { Delivery: 4, Teamwork: 3.5, Ownership: 5, Communication: 2 };

afterEach(() => vi.restoreAllMocks());

const goalJson = (over: Record<string, unknown> = {}) => ({
  id: GOAL, employee_id: EMP, title: 'Ship it', progress: 40, due_date: '2026-12-01', status: 'on_track', ...over,
});
const reviewJson = (over: Record<string, unknown> = {}) => ({
  id: REVIEW, employee_id: EMP, period: 'H1 2026', competencies: SCORES, score: 3.63, rating: 'meets',
  comment: 'Solid.', status: 'draft', released_at: null, reviewer_name: 'Kavitha Nair', reviewed_at: '2026-10-12', ...over,
});
const courseJson = (over: Record<string, unknown> = {}) => ({
  id: COURSE, title: 'Excel', category: 'Skills', provider: null, starts_on: '2026-11-01', ends_on: '2026-11-02', ...over,
});

describe('PERFORMANCE_REFUSALS', () => {
  it('is the leaf module, re-exported by the write path', () => {
    expect(REEXPORTED).toBe(PERFORMANCE_REFUSALS);
  });

  it('has the spec sentence for every code the database raises', () => {
    expect(PERFORMANCE_REFUSALS).toEqual({
      PERF_NOT_ALLOWED: "You can't make that change.",
      ANN_NOT_ALLOWED: "You can't make that change.",
      PERF_NOT_FOUND: 'That record could not be found.',
      ANN_NOT_FOUND: 'That announcement could not be found.',
      PERF_BAD_INPUT: 'Some of that was not accepted. Check it and try again.',
      ANN_BAD_INPUT: 'Some of that was not accepted. Check it and try again.',
      PERF_TOO_MANY_GOALS: 'That is 30 open goals already. Finish or remove one first.',
      PERF_REVIEW_EXISTS: 'There is already a review for that period.',
      PERF_NOT_DRAFT: 'That review has been released. Pull it back to draft on the Review Scores screen to change it.',
      PERF_NOT_RELEASED: 'That review is still a draft.',
      PERF_ALREADY_ENROLLED: 'They are already enrolled in that course.',
      PERF_NOT_ENROLLED: 'They are not enrolled in that course.',
      PERF_COURSE_ENDED: 'That course has ended.',
      PERF_COURSE_STARTED: 'That course has already started. Ask an owner or admin to remove you.',
      PERF_COURSE_NOT_STARTED: 'That course has not started yet.',
      PERF_COMPLETED: 'Someone is marked as completed on it. Undo that first.',
      PERF_INACTIVE_EMPLOYEE: 'This employee record is inactive.',
      ANN_NOT_DRAFT: 'That announcement is already published.',
      ANN_NOT_PUBLISHED: 'That announcement is still a draft.',
    });
  });
});

describe('the calls each function makes', () => {
  it('adds a goal: a null goal id, a trimmed title, a null due date and at_risk false by default', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_goal': { data: goalJson({ due_date: null }) } });
    const result = await saveGoal(ctxOf(client), { employee_id: EMP, title: '  Ship it ', progress: 40 } as never);
    expect(result).toEqual({
      ok: true,
      data: { id: GOAL, employee_id: EMP, title: 'Ship it', progress: 40, due_date: null, status: 'on_track' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('hr_save_goal');
    expect(calls[0].args).toEqual({
      p_employee: EMP, p_goal: null, p_title: 'Ship it', p_progress: 40, p_due_date: null, p_at_risk: false,
    });
  });

  it('changes a goal by its id, with a due date and at_risk', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_goal': { data: goalJson({ status: 'at_risk' }) } });
    await saveGoal(ctxOf(client), {
      employee_id: EMP, goal_id: GOAL, title: 'Ship it', progress: 40, due_date: '2026-12-01', at_risk: true,
    });
    expect(calls[0].args).toEqual({
      p_employee: EMP, p_goal: GOAL, p_title: 'Ship it', p_progress: 40, p_due_date: '2026-12-01', p_at_risk: true,
    });
  });

  it('reads an empty string for the goal, the due date or a comment as none', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_goal': { data: goalJson() } });
    await saveGoal(ctxOf(client), { employee_id: EMP, goal_id: '  ', title: 'x', progress: 0, due_date: '' } as never);
    expect(calls[0].args).toMatchObject({ p_goal: null, p_due_date: null });
  });

  it('refuses a goal id that is neither text nor null, and never reads it as "add"', async () => {
    const { client, calls } = fakeSupabase();
    for (const goal_id of [5, {}, [], true, 'not-a-guid']) {
      const result = await saveGoal(ctxOf(client), { employee_id: EMP, goal_id, title: 'x', progress: 1 } as never);
      expect(result.ok, JSON.stringify(goal_id)).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses a bad goal before calling: blank title, progress outside 0 to 100, a fraction, a bad date, a bad employee', async () => {
    const { client, calls } = fakeSupabase();
    const good = { employee_id: EMP, title: 'x', progress: 1 };
    for (const patch of [
      { title: '   ' }, { title: 'x'.repeat(201) }, { progress: -1 }, { progress: 101 }, { progress: 1.5 },
      { due_date: '2026-02-31' }, { due_date: '1999-01-01' }, { employee_id: 'nope' }, { employee_id: undefined },
    ]) {
      expect((await saveGoal(ctxOf(client), { ...good, ...patch } as never)).ok, JSON.stringify(patch)).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it('removes a goal', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_delete_goal': { data: { id: GOAL, employee_id: EMP } } });
    expect(await deleteGoal(ctxOf(client), { goal_id: GOAL })).toEqual({ ok: true, data: { id: GOAL, employee_id: EMP } });
    expect(calls[0].fn).toBe('hr_delete_goal');
    expect(calls[0].args).toEqual({ p_goal: GOAL });
  });

  it('adds a review with the four scores, a trimmed comment and a null review id', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_review': { data: reviewJson() } });
    const result = await saveReview(ctxOf(client), {
      employee_id: EMP, period: 'H1 2026', competencies: SCORES, rating: 'meets', comment: '  Solid.  ',
    });
    expect(result).toEqual({ ok: true, data: reviewJson() });
    expect(calls[0].fn).toBe('hr_save_review');
    expect(calls[0].args).toEqual({
      p_employee: EMP, p_review: null, p_period: 'H1 2026', p_competencies: SCORES, p_rating: 'meets', p_comment: 'Solid.',
    });
  });

  it('changes a review by its id and sends a blank comment as null', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_review': { data: reviewJson({ comment: null }) } });
    const result = await saveReview(ctxOf(client), {
      employee_id: EMP, review_id: REVIEW, period: 'FY 2026', competencies: SCORES, rating: 'below', comment: '   ',
    });
    expect(result).toMatchObject({ ok: true, data: { comment: null, released_at: null, status: 'draft' } });
    expect(calls[0].args).toMatchObject({ p_review: REVIEW, p_period: 'FY 2026', p_rating: 'below', p_comment: null });
  });

  it('refuses a bad review before calling', async () => {
    const { client, calls } = fakeSupabase();
    const good = { employee_id: EMP, period: 'H1 2026', competencies: SCORES, rating: 'meets' };
    const cases: Record<string, unknown>[] = [
      { period: 'H1 26' }, { period: 'h1 2026' }, { period: 'H3 2026' }, { period: 'H1 1999' },
      { rating: 'great' }, { rating: undefined },
      { competencies: { ...SCORES, Delivery: 4.25 } }, { competencies: { ...SCORES, Delivery: 0.5 } },
      { competencies: { ...SCORES, Delivery: 5.5 } }, { competencies: { ...SCORES, Delivery: '4' } },
      { competencies: { Delivery: 4, Teamwork: 4, Ownership: 4 } },
      { competencies: { ...SCORES, Extra: 3 } },
      { competencies: undefined },
      { comment: 'x'.repeat(2001) }, { review_id: 7 },
    ];
    for (const patch of cases) {
      expect((await saveReview(ctxOf(client), { ...good, ...patch } as never)).ok, JSON.stringify(patch)).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it('releases, pulls back and deletes a review by its id alone', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_release_review': { data: reviewJson({ status: 'released', released_at: '2026-10-12T02:00:00+00:00' }) },
      'rpc.hr_unrelease_review': { data: reviewJson() },
      'rpc.hr_delete_review': { data: { id: REVIEW, employee_id: EMP } },
    });
    expect(await releaseReview(ctxOf(client), { review_id: REVIEW })).toMatchObject({
      ok: true, data: { status: 'released', released_at: '2026-10-12T02:00:00+00:00' },
    });
    expect(await unreleaseReview(ctxOf(client), { review_id: REVIEW })).toMatchObject({ ok: true, data: { status: 'draft' } });
    expect(await deleteReview(ctxOf(client), { review_id: REVIEW })).toEqual({ ok: true, data: { id: REVIEW, employee_id: EMP } });
    expect(calls.map((c) => [c.fn, c.args])).toEqual([
      ['hr_release_review', { p_review: REVIEW }],
      ['hr_unrelease_review', { p_review: REVIEW }],
      ['hr_delete_review', { p_review: REVIEW }],
    ]);
  });

  it('adds a course with the workspace from the context, never from the input', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_training': { data: courseJson() } });
    const result = await saveTraining(ctxOf(client), {
      title: ' Excel ', category: ' Skills ', provider: '', starts_on: '2026-11-01', ends_on: '2026-11-02', org_id: 'someone-else',
    } as never);
    expect(result).toEqual({ ok: true, data: courseJson() });
    expect(calls[0].fn).toBe('hr_save_training');
    expect(calls[0].args).toEqual({
      p_org: ORG, p_training: null, p_title: 'Excel', p_category: 'Skills', p_provider: null,
      p_starts_on: '2026-11-01', p_ends_on: '2026-11-02',
    });
  });

  it('changes a course by its id, allows a one-day course and refuses an end before the start', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_training': { data: courseJson() } });
    await saveTraining(ctxOf(client), {
      training_id: COURSE, title: 'Excel', starts_on: '2026-11-01', ends_on: '2026-11-01',
    } as never);
    expect(calls[0].args).toMatchObject({ p_training: COURSE, p_category: null, p_provider: null });
    const before = calls.length;
    expect(
      (await saveTraining(ctxOf(client), { title: 'Excel', starts_on: '2026-11-02', ends_on: '2026-11-01' } as never)).ok,
    ).toBe(false);
    expect(
      (await saveTraining(ctxOf(client), { title: 'Excel', starts_on: '2026-11-02' } as never)).ok,
    ).toBe(false);
    expect(
      (await saveTraining(ctxOf(client), { training_id: 3, title: 'Excel', starts_on: '2026-11-01', ends_on: '2026-11-02' } as never)).ok,
    ).toBe(false);
    expect(calls).toHaveLength(before);
  });

  it('deletes a course', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_delete_training': { data: { id: COURSE } } });
    expect(await deleteTraining(ctxOf(client), { training_id: COURSE })).toEqual({ ok: true, data: { id: COURSE } });
    expect(calls[0].args).toEqual({ p_training: COURSE });
  });

  it('enrols, withdraws and marks completion for an employee', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_enrol': { data: { training_id: COURSE, employee_id: EMP, completed: false } },
      'rpc.hr_unenrol': { data: { training_id: COURSE, employee_id: EMP } },
      'rpc.hr_set_training_completed': { data: { training_id: COURSE, employee_id: EMP, completed: true } },
    });
    expect(await enrol(ctxOf(client), { training_id: COURSE, employee_id: EMP })).toEqual({
      ok: true, data: { training_id: COURSE, employee_id: EMP, completed: false },
    });
    expect(await unenrol(ctxOf(client), { training_id: COURSE, employee_id: EMP })).toEqual({
      ok: true, data: { training_id: COURSE, employee_id: EMP },
    });
    expect(await setTrainingCompleted(ctxOf(client), { training_id: COURSE, employee_id: EMP, completed: true })).toEqual({
      ok: true, data: { training_id: COURSE, employee_id: EMP, completed: true },
    });
    expect(calls.map((c) => [c.fn, c.args])).toEqual([
      ['hr_enrol', { p_training: COURSE, p_employee: EMP }],
      ['hr_unenrol', { p_training: COURSE, p_employee: EMP }],
      ['hr_set_training_completed', { p_training: COURSE, p_employee: EMP, p_completed: true }],
    ]);
  });

  it('needs an explicit completed flag, and ids that are real', async () => {
    const { client, calls } = fakeSupabase();
    for (const input of [
      { training_id: COURSE, employee_id: EMP },
      { training_id: COURSE, employee_id: EMP, completed: 'true' },
      { training_id: COURSE, employee_id: EMP, completed: null },
      { training_id: 'x', employee_id: EMP, completed: true },
    ]) {
      expect((await setTrainingCompleted(ctxOf(client), input as never)).ok, JSON.stringify(input)).toBe(false);
    }
    expect((await enrol(ctxOf(client), { training_id: COURSE } as never)).ok).toBe(false);
    expect((await unenrol(ctxOf(client), { employee_id: EMP } as never)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('refusals and failures', () => {
  const codes = Object.keys(PERFORMANCE_REFUSALS).filter((code) => code.startsWith('PERF_'));

  it.each(codes)('turns %s into its sentence', async (code) => {
    const { client } = fakeSupabase({ 'rpc.hr_release_review': { error: { message: code } } });
    expect(await releaseReview(ctxOf(client), { review_id: REVIEW })).toEqual({ ok: false, error: PERFORMANCE_REFUSALS[code] });
  });

  it('turns a refusal from every function into a sentence', async () => {
    const refusal = { error: { code: 'P0001', message: 'PERF_NOT_FOUND' } };
    const { client } = fakeSupabase({
      'rpc.hr_save_goal': refusal, 'rpc.hr_delete_goal': refusal, 'rpc.hr_save_review': refusal,
      'rpc.hr_unrelease_review': refusal, 'rpc.hr_delete_review': refusal, 'rpc.hr_save_training': refusal,
      'rpc.hr_delete_training': refusal, 'rpc.hr_enrol': refusal, 'rpc.hr_unenrol': refusal,
      'rpc.hr_set_training_completed': refusal,
    });
    const sentence = { ok: false, error: PERFORMANCE_REFUSALS.PERF_NOT_FOUND };
    const c = ctxOf(client);
    expect(await saveGoal(c, { employee_id: EMP, title: 'x', progress: 1 })).toEqual(sentence);
    expect(await deleteGoal(c, { goal_id: GOAL })).toEqual(sentence);
    expect(await saveReview(c, { employee_id: EMP, period: 'H1 2026', competencies: SCORES, rating: 'meets' })).toEqual(sentence);
    expect(await unreleaseReview(c, { review_id: REVIEW })).toEqual(sentence);
    expect(await deleteReview(c, { review_id: REVIEW })).toEqual(sentence);
    expect(await saveTraining(c, { title: 'x', starts_on: '2026-11-01', ends_on: '2026-11-02' })).toEqual(sentence);
    expect(await deleteTraining(c, { training_id: COURSE })).toEqual(sentence);
    expect(await enrol(c, { training_id: COURSE, employee_id: EMP })).toEqual(sentence);
    expect(await unenrol(c, { training_id: COURSE, employee_id: EMP })).toEqual(sentence);
    expect(await setTrainingCompleted(c, { training_id: COURSE, employee_id: EMP, completed: false })).toEqual(sentence);
  });

  it('answers an unknown error generically and logs only the code, never the message (it can quote what was typed)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({
      'rpc.hr_save_goal': { error: { code: '57014', message: 'invalid input syntax for type date: "SECRET GOAL TITLE"' } },
    });
    const result = await saveGoal(ctxOf(client), { employee_id: EMP, title: 'SECRET GOAL TITLE', progress: 77 });
    expect(result).toEqual({ ok: false, error: GENERIC });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual(['[people-capability] saveGoal failed:', '57014', 'no row came back']);
  });

  it('does not take a message that merely mentions a code as that refusal', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_release_review': { error: { message: 'detail: PERF_NOT_DRAFT happened' } } });
    expect(await releaseReview(ctxOf(client), { review_id: REVIEW })).toEqual({ ok: false, error: GENERIC });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('does not take an inherited name such as a prototype key as a refusal code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_release_review': { error: { message: 'CONSTRUCTOR' } } });
    expect(await releaseReview(ctxOf(client), { review_id: REVIEW })).toEqual({ ok: false, error: GENERIC });
  });

  it('treats a reply that is not what was promised as a failed save, logging no content', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({
      'rpc.hr_save_review': { data: { id: REVIEW, comment: 'SECRET COMMENT' } },
      'rpc.hr_save_goal': { data: null },
    });
    const review = await saveReview(ctxOf(client), { employee_id: EMP, period: 'H1 2026', competencies: SCORES, rating: 'meets' });
    expect(review).toEqual({ ok: false, error: GENERIC });
    expect(await saveGoal(ctxOf(client), { employee_id: EMP, title: 'x', progress: 1 })).toEqual({ ok: false, error: GENERIC });
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET COMMENT');
  });
});

describe('what comes back is read carefully', () => {
  it('keeps a review reply with no comment, reviewer or release time as null', async () => {
    const { client } = fakeSupabase({
      'rpc.hr_save_review': { data: reviewJson({ comment: null, reviewer_name: null, released_at: null }) },
    });
    const result = await saveReview(ctxOf(client), { employee_id: EMP, period: 'H1 2026', competencies: SCORES, rating: 'meets' });
    expect(result).toMatchObject({ ok: true, data: { comment: null, reviewer_name: null, released_at: null } });
  });

  it('refuses a review reply with a status that is neither draft nor released', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_release_review': { data: reviewJson({ status: 'published' }) } });
    expect((await releaseReview(ctxOf(client), { review_id: REVIEW })).ok).toBe(false);
  });

  it('refuses a goal reply with a status outside the three', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_save_goal': { data: goalJson({ status: 'late' }) } });
    expect((await saveGoal(ctxOf(client), { employee_id: EMP, title: 'x', progress: 1 })).ok).toBe(false);
  });
});
