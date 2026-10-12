import { describe, expect, it } from 'vitest';
import {
  buildGoalsModel,
  buildReviewsModel,
  buildScorecardModel,
  buildTrainingModel,
  dateRange,
  formatScore,
  shorten,
} from '@/lib/people/performance';
import { createSeedPeopleData } from '@/lib/people/seed';
import { DEMO_EMPLOYEE_ID, type PeopleViewer, type Review } from '@/lib/people/types';

const NOW = new Date('2026-10-09T04:00:00Z');
const data = createSeedPeopleData(NOW);

const HR: PeopleViewer = { employeeId: 'seed-emp-3', isHr: true, isDemo: false };
const DEMO: PeopleViewer = { employeeId: DEMO_EMPLOYEE_ID, isHr: false, isDemo: true };
const MEMBER: PeopleViewer = { employeeId: 'seed-emp-5', isHr: false, isDemo: false };
const UNLINKED_HR: PeopleViewer = { employeeId: null, isHr: true, isDemo: false };

describe('shorten and formatScore', () => {
  it('cuts to the limit with an ellipsis, leaving short text alone', () => {
    expect(shorten('Short', 28)).toBe('Short');
    const long = shorten('Close twenty enterprise deals before the year ends', 28);
    expect(long).toHaveLength(28);
    expect(long.endsWith('…')).toBe(true);
  });

  it('shows a score to one decimal out of 5', () => {
    expect(formatScore(4.25)).toBe('4.3 / 5');
    expect(formatScore(3)).toBe('3.0 / 5');
  });
});

describe('buildGoalsModel', () => {
  it('gives the demo employee their own 4 goals: 3 on track, 1 at risk', async () => {
    const model = buildGoalsModel(await data.listGoals(), DEMO);
    expect(model.linked).toBe(true);
    expect(model.goals).toHaveLength(4);
    expect(model.counts).toEqual({ total: 4, on_track: 3, at_risk: 1, done: 0 });
    expect(model.average_progress).toBe(Math.round((69 + 92 + 37 + 62) / 4));
  });

  it('gives an HR viewer only their own goals, not the team', async () => {
    const model = buildGoalsModel(await data.listGoals(), HR);
    expect(model.goals).toHaveLength(4);
    expect(model.goals.every((g) => g.id.startsWith('seed-goal-3-'))).toBe(true);
  });

  it('is not linked when the account has no employee, whatever the role', async () => {
    const model = buildGoalsModel(await data.listGoals(), UNLINKED_HR);
    expect(model.linked).toBe(false);
    expect(model.goals).toEqual([]);
  });

  it('has no average and no NaN with no goals', () => {
    const model = buildGoalsModel([], DEMO);
    expect(model.average_progress).toBeNull();
    expect(model.counts.total).toBe(0);
  });

  it('shortens long titles for the chart label only', () => {
    const model = buildGoalsModel(
      [
        {
          id: 'g1',
          employee_id: DEMO_EMPLOYEE_ID,
          employee_name: 'X',
          title: 'A very long goal title that goes past the limit',
          progress: 10,
          due_date: null,
          status: 'on_track',
        },
      ],
      DEMO,
    );
    expect(model.goals[0].title).toBe('A very long goal title that goes past the limit');
    expect(model.goals[0].short).toHaveLength(28);
    expect(model.goals[0].due_date).toBeNull();
  });
});

/* ---- Reviews: one record behind the Scorecard and Review Scores screens ---- */

const TODAY = '2026-10-09';
// The sample company's reviews: 20, released but for employees 10 and 16, which are drafts.
const DRAFT_IDS = ['seed-review-10', 'seed-review-16'];

const review = (over: Partial<Review>): Review => ({
  id: 'r1',
  employee_id: 'seed-emp-5',
  employee_name: 'Siti Aminah',
  period: 'H1 2026',
  competencies: { Delivery: 4, Teamwork: 4, Ownership: 4, Communication: 4 },
  rating: 'meets',
  score: 4,
  comment: 'Solid.',
  status: 'released',
  released_at: '2026-08-01T00:00:00+00:00',
  reviewer_name: 'Kavitha Nair',
  reviewed_at: '2026-07-30',
  ...over,
});
const draftOf = (over: Partial<Review> = {}) => review({ status: 'draft', released_at: null, ...over });
const noScores = {} as Review['competencies'];

