import { beforeEach, describe, expect, it, vi } from 'vitest';

type Role = 'owner' | 'admin' | 'member' | 'viewer';
type Reply = { ok: true; data: unknown } | { ok: false; error: string };

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: false } as {
    userId: string;
    orgId: string;
    role: string;
    isDemo: boolean;
  },
  people: { employeeId: 'emp-own' as string | null, isHr: true, isDemo: false },
  client: { marker: 'the-signed-in-client' } as unknown,
  reply: null as null | { ok: false; error: string },
  ran: [] as { fn: string; orgId: string; client: unknown; input: unknown }[],
  revalidated: [] as string[],
  lookupFails: false,
  lookups: 0,
  clients: 0,
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    ctl.clients += 1;
    return ctl.client;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => ctl.revalidated.push(path) }));
vi.mock('@/lib/people/viewer', () => ({
  getPeopleViewer: async () => {
    ctl.lookups += 1;
    if (ctl.lookupFails) throw new Error('SECRET lookup failure');
    return ctl.people;
  },
}));

const record = (fn: string) => async (ctx: { orgId: string; client: unknown }, input?: unknown): Promise<Reply> => {
  ctl.ran.push({ fn, orgId: ctx.orgId, client: ctx.client, input });
  return ctl.reply ?? { ok: true, data: { id: 'x' } };
};
vi.mock('@/lib/people/performance-writes', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/performance-writes')>();
  return {
    ...actual,
    saveGoal: record('saveGoal'),
    deleteGoal: record('deleteGoal'),
    saveReview: record('saveReview'),
    releaseReview: record('releaseReview'),
    unreleaseReview: record('unreleaseReview'),
    deleteReview: record('deleteReview'),
    saveTraining: record('saveTraining'),
    deleteTraining: record('deleteTraining'),
    enrol: record('enrol'),
    unenrol: record('unenrol'),
    setTrainingCompleted: record('setTrainingCompleted'),
  };
});
vi.mock('@/lib/people/announcement-writes', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/announcement-writes')>();
  return {
    ...actual,
    saveAnnouncement: record('saveAnnouncement'),
    publishAnnouncement: record('publishAnnouncement'),
    unpublishAnnouncement: record('unpublishAnnouncement'),
    deleteAnnouncement: record('deleteAnnouncement'),
    markAnnouncementsRead: record('markAnnouncementsRead'),
  };
});

const performance = await import('@/app/(app)/people/performance-actions');
const announcements = await import('@/app/(app)/people/announcement-actions');
const { PEOPLE_PATHS } = await import('@/lib/people/paths');

const EMP = '22222222-2222-4222-8222-222222222222';
const GOAL = '11111111-1111-4111-8111-111111111111';
const REVIEW = '33333333-3333-4333-8333-333333333333';
const COURSE = '44444444-4444-4444-8444-444444444444';
const ANN = '55555555-5555-4555-8555-555555555555';
const FORBIDDEN = { ok: false, error: 'Only owners and admins can do that.' };
const NOT_LINKED = { ok: false, error: "Your account isn't linked to an employee record yet." };
const GENERIC = { ok: false, error: 'That change could not be saved. Please try again.' };
const SCORES = { Delivery: 4, Teamwork: 4, Ownership: 4, Communication: 4 };

type Action = (input?: unknown) => Promise<unknown>;

const OWN: [string, Action, unknown, string][] = [
  ['saveMyGoalAction', performance.saveMyGoalAction, { title: 'Ship', progress: 10 }, 'saveGoal'],
  ['deleteMyGoalAction', performance.deleteMyGoalAction, { goal_id: GOAL }, 'deleteGoal'],
  ['enrolMeAction', performance.enrolMeAction, { training_id: COURSE }, 'enrol'],
  ['withdrawMeAction', performance.withdrawMeAction, { training_id: COURSE }, 'unenrol'],
];
const ADMIN: [string, Action, unknown, string][] = [
  ['saveGoalForAction', performance.saveGoalForAction, { employee_id: EMP, title: 'Ship', progress: 10 }, 'saveGoal'],
  ['deleteGoalForAction', performance.deleteGoalForAction, { goal_id: GOAL }, 'deleteGoal'],
  ['saveReviewAction', performance.saveReviewAction, { employee_id: EMP, period: 'H1 2026', competencies: SCORES, rating: 'meets' }, 'saveReview'],
  ['releaseReviewAction', performance.releaseReviewAction, { review_id: REVIEW }, 'releaseReview'],
  ['unreleaseReviewAction', performance.unreleaseReviewAction, { review_id: REVIEW }, 'unreleaseReview'],
  ['deleteReviewAction', performance.deleteReviewAction, { review_id: REVIEW }, 'deleteReview'],
  ['saveTrainingAction', performance.saveTrainingAction, { title: 'Excel', starts_on: '2026-11-01', ends_on: '2026-11-02' }, 'saveTraining'],
  ['deleteTrainingAction', performance.deleteTrainingAction, { training_id: COURSE }, 'deleteTraining'],
  ['enrolAction', performance.enrolAction, { training_id: COURSE, employee_id: EMP }, 'enrol'],
  ['unenrolAction', performance.unenrolAction, { training_id: COURSE, employee_id: EMP }, 'unenrol'],
  ['setTrainingCompletedAction', performance.setTrainingCompletedAction, { training_id: COURSE, employee_id: EMP, completed: true }, 'setTrainingCompleted'],
  ['saveAnnouncementAction', announcements.saveAnnouncementAction, { title: 'Hi', body: '', category: 'general' }, 'saveAnnouncement'],
  ['publishAnnouncementAction', announcements.publishAnnouncementAction, { announcement_id: ANN }, 'publishAnnouncement'],
  ['unpublishAnnouncementAction', announcements.unpublishAnnouncementAction, { announcement_id: ANN }, 'unpublishAnnouncement'],
  ['deleteAnnouncementAction', announcements.deleteAnnouncementAction, { announcement_id: ANN }, 'deleteAnnouncement'],
];