describe('the sample reviews', () => {
  it('are the demo re-seed: 18 released and 2 drafts, each with four half-step scores and a comment', async () => {
    const reviews = await data.listReviews();
    expect(reviews).toHaveLength(20);
    expect(reviews.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual(DRAFT_IDS);
    for (const r of reviews) {
      expect(Object.keys(r.competencies).sort()).toEqual(['Communication', 'Delivery', 'Ownership', 'Teamwork']);
      expect(Object.values(r.competencies).every((v) => v >= 1 && v <= 5 && Number.isInteger(v * 2))).toBe(true);
      expect(r.comment).toBeTruthy();
      expect(r.status === 'released' ? r.released_at !== null : r.released_at === null).toBe(true);
    }
  });
});

describe('buildScorecardModel', () => {
  it('summarises the team for HR over released reviews, listing the two drafts marked and counting neither', async () => {
    const [reviews, employees] = await Promise.all([data.listReviews(), data.listEmployees()]);
    const model = buildScorecardModel(reviews, employees, HR);
    expect(model.team).toBe(true);
    expect(model.scored).toBe(18);
    expect(model.drafts).toBe(2);
    expect(model.rows).toHaveLength(20);
    expect(model.rows.filter((r) => r.draft).map((r) => r.id).sort()).toEqual(DRAFT_IDS);
    expect(model.highest?.score).toBe(4.63);
    expect(model.average).toBe(3.9);
    expect(model.department_averages.reduce((total, d) => total + d.count, 0)).toBe(18);
    expect(model.competencies.map((c) => c.label)).toEqual(['Communication', 'Delivery', 'Ownership', 'Teamwork']);
    expect(model.rows[0].score).toBeGreaterThanOrEqual(model.rows[19].score);
  });

  it('gives the same figures with the drafts removed from the input as with them in', async () => {
    const [reviews, employees] = await Promise.all([data.listReviews(), data.listEmployees()]);
    const withDrafts = buildScorecardModel(reviews, employees, HR);
    const without = buildScorecardModel(reviews.filter((r) => r.status === 'released'), employees, HR);
    expect(withDrafts.average).toBe(without.average);
    expect(withDrafts.competencies).toEqual(without.competencies);
    expect(withDrafts.department_averages).toEqual(without.department_averages);
    expect(withDrafts.highest).toEqual(without.highest);
  });

  it('never lets a draft be the highest score', () => {
    const model = buildScorecardModel(
      [review({ id: 'a', score: 3 }), draftOf({ id: 'b', score: 5, employee_name: 'Draft Person' })],
      [],
      HR,
    );
    expect(model.highest).toEqual({ employee: 'Siti Aminah', score: 3 });
    expect(model.average).toBe(3);
  });

  it('shows a member only their own released reviews, with no team figures and no word of a draft', async () => {
    const [reviews, employees] = await Promise.all([data.listReviews(), data.listEmployees()]);
    const model = buildScorecardModel(reviews, employees, MEMBER);
    expect(model.team).toBe(false);
    expect(model.department_averages).toEqual([]);
    expect(model.highest).toBeNull();
    expect(model.drafts).toBeNull();
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].draft).toBe(false);
    expect(model.scored).toBe(1);
  });

  it('shows a member nothing of their own draft, even when handed it', () => {
    const model = buildScorecardModel([draftOf({ id: 'mine-draft', score: 5 })], [], MEMBER);
    expect(model).toMatchObject({ scored: 0, drafts: null, average: null, rows: [], competencies: [] });
    expect(JSON.stringify(model)).not.toContain('mine-draft');
  });

  it("shows a member none of a colleague's released review, even when handed it", () => {
    expect(buildScorecardModel([review({ employee_id: 'seed-emp-6' })], [], MEMBER).rows).toEqual([]);
  });

  it('shows an unlinked member nothing', () => {
    const model = buildScorecardModel([review({})], [], { employeeId: null, isHr: false, isDemo: false });
    expect(model.rows).toEqual([]);
  });

  it('is empty-safe', () => {
    const model = buildScorecardModel([], [], HR);
    expect(model.average).toBeNull();
    expect(model.highest).toBeNull();
    expect(model.competencies).toEqual([]);
    expect(model.rows).toEqual([]);
  });

  it('handles an old-shaped review with empty competencies: it counts in the score, adds no competency, shows no NaN', () => {
    const model = buildScorecardModel([review({ id: 'old', competencies: noScores, score: 4 })], [], HR);
    expect(model.average).toBe(4);
    expect(model.competencies).toEqual([]);
    expect(model.rows[0].competencies).toBe('');
    expect(JSON.stringify(model)).not.toMatch(/NaN|Infinity/);
    const draft = buildScorecardModel([draftOf({ competencies: noScores })], [], HR);
    expect(draft).toMatchObject({ scored: 0, drafts: 1, average: null });
  });
});

describe('buildReviewsModel', () => {
  it('counts the sample ratings of the released reviews as 3 exceeds, 11 meets, 4 below', async () => {
    const [reviews, employees] = await Promise.all([data.listReviews(), data.listEmployees()]);
    const model = buildReviewsModel(reviews, employees, DEMO);
    expect(model.team).toBe(true);
    expect(model.ratings).toEqual({ exceeds: 3, meets: 11, below: 4 });
    expect(model.scored).toBe(18);
    expect(model.drafts).toBe(2);
    expect(model.rows).toHaveLength(20);
    expect(model.rows[0].reviewed_at).not.toBeNull();
    expect(model.department_averages.reduce((total, d) => total + d.count, 0)).toBe(18);
    expect(model.average).toBeGreaterThan(3.5);
  });

  it('lists drafts first for a team viewer, marked, with the fields the edit form needs', async () => {
    const [reviews, employees] = await Promise.all([data.listReviews(), data.listEmployees()]);
    const model = buildReviewsModel(reviews, employees, HR);
    expect(model.rows.slice(0, 2).every((r) => r.draft && r.status === 'draft' && r.released_at === null)).toBe(true);
    expect(model.rows.slice(2).every((r) => !r.draft && r.status === 'released')).toBe(true);
    const draft = model.rows[0];
    expect(draft.employee_id).toMatch(/^seed-emp-/);
    expect(Object.keys(draft.competencies).sort()).toEqual(['Communication', 'Delivery', 'Ownership', 'Teamwork']);
    expect(draft.comment).toBeTruthy();
  });

  it('leaves a draft out of the ratings, the average and the counts', () => {
    const model = buildReviewsModel(
      [review({ id: 'a', score: 4, rating: 'meets' }), draftOf({ id: 'b', score: 5, rating: 'exceeds' })],
      [],
      HR,
    );
    expect(model.ratings).toEqual({ exceeds: 0, meets: 1, below: 0 });
    expect(model.average).toBe(4);
    expect(model.scored).toBe(1);
    expect(model.drafts).toBe(1);
  });

  it('carries no team figures for a member, only their own released review with its comment', async () => {
    const [reviews, employees] = await Promise.all([data.listReviews(), data.listEmployees()]);
    const model = buildReviewsModel(reviews, employees, MEMBER);
    expect(model.team).toBe(false);
    expect(model.ratings).toBeNull();
    expect(model.drafts).toBeNull();
    expect(model.department_averages).toEqual([]);
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({ employee_id: 'seed-emp-5', draft: false, status: 'released' });
    expect(model.rows[0].comment).toBeTruthy();
  });

  it('gives a member no row, no count and no figure from their own draft', () => {
    const model = buildReviewsModel([draftOf({ id: 'mine', comment: 'SECRET DRAFT COMMENT', score: 5 })], [], MEMBER);
    expect(model).toMatchObject({ scored: 0, drafts: null, average: null, rows: [] });
    expect(JSON.stringify(model)).not.toContain('SECRET DRAFT COMMENT');
  });

  it('is empty-safe', () => {
    const model = buildReviewsModel([], [], HR);
    expect(model.average).toBeNull();
    expect(model.ratings).toEqual({ exceeds: 0, meets: 0, below: 0 });
  });

  it('keeps a review with empty competencies, without NaN', () => {
    const model = buildReviewsModel([review({ competencies: noScores })], [], HR);
    expect(model.rows[0].competencies).toEqual({});
    expect(model.average).toBe(4);
    expect(JSON.stringify(model)).not.toMatch(/NaN|Infinity/);
  });
});