const as = (role: Role, linked = true) => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role, isDemo: false };
  ctl.people = { employeeId: linked ? 'emp-own' : null, isHr: role === 'owner' || role === 'admin', isDemo: false };
};

beforeEach(() => {
  as('owner');
  ctl.reply = null;
  ctl.ran = [];
  ctl.revalidated = [];
  ctl.lookupFails = false;
  ctl.lookups = 0;
  ctl.clients = 0;
});

describe("a member's own goals and enrolment", () => {
  it.each(['owner', 'admin', 'member', 'viewer'] as Role[])('are open to a linked %s', async (role) => {
    as(role);
    for (const [name, action, input] of OWN) {
      expect(((await action(input)) as { ok: boolean }).ok, name).toBe(true);
    }
    expect(ctl.ran.map((r) => r.fn)).toEqual(['saveGoal', 'deleteGoal', 'enrol', 'unenrol']);
  });

  it('take the employee from the viewer and the workspace from the session, whatever the input says', async () => {
    as('member');
    await performance.saveMyGoalAction({ title: 'Ship', progress: 10, employee_id: EMP, org_id: 'someone-else' });
    await performance.enrolMeAction({ training_id: COURSE, employee_id: EMP, org_id: 'someone-else' });
    await performance.withdrawMeAction({ training_id: COURSE, employee_id: EMP });
    expect(ctl.ran).toEqual([
      { fn: 'saveGoal', orgId: 'org1', client: ctl.client, input: { title: 'Ship', progress: 10, org_id: 'someone-else', employee_id: 'emp-own' } },
      { fn: 'enrol', orgId: 'org1', client: ctl.client, input: { training_id: COURSE, org_id: 'someone-else', employee_id: 'emp-own' } },
      { fn: 'unenrol', orgId: 'org1', client: ctl.client, input: { training_id: COURSE, employee_id: 'emp-own' } },
    ]);
  });

  it('still take the linked employee when the input is not an object', async () => {
    as('member');
    for (const junk of ['nonsense', null, undefined, 7, ['employee_id']]) {
      await performance.saveMyGoalAction(junk);
      await performance.enrolMeAction(junk);
    }
    expect(ctl.ran.every((r) => (r.input as { employee_id: string }).employee_id === 'emp-own')).toBe(true);
    expect(ctl.ran).toHaveLength(10);
  });

  it('refuse an account that is linked to no employee, before touching the database function', async () => {
    as('member', false);
    for (const [name, action, input] of OWN) expect(await action(input), name).toEqual(NOT_LINKED);
    expect(ctl.ran).toEqual([]);
  });

  it('refuse the demo, whatever the role, before any read', async () => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true };
    for (const [name, action, input] of OWN) {
      const result = (await action(input)) as { ok: boolean; error: string };
      expect(result.ok, name).toBe(false);
      expect(result.error).toMatch(/read-only/);
    }
    expect(ctl.ran).toEqual([]);
    expect(ctl.lookups).toBe(0);
  });

  it('refuse a real account whose current workspace is the demo', async () => {
    as('owner');
    ctl.people = { employeeId: 'emp-own', isHr: true, isDemo: true };
    for (const [name, action, input] of OWN) {
      expect(((await action(input)) as { ok: boolean }).ok, name).toBe(false);
    }
    expect(ctl.ran).toEqual([]);
  });

  it('answer a failed lookup generically, without logging its text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.lookupFails = true;
    expect(await performance.saveMyGoalAction({ title: 'x', progress: 1 })).toEqual(GENERIC);
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
    log.mockRestore();
  });

  it('pass the write path refusal on as it is, and revalidate nothing', async () => {
    as('member');
    ctl.reply = { ok: false, error: 'That course has ended.' };
    expect(await performance.enrolMeAction({ training_id: COURSE })).toEqual({ ok: false, error: 'That course has ended.' });
    expect(ctl.revalidated).toEqual([]);
  });

  it('revalidate the Lekiu pages after a change', async () => {
    as('member');
    await performance.saveMyGoalAction({ title: 'Ship', progress: 10 });
    expect(ctl.revalidated).toEqual(PEOPLE_PATHS);
    expect(ctl.revalidated).toContain('/people/my-goals');
    expect(ctl.revalidated).toContain('/people/training');
  });
});