describe('buildTrainingModel', () => {
  it('counts courses by status, worked out from the dates, and enrolments for the team', async () => {
    const [trainings, enrolments] = await Promise.all([data.listTrainings(), data.listTrainingEnrolments()]);
    const model = buildTrainingModel(trainings, enrolments, HR, TODAY);
    expect(model.team).toBe(true);
    expect(model.by_status).toEqual({ upcoming: 2, in_progress: 1, completed: 2 });
    expect(model.team_stats?.enrolled).toBe(36);
    expect(model.team_stats?.completed).toBe(15);
    expect(model.rows.reduce((sum, r) => sum + (r.enrolled ?? 0), 0)).toBe(36);
    expect(model.rows[0].status).toBe('in_progress');
  });

  it("changes a course's status with the date it is given: the first day, the last day and the day after", () => {
    const course = [{ id: 't', title: 'Excel', category: null, provider: null, starts_on: '2026-10-10', ends_on: '2026-10-12' }];
    const statusOn = (today: string) => buildTrainingModel(course, [], HR, today).rows[0].status;
    expect([statusOn('2026-10-09'), statusOn('2026-10-10'), statusOn('2026-10-12'), statusOn('2026-10-13')]).toEqual([
      'upcoming', 'in_progress', 'in_progress', 'completed',
    ]);
  });

  it('never carries a headcount for a member, only their own enrolments', async () => {
    const [trainings, enrolments] = await Promise.all([data.listTrainings(), data.listTrainingEnrolments()]);
    const model = buildTrainingModel(trainings, enrolments, { ...MEMBER, employeeId: DEMO_EMPLOYEE_ID }, TODAY);
    expect(model.team).toBe(false);
    expect(model.team_stats).toBeNull();
    expect(model.rows.every((r) => r.enrolled === null && r.completed === null && r.people === null)).toBe(true);
    expect(model.rows.filter((r) => r.mine === 'completed')).toHaveLength(2);
    expect(model.rows.filter((r) => r.mine === 'enrolled')).toHaveLength(2);
    expect(model.rows.filter((r) => r.mine === null)).toHaveLength(1);
  });

  it('does not count anyone as the own enrolments of an unlinked member, and offers them no self-service', async () => {
    const [trainings, enrolments] = await Promise.all([data.listTrainings(), data.listTrainingEnrolments()]);
    const model = buildTrainingModel(trainings, enrolments, { employeeId: null, isHr: false, isDemo: false }, TODAY);
    expect(model.rows.every((r) => r.mine === null && !r.can_enrol && !r.can_withdraw)).toBe(true);
  });

  it('offers a member Enrol on a course that has not ended, and Withdraw only until it starts', () => {
    const courses = [
      { id: 'past', title: 'Past', category: null, provider: null, starts_on: '2026-10-01', ends_on: '2026-10-02' },
      { id: 'now', title: 'Now', category: null, provider: null, starts_on: '2026-10-08', ends_on: '2026-10-12' },
      { id: 'later', title: 'Later', category: null, provider: null, starts_on: '2026-10-20', ends_on: '2026-10-21' },
      { id: 'later-done', title: 'Later done', category: null, provider: null, starts_on: '2026-10-22', ends_on: '2026-10-23' },
    ];
    const mine = (training_id: string, completed = false) => ({
      id: `e-${training_id}`, employee_id: 'seed-emp-5', training_id, completed, completed_at: null,
    });
    const model = buildTrainingModel(courses, [mine('later'), mine('now'), mine('later-done', true)], MEMBER, TODAY);
    const row = (id: string) => model.rows.find((r) => r.id === id)!;
    expect(row('past')).toMatchObject({ can_enrol: false, can_withdraw: false });
    expect(row('now')).toMatchObject({ mine: 'enrolled', can_enrol: false, can_withdraw: false });
    expect(row('later')).toMatchObject({ mine: 'enrolled', can_enrol: false, can_withdraw: true });
    expect(row('later-done')).toMatchObject({ mine: 'completed', can_enrol: false, can_withdraw: false });
    const free = buildTrainingModel(courses, [], MEMBER, TODAY);
    expect(free.rows.find((r) => r.id === 'now')).toMatchObject({ can_enrol: true, can_withdraw: false });
    expect(free.rows.find((r) => r.id === 'past')).toMatchObject({ can_enrol: false });
  });

  it('offers nothing to self-serve in the demo', async () => {
    const [trainings, enrolments] = await Promise.all([data.listTrainings(), data.listTrainingEnrolments()]);
    const model = buildTrainingModel(trainings, enrolments, DEMO, TODAY);
    expect(model.rows.every((r) => !r.can_enrol && !r.can_withdraw)).toBe(true);
  });

  it('names who is enrolled for a team viewer, by name, with the completion time', async () => {
    const [trainings, enrolments, employees] = await Promise.all([
      data.listTrainings(), data.listTrainingEnrolments(), data.listEmployees(),
    ]);
    const model = buildTrainingModel(trainings, enrolments, HR, TODAY, employees);
    const done = model.rows.find((r) => r.status === 'completed')!;
    expect(done.people).toHaveLength(done.enrolled!);
    expect(done.people!.every((p) => p.name !== 'Unknown' && p.completed && p.completed_at !== null)).toBe(true);
    const names = done.people!.map((p) => p.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('is empty-safe and formats date ranges', () => {
    const model = buildTrainingModel([], [], HR, TODAY);
    expect(model.rows).toEqual([]);
    expect(model.team_stats?.enrolled).toBe(0);
    expect(dateRange(null, null)).toBe('—');
    expect(dateRange('2026-10-12', '2026-10-12')).toBe('12 Oct 2026');
    expect(dateRange('2026-10-12', '2026-10-15')).toBe('12 Oct – 15 Oct 2026');
    expect(dateRange('2026-12-30', '2027-01-02')).toBe('30 Dec 2026 – 02 Jan 2027');
  });
});