describe('the owner and admin actions', () => {
  it.each(['owner', 'admin'] as Role[])('run for an %s with the session workspace and the signed-in client', async (role) => {
    as(role);
    for (const [name, action, input] of ADMIN) {
      expect(((await action(input)) as { ok: boolean }).ok, name).toBe(true);
    }
    expect(ctl.ran.map((r) => r.fn)).toEqual(ADMIN.map(([, , , fn]) => fn));
    expect(ctl.ran.every((r) => r.orgId === 'org1' && r.client === ctl.client)).toBe(true);
  });

  it('pass the input to the write path untouched, so a goal for someone else keeps its employee', async () => {
    await performance.saveGoalForAction({ employee_id: EMP, title: 'Ship', progress: 10 });
    expect(ctl.ran[0].input).toEqual({ employee_id: EMP, title: 'Ship', progress: 10 });
  });

  it.each(['member', 'viewer'] as Role[])('refuse a %s before any read at all', async (role) => {
    as(role);
    for (const [name, action, input] of ADMIN) expect(await action(input), name).toEqual(FORBIDDEN);
    expect(ctl.ran).toEqual([]);
    expect(ctl.lookups).toBe(0);
    expect(ctl.clients).toBe(0);
  });

  it('refuse the demo before any read, and say it is read-only', async () => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true };
    for (const [name, action, input] of ADMIN) {
      const result = (await action(input)) as { ok: boolean; error: string };
      expect(result.ok, name).toBe(false);
      expect(result.error, name).toMatch(/read-only/);
    }
    expect(ctl.ran).toEqual([]);
    expect(ctl.lookups).toBe(0);
    expect(ctl.clients).toBe(0);
  });

  it('refuse an owner whose current workspace is the demo', async () => {
    ctl.people = { employeeId: null, isHr: true, isDemo: true };
    for (const [name, action, input] of ADMIN) expect(((await action(input)) as { ok: boolean }).ok, name).toBe(false);
    expect(ctl.ran).toEqual([]);
  });

  it('answer a failed lookup generically', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.lookupFails = true;
    expect(await performance.releaseReviewAction({ review_id: REVIEW })).toEqual(GENERIC);
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
    log.mockRestore();
  });

  it('revalidate the Lekiu pages after a change, and nothing after a refusal', async () => {
    await performance.releaseReviewAction({ review_id: REVIEW });
    expect(ctl.revalidated).toEqual(PEOPLE_PATHS);
    expect(ctl.revalidated).toContain('/people/review-scores');
    expect(ctl.revalidated).toContain('/people/scorecard');
    ctl.revalidated = [];
    ctl.reply = { ok: false, error: 'No.' };
    expect(await performance.releaseReviewAction({ review_id: REVIEW })).toEqual({ ok: false, error: 'No.' });
    expect(ctl.revalidated).toEqual([]);
  });

  it('revalidate the Announcements page after an announcement change', async () => {
    await announcements.publishAnnouncementAction({ announcement_id: ANN });
    expect(ctl.revalidated).toContain('/people/announcements');
  });
});

describe('markAnnouncementsReadAction', () => {
  it.each(['owner', 'admin', 'member', 'viewer'] as Role[])('is open to a %s and needs no employee record', async (role) => {
    as(role, false);
    expect(((await announcements.markAnnouncementsReadAction()) as { ok: boolean }).ok).toBe(true);
    expect(ctl.ran).toEqual([{ fn: 'markAnnouncementsRead', orgId: 'org1', client: ctl.client, input: undefined }]);
    expect(ctl.revalidated).toContain('/people/announcements');
  });

  it('is refused in the demo, without a read', async () => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true };
    const result = (await announcements.markAnnouncementsReadAction()) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/read-only/);
    expect(ctl.ran).toEqual([]);
    expect(ctl.lookups).toBe(0);
  });

  it('is refused for a real account in the demo workspace', async () => {
    ctl.people = { employeeId: null, isHr: false, isDemo: true };
    expect(((await announcements.markAnnouncementsReadAction()) as { ok: boolean }).ok).toBe(false);
    expect(ctl.ran).toEqual([]);
  });
});
