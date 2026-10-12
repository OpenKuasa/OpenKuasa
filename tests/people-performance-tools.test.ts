import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeopleData, PeopleViewer, Review } from '@/lib/people/types';
import type { SavedAnnouncement } from '@/lib/people/announcement-writes';
import type { SavedGoal, SavedReview, SavedTraining } from '@/lib/people/performance-writes';

const ctl = vi.hoisted(() => ({
  ran: [] as { fn: string; orgId: string; input: unknown }[],
  fail: null as string | null,
}));

const ME = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const GOAL = '44444444-4444-4444-8444-444444444441';
const REVIEW = '44444444-4444-4444-8444-444444444442';
const COURSE = '44444444-4444-4444-8444-444444444443';
const ANNOUNCEMENT = '44444444-4444-4444-8444-444444444444';

// Every write is replaced by a recorder; the input schemas stay real. Typed, so a field the write path adds to a
// result and the tool drops fails to compile here.
vi.mock('@/lib/people/performance-writes', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/performance-writes')>();
  const record =
    <T>(fn: string, reply: (input: Record<string, unknown>) => T) =>
    async (ctx: { orgId: string }, input: Record<string, unknown>) => {
      ctl.ran.push({ fn, orgId: ctx.orgId, input });
      if (ctl.fail === 'throw') throw new Error('secret reason: Learn SQL');
      if (ctl.fail) return { ok: false as const, error: ctl.fail };
      return { ok: true as const, data: reply(input) };
    };
  const review = (input: Record<string, unknown>, status: 'draft' | 'released'): SavedReview => ({
    id: REVIEW,
    employee_id: (input.employee_id as string | undefined) ?? ME,
    period: (input.period as string | undefined) ?? 'H1 2026',
    competencies: { Delivery: 4, Teamwork: 4.5, Ownership: 3, Communication: 5 },
    score: 4.13,
    rating: 'meets',
    comment: 'Steady quarter.',
    status,
    released_at: status === 'released' ? '2026-10-09T04:00:00+00:00' : null,
    reviewer_name: 'Kavitha',
    reviewed_at: '2026-10-09',
  });
  return {
    ...actual,
    saveGoal: record('saveGoal', (input): SavedGoal => ({
      id: GOAL,
      employee_id: input.employee_id as string,
      title: input.title as string,
      progress: input.progress as number,
      due_date: (input.due_date as string | null) ?? null,
      status: 'on_track',
    })),
    deleteGoal: record('deleteGoal', () => ({ id: GOAL, employee_id: ME })),
    saveReview: record('saveReview', (input) => review(input, 'draft')),
    releaseReview: record('releaseReview', (input) => review(input, 'released')),
    deleteReview: record('deleteReview', () => ({ id: REVIEW, employee_id: ME })),
    saveTraining: record('saveTraining', (input): SavedTraining => ({
      id: COURSE,
      title: input.title as string,
      category: (input.category as string | null) ?? null,
      provider: (input.provider as string | null) ?? null,
      starts_on: input.starts_on as string,
      ends_on: input.ends_on as string,
    })),
    deleteTraining: record('deleteTraining', () => ({ id: COURSE })),
    enrol: record('enrol', (input) => ({ training_id: input.training_id as string, employee_id: input.employee_id as string, completed: false })),
    unenrol: record('unenrol', (input) => ({ training_id: input.training_id as string, employee_id: input.employee_id as string })),
    setTrainingCompleted: record('setTrainingCompleted', (input) => ({
      training_id: input.training_id as string,
      employee_id: input.employee_id as string,
      completed: input.completed as boolean,
    })),
  };
});

vi.mock('@/lib/people/announcement-writes', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/announcement-writes')>();
  const record =
    <T>(fn: string, reply: (input: Record<string, unknown>) => T) =>
    async (ctx: { orgId: string }, input: Record<string, unknown>) => {
      ctl.ran.push({ fn, orgId: ctx.orgId, input });
      if (ctl.fail === 'throw') throw new Error('secret reason: Cuti Deepavali');
      if (ctl.fail) return { ok: false as const, error: ctl.fail };
      return { ok: true as const, data: reply(input) };
    };
  const saved = (status: 'draft' | 'published', input: Record<string, unknown> = {}): SavedAnnouncement => ({
    id: ANNOUNCEMENT,
    title: (input.title as string | undefined) ?? 'Cuti Deepavali',
    body: (input.body as string | undefined) ?? 'Pejabat tutup.',
    category: 'holiday',
    status,
    published_at: status === 'published' ? '2026-10-09T04:00:00+00:00' : null,
    edited_at: null,
    author_name: status === 'published' ? 'Kavitha' : null,
  });
  return {
    ...actual,
    saveAnnouncement: record('saveAnnouncement', (input) => saved(input.publish === true ? 'published' : 'draft', input)),
    publishAnnouncement: record('publishAnnouncement', () => saved('published')),
    unpublishAnnouncement: record('unpublishAnnouncement', () => saved('draft')),
    deleteAnnouncement: record('deleteAnnouncement', () => ({ id: ANNOUNCEMENT })),
  };
});

const { PEOPLE_TOOL_NAMES, createPeopleTools } = await import('@/lib/ai/people-tools');
const { PEOPLE_WRITE_TOOL_NAMES, combineToolkits, peopleProduct } = await import('@/lib/ai/products');
const { createSeedPeopleData } = await import('@/lib/people/seed');
const { toolMeta } = await import('@/components/chat/tool-parts');
const { approvalTitle, nameIn } = await import('@/lib/chat/change-titles');

// A Friday in Kuala Lumpur, 12:00.
const NOW = new Date('2026-10-09T04:00:00Z');
const base = createSeedPeopleData(NOW);
const HR_VIEWER: PeopleViewer = { employeeId: null, isHr: true, isDemo: false };
const HR_LINKED: PeopleViewer = { employeeId: ME, employeeName: 'Faiz Hakim', isHr: true, isDemo: false };
const MEMBER: PeopleViewer = { employeeId: ME, employeeName: 'Faiz Hakim', isHr: false, isDemo: false };
const UNLINKED: PeopleViewer = { employeeId: null, isHr: false, isDemo: false };
const DEMO: PeopleViewer = { employeeId: ME, isHr: false, isDemo: true };

const hr = (employeeId: string | null = null) => ({ ctx: { client: {} as never, orgId: 'org-1' }, tier: 'hr' as const, employeeId, receipt: null, userId: 'u1' });
const self = (employeeId: string | null = ME) => ({ ctx: { client: {} as never, orgId: 'org-1' }, tier: 'self' as const, employeeId, receipt: null, userId: 'u1' });
type Write = ReturnType<typeof hr> | ReturnType<typeof self>;

const OWN = ['saveGoal', 'removeGoal', 'enrolInTraining', 'withdrawFromTraining'];
const HR_ONLY = [
  'saveReview', 'deleteReview', 'releaseReview', 'saveTraining', 'removeTraining', 'setTrainingCompleted',
  'saveAnnouncement', 'removeAnnouncement', 'publishAnnouncement', 'unpublishAnnouncement',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const tools = (viewer: PeopleViewer, write?: Write, data: PeopleData = base, now: Date = NOW) => createPeopleTools(data, viewer, now, write);
const run = (
  name: string,
  input: Record<string, unknown>,
  viewer: PeopleViewer = HR_VIEWER,
  write: Write | null = hr(),
  data: PeopleData = base,
  now: Date = NOW,
): Promise<Loose> =>
  (tools(viewer, write ?? undefined, data, now)[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 't',
    messages: [],
  });
const schemaOf = (name: string, viewer: PeopleViewer = HR_VIEWER, write: Write | undefined = hr()) =>
  (tools(viewer, write)[name] as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean; data?: Record<string, unknown> }; shape: Record<string, unknown> } }).inputSchema;

const template = (await base.listEmployees())[0];
const review = (over: Partial<Review>): Review => ({
  id: 'r',
  employee_id: ME,
  employee_name: 'Faiz Hakim',
  period: 'H1 2026',
  competencies: { Delivery: 4, Teamwork: 4.5, Ownership: 3, Communication: 5 },
  rating: 'meets',
  score: 4.13,
  comment: 'Solid year.',
  status: 'released',
  released_at: '2026-07-01T00:00:00+00:00',
  reviewer_name: 'Kavitha',
  reviewed_at: '2026-06-30',
  ...over,
});
const fixture: PeopleData = {
  ...base,
  listEmployees: async () => [
    { ...template, id: ME, name: 'Faiz Hakim' },
    { ...template, id: OTHER, name: 'Aisyah Rahim' },
  ],
  listGoals: async () => [
    { id: 'g-mine', employee_id: ME, employee_name: 'Faiz Hakim', title: 'Learn SQL', progress: 40, due_date: '2026-12-31', status: 'on_track' },
    { id: 'g-other', employee_id: OTHER, employee_name: 'Aisyah Rahim', title: 'Run the audit', progress: 100, due_date: null, status: 'done' },
  ],
  listReviews: async () => [
    review({ id: 'r-mine', comment: 'Solid year.' }),
    review({ id: 'r-draft', period: 'H2 2026', status: 'draft', released_at: null, comment: 'SECRET DRAFT COMMENT', score: 2.5 }),
    review({ id: 'r-other', employee_id: OTHER, employee_name: 'Aisyah Rahim', comment: 'COLLEAGUE COMMENT' }),
    review({ id: 'r-old', period: 'FY 2025', competencies: {} as never, score: Number.NaN }),
  ],
  listTrainings: async () => [
    { id: 'c-upcoming', title: 'Upcoming course', category: 'Safety', provider: 'NIOSH', starts_on: '2026-11-10', ends_on: '2026-11-11', status: 'completed' } as never,
    { id: 'c-running', title: 'Running course', category: null, provider: null, starts_on: '2026-10-08', ends_on: '2026-10-12' },
    { id: 'c-ended', title: 'Ended course', category: null, provider: null, starts_on: '2026-09-01', ends_on: '2026-09-02' },
    { id: 'c-today', title: 'Starts today', category: null, provider: null, starts_on: '2026-10-09', ends_on: '2026-10-09' },
  ],
  listTrainingEnrolments: async () => [
    { id: 'e1', employee_id: ME, training_id: 'c-upcoming', completed: false, completed_at: null },
    { id: 'e2', employee_id: ME, training_id: 'c-ended', completed: true, completed_at: '2026-09-02T00:00:00+00:00' },
    { id: 'e3', employee_id: OTHER, training_id: 'c-upcoming', completed: false, completed_at: null },
    { id: 'e4', employee_id: OTHER, training_id: 'c-running', completed: false, completed_at: null },
  ],
  listAnnouncements: async () => [
    { id: 'a-new', title: 'New notice', body: 'Read me', category: 'general', status: 'published', published_at: '2026-10-08T01:00:00+00:00', author_name: 'Kavitha', edited_at: null, unread: true },
    { id: 'a-read', title: 'Old notice', body: 'Read already', category: 'general', status: 'published', published_at: '2026-09-01T01:00:00+00:00', author_name: 'Kavitha', edited_at: null, unread: false },
    { id: 'a-draft', title: 'SECRET DRAFT TITLE', body: 'SECRET DRAFT BODY', category: 'policy', status: 'draft', published_at: null, author_name: null, edited_at: null, unread: true },
  ],
};

beforeEach(() => {
  ctl.ran = [];
  ctl.fail = null;
});

describe('who holds the performance tools', () => {
  it('an owner or admin holds all fourteen, whether or not their own account is linked', () => {
    for (const [viewer, write] of [[HR_VIEWER, hr(null)], [HR_LINKED, hr(ME)]] as const) {
      const held = Object.keys(tools(viewer, write));
      for (const name of [...OWN, ...HR_ONLY]) expect(held, name).toContain(name);
    }
  });

  it('a linked member holds the four own-record tools and nothing else here', () => {
    const held = Object.keys(tools(MEMBER, self()));
    for (const name of OWN) expect(held, name).toContain(name);
    for (const name of HR_ONLY) expect(held, name).not.toContain(name);
  });

  it('an unlinked member, anyone without write access and nobody in the demo holds none: absent, not disabled', () => {
    for (const [viewer, write] of [
      [UNLINKED, self(null)],
      [MEMBER, undefined],
      [HR_VIEWER, undefined],
      [{ ...HR_LINKED, isDemo: true }, hr(ME)],
      [DEMO, self(ME)],
    ] as const) {
      const held = Object.keys(tools(viewer, write));
      for (const name of [...OWN, ...HR_ONLY]) expect(held, name).not.toContain(name);
    }
    expect(Object.keys(tools(DEMO))).toEqual([...PEOPLE_TOOL_NAMES]);
  });

  it('there is no tool for pulling a review back to draft', () => {
    const held = Object.keys(tools(HR_LINKED, hr(ME)));
    for (const name of held.filter((n) => /Review/.test(n))) expect(name, name).not.toMatch(/unrelease|pull|draft|revert|withdraw/i);
    expect(PEOPLE_WRITE_TOOL_NAMES.filter((n) => /Review/.test(n)).sort()).toEqual(['deleteReview', 'releaseReview', 'saveReview']);
    for (const name of ['unreleaseReview', 'pullBackReview', 'revertReview']) expect(held).not.toContain(name);
    for (const name of ['saveReview', 'releaseReview', 'deleteReview']) {
      const description = (tools(HR_LINKED, hr(ME))[name] as unknown as { description: string }).description;
      expect(description, name).not.toMatch(/pull(s|ing)? (it )?back|back to (a )?draft|unrelease/i);
    }
  });

  it('every change waits for approval, is in the write list, and the lookups do not', () => {
    const kit = peopleProduct({ data: base, viewer: HR_LINKED, write: hr(ME) });
    const { toolApproval } = combineToolkits([kit]);
    for (const name of [...OWN, ...HR_ONLY]) {
      expect(PEOPLE_WRITE_TOOL_NAMES, name).toContain(name);
      expect(kit.write, name).toHaveProperty(name);
      expect(toolApproval?.[name], name).toBe('user-approval');
    }
    for (const name of ['listGoals', 'listReviews', 'listTrainings', 'listAnnouncements', 'getPerformanceSummary']) {
      expect(kit.read).toHaveProperty(name);
      expect(toolApproval?.[name]).toBeUndefined();
    }
    const memberKit = peopleProduct({ data: base, viewer: MEMBER, write: self() });
    for (const name of OWN) expect(combineToolkits([memberKit]).toolApproval?.[name], name).toBe('user-approval');
  });

  it('the change tools show on a card as changes, the lookups with named cards', () => {
    for (const name of [...OWN, ...HR_ONLY]) expect(toolMeta(name).isFallback, name).toBe(true);
    for (const name of ['listGoals', 'listReviews']) expect(toolMeta(name).isFallback, name).toBe(false);
  });

  it('a member’s schemas for the own-record tools have no employee field at all, an owner’s have one', () => {
    for (const name of ['saveGoal', 'enrolInTraining', 'withdrawFromTraining']) {
      expect(Object.keys(schemaOf(name, MEMBER, self()).shape), name).not.toContain('employee_id');
      expect(Object.keys(schemaOf(name).shape), name).toContain('employee_id');
    }
    expect(Object.keys(schemaOf('removeGoal', MEMBER, self()).shape)).toEqual(['goal_id']);
  });
});

describe('saveGoal', () => {
  const add = { title: 'Learn SQL', progress: 40 };

  it('a member’s goal is for their own employee, from the viewer, whatever the model sends', async () => {
    const result = await run('saveGoal', { ...add, employee_id: OTHER, due_date: '', at_risk: null }, MEMBER, self());
    expect(ctl.ran).toEqual([
      { fn: 'saveGoal', orgId: 'org-1', input: { employee_id: ME, goal_id: null, title: 'Learn SQL', progress: 40, due_date: null, at_risk: false } },
    ]);
    expect(result).toMatchObject({ ok: true, data: { id: GOAL, employee_id: ME, title: 'Learn SQL', progress: 40, status: 'on_track' } });
  });

  it('the schema of a member drops an employee id the model sends; an owner’s keeps it', () => {
    expect(schemaOf('saveGoal', MEMBER, self()).safeParse({ ...add, employee_id: OTHER }).data).toEqual({ title: 'Learn SQL', progress: 40 });
    expect(schemaOf('saveGoal').safeParse({ ...add, employee_id: OTHER }).data).toMatchObject({ employee_id: OTHER });
  });

  it('an owner or admin names the employee by id; an empty one means their own linked record', async () => {
    await run('saveGoal', { ...add, employee_id: OTHER }, HR_LINKED, hr(ME));
    await run('saveGoal', { ...add, employee_id: '' }, HR_LINKED, hr(ME));
    await run('saveGoal', { ...add, employee_id: null }, HR_LINKED, hr(ME));
    await run('saveGoal', { ...add, employee_id: '   ' }, HR_LINKED, hr(ME));
    expect(ctl.ran.map((r) => (r.input as { employee_id: string }).employee_id)).toEqual([OTHER, ME, ME, ME]);
  });

  it('an owner with no employee record and no employee named is told to say which, and nothing is called', async () => {
    for (const employee_id of [undefined, null, '']) {
      expect(await run('saveGoal', { ...add, employee_id }, HR_VIEWER, hr(null))).toEqual({
        ok: false,
        error: 'Say which employee this is for. Your own account is not linked to an employee record.',
      });
    }
    expect(ctl.ran).toEqual([]);
  });

  it('normalises: the title is trimmed, an empty or missing goal id adds, a real one changes, an empty due date is none', async () => {
    for (const goal_id of ['', '  ', null, undefined]) await run('saveGoal', { ...add, title: '  Learn SQL  ', goal_id, due_date: '  ' }, MEMBER, self());
    expect(ctl.ran.map((r) => r.input)).toEqual(
      Array(4).fill({ employee_id: ME, goal_id: null, title: 'Learn SQL', progress: 40, due_date: null, at_risk: false }),
    );
    ctl.ran = [];
    await run('saveGoal', { ...add, goal_id: ` ${GOAL} `, due_date: '2026-12-31', at_risk: true }, MEMBER, self());
    expect(ctl.ran[0].input).toEqual({ employee_id: ME, goal_id: GOAL, title: 'Learn SQL', progress: 40, due_date: '2026-12-31', at_risk: true });
  });

  it('refuses what cannot be read at the schema: no title, a long one, bad progress, bad dates, wrong types, a bad goal id', () => {
    const schema = schemaOf('saveGoal', MEMBER, self());
    expect(schema.safeParse(add).success).toBe(true);
    expect(schema.safeParse({ ...add, due_date: '', goal_id: '', at_risk: null }).success).toBe(true);
    for (const bad of [
      { ...add, title: '   ' },
      { ...add, title: 'x'.repeat(201) },
      { ...add, progress: -1 },
      { ...add, progress: 101 },
      { ...add, progress: 40.5 },
      { ...add, progress: '40' },
      { ...add, progress: null },
      { ...add, due_date: '31/12/2026' },
      { ...add, due_date: '2026-02-30' },
      { ...add, due_date: '1999-12-31' },
      { ...add, due_date: 5 },
      { ...add, at_risk: 'yes' },
      { ...add, goal_id: 'not-an-id' },
      { progress: 40 },
    ]) {
      expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('passes a refusal on as its sentence, and a crash becomes a plain refusal that never logs the title', async () => {
    ctl.fail = 'That is 30 open goals already. Finish or remove one first.';
    expect(await run('saveGoal', add, MEMBER, self())).toEqual({ ok: false, error: ctl.fail });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.fail = 'throw';
    expect(await run('saveGoal', add, MEMBER, self())).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Learn SQL');
    log.mockRestore();
  });

  it('names the person in the answer, from the directory', async () => {
    const result = await run('saveGoal', add, MEMBER, self(), fixture);
    expect(result.data.employee).toBe('Faiz Hakim');
  });
});

describe('removeGoal, enrolInTraining and withdrawFromTraining', () => {
  it('remove the goal named, for a member and an owner alike', async () => {
    expect(await run('removeGoal', { goal_id: GOAL }, MEMBER, self())).toEqual({ ok: true, data: { id: GOAL, employee_id: ME, removed: true } });
    await run('removeGoal', { goal_id: GOAL });
    expect(ctl.ran.map((r) => r.input)).toEqual([{ goal_id: GOAL }, { goal_id: GOAL }]);
    expect(schemaOf('removeGoal', MEMBER, self()).safeParse({ goal_id: '' }).success).toBe(false);
    expect(schemaOf('removeGoal', MEMBER, self()).safeParse({ goal_id: GOAL, employee_id: OTHER }).data).toEqual({ goal_id: GOAL });
  });

  it('a member enrols and withdraws themselves only, whatever employee the model sends', async () => {
    await run('enrolInTraining', { training_id: COURSE, employee_id: OTHER }, MEMBER, self(), fixture);
    await run('withdrawFromTraining', { training_id: COURSE, employee_id: OTHER }, MEMBER, self(), fixture);
    expect(ctl.ran).toEqual([
      { fn: 'enrol', orgId: 'org-1', input: { training_id: COURSE, employee_id: ME } },
      { fn: 'unenrol', orgId: 'org-1', input: { training_id: COURSE, employee_id: ME } },
    ]);
  });

  it('an owner names the employee by id; empty means their own record; none at all is refused', async () => {
    await run('enrolInTraining', { training_id: COURSE, employee_id: OTHER }, HR_LINKED, hr(ME));
    await run('enrolInTraining', { training_id: COURSE, employee_id: '' }, HR_LINKED, hr(ME));
    await run('withdrawFromTraining', { training_id: COURSE, employee_id: OTHER }, HR_LINKED, hr(ME));
    expect(ctl.ran.map((r) => (r.input as { employee_id: string }).employee_id)).toEqual([OTHER, ME, OTHER]);
    ctl.ran = [];
    expect(await run('enrolInTraining', { training_id: COURSE }, HR_VIEWER, hr(null))).toMatchObject({ ok: false });
    expect(ctl.ran).toEqual([]);
  });

  it('answers with the person and whether they are now enrolled', async () => {
    expect((await run('enrolInTraining', { training_id: COURSE }, MEMBER, self(), fixture)).data).toEqual({
      training_id: COURSE, employee_id: ME, completed: false, enrolled: true, employee: 'Faiz Hakim',
    });
    expect((await run('withdrawFromTraining', { training_id: COURSE }, MEMBER, self(), fixture)).data).toEqual({
      training_id: COURSE, employee_id: ME, enrolled: false, employee: 'Faiz Hakim',
    });
  });

  it('refuses a course id that is empty or not an id, at the schema', () => {
    for (const name of ['enrolInTraining', 'withdrawFromTraining']) {
      expect(schemaOf(name, MEMBER, self()).safeParse({ training_id: '' }).success, name).toBe(false);
      expect(schemaOf(name, MEMBER, self()).safeParse({ training_id: 'c-upcoming' }).success, name).toBe(false);
      expect(schemaOf(name, MEMBER, self()).safeParse({ training_id: COURSE, employee_id: OTHER }).data, name).toEqual({ training_id: COURSE });
    }
  });
});

describe('saveReview', () => {
  const write = { employee_id: OTHER, period: 'h1 2026', delivery: '4', teamwork: 4.5, ownership: ' 3 ', communication: 5, rating: 'meets', comment: ' Steady quarter. ' };

  it('normalises the period, each score and the comment, then writes the draft and answers with the database’s own score', async () => {
    const result = await run('saveReview', write);
    expect(ctl.ran).toEqual([
      {
        fn: 'saveReview',
        orgId: 'org-1',
        input: {
          employee_id: OTHER, review_id: null, period: 'H1 2026',
          competencies: { Delivery: 4, Teamwork: 4.5, Ownership: 3, Communication: 5 }, rating: 'meets', comment: 'Steady quarter.',
        },
      },
    ]);
    expect(result.data).toMatchObject({
      id: REVIEW, period: 'H1 2026', scores: { Delivery: 4, Teamwork: 4.5, Ownership: 3, Communication: 5 },
      rating: 'meets', score: 4.13, comment: 'Steady quarter.', status: 'draft',
    });
    expect(result.data.message).toBe('This is a draft: the employee cannot see it yet.');
  });

  it('an empty or missing comment is none, and an empty review id writes a new one', async () => {
    for (const comment of ['', '  ', null, undefined]) await run('saveReview', { ...write, comment, review_id: '' });
    expect(ctl.ran.map((r) => (r.input as { comment: unknown }).comment)).toEqual([null, null, null, null]);
    expect(ctl.ran.map((r) => (r.input as { review_id: unknown }).review_id)).toEqual([null, null, null, null]);
    ctl.ran = [];
    await run('saveReview', { ...write, review_id: REVIEW });
    expect(ctl.ran[0].input).toMatchObject({ review_id: REVIEW });
  });

  it('refuses a missing or unreadable score, period or rating at the schema, before any card or call', () => {
    const schema = schemaOf('saveReview');
    expect(schema.safeParse(write).success).toBe(true);
    for (const bad of [
      { ...write, delivery: undefined },
      { ...write, teamwork: null },
      { ...write, ownership: '' },
      { ...write, communication: 5.5 },
      { ...write, delivery: 0.5 },
      { ...write, delivery: '4.7' },
      { ...write, delivery: '4.0' },
      { ...write, delivery: 'four' },
      { ...write, delivery: true },
      { ...write, period: '' },
      { ...write, period: 'next year' },
      { ...write, period: 'H3 2026' },
      { ...write, period: 'H1 1999' },
      { ...write, rating: 'great' },
      { ...write, rating: undefined },
      { ...write, comment: 'x'.repeat(2001) },
      { ...write, employee_id: '' },
      { ...write, employee_id: 'Aisyah' },
      { ...write, review_id: 'not-an-id' },
    ]) {
      expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('accepts the spellings of a period the card also reads, and drops extra arguments', () => {
    const parsed = schemaOf('saveReview').safeParse({ ...write, period: 'FY2026', released: true, status: 'released', score: 5 });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('released');
    expect(parsed.data).not.toHaveProperty('status');
    expect(parsed.data).not.toHaveProperty('score');
  });

  it('is for the hr tier only: a member’s toolset has none, and no schema takes a score for the whole', () => {
    expect(Object.keys(tools(MEMBER, self()))).not.toContain('saveReview');
    expect(Object.keys(schemaOf('saveReview').shape).sort()).toEqual(
      ['comment', 'communication', 'delivery', 'employee_id', 'ownership', 'period', 'rating', 'review_id', 'teamwork'].sort(),
    );
  });

  it('passes a refusal on as its sentence', async () => {
    ctl.fail = 'There is already a review for that period.';
    expect(await run('saveReview', write)).toEqual({ ok: false, error: ctl.fail });
  });
});

describe('releaseReview and deleteReview', () => {
  it('release the review named and answer in full, with the database’s score and that the employee can see it', async () => {
    const result = await run('releaseReview', { review_id: REVIEW });
    expect(ctl.ran).toEqual([{ fn: 'releaseReview', orgId: 'org-1', input: { review_id: REVIEW } }]);
    expect(result.data).toMatchObject({ id: REVIEW, status: 'released', score: 4.13, comment: 'Steady quarter.' });
    expect(result.data.message).toBe('Released: the employee can now see this review.');
  });

  it('delete the draft named', async () => {
    expect(await run('deleteReview', { review_id: REVIEW })).toEqual({ ok: true, data: { id: REVIEW, employee_id: ME, removed: true } });
    expect(ctl.ran[0]).toEqual({ fn: 'deleteReview', orgId: 'org-1', input: { review_id: REVIEW } });
  });

  it('their schemas take one id from a lookup and drop everything else', () => {
    for (const name of ['releaseReview', 'deleteReview']) {
      expect(schemaOf(name).safeParse({ review_id: REVIEW, status: 'draft', employee_id: OTHER }).data, name).toEqual({ review_id: REVIEW });
      for (const bad of [{ review_id: '' }, { review_id: null }, {}, { review_id: 'r-mine' }]) expect(schemaOf(name).safeParse(bad).success, name).toBe(false);
    }
  });
});

describe('the course tools', () => {
  const course = { title: ' Safety induction ', category: '', provider: ' NIOSH ', starts_on: '2026-11-10', ends_on: '2026-11-11' };

  it('saveTraining trims, turns an empty category or provider into none, and adds when the id is empty', async () => {
    const result = await run('saveTraining', { ...course, training_id: '' });
    expect(ctl.ran).toEqual([
      {
        fn: 'saveTraining',
        orgId: 'org-1',
        input: { training_id: null, title: 'Safety induction', category: null, provider: 'NIOSH', starts_on: '2026-11-10', ends_on: '2026-11-11' },
      },
    ]);
    expect(result.data).toEqual({
      id: COURSE, title: 'Safety induction', category: null, provider: 'NIOSH', starts_on: '2026-11-10', ends_on: '2026-11-11', status: 'upcoming',
    });
  });

  it('the status in the answer is worked out from the clock in Malaysia, not stored', async () => {
    // 2026-11-10 17:00 UTC is already 11 Nov in Malaysia: the course has started there.
    const during = await run('saveTraining', course, HR_VIEWER, hr(), base, new Date('2026-11-10T17:00:00Z'));
    expect(during.data.status).toBe('in_progress');
    const after = await run('saveTraining', course, HR_VIEWER, hr(), base, new Date('2026-11-11T16:30:00Z'));
    expect(after.data.status).toBe('completed');
  });

  it('refuses a missing title or dates, a last day before the first, a date that is not real and a wrong type, at the schema', () => {
    const schema = schemaOf('saveTraining');
    expect(schema.safeParse(course).success).toBe(true);
    expect(schema.safeParse({ ...course, ends_on: course.starts_on }).success).toBe(true);
    for (const bad of [
      { ...course, title: '  ' },
      { ...course, starts_on: undefined },
      { ...course, ends_on: '' },
      { ...course, ends_on: '2026-11-09' },
      { ...course, starts_on: '2026-02-30' },
      { ...course, starts_on: '10/11/2026' },
      { ...course, category: 'x'.repeat(81) },
      { ...course, training_id: 'nope' },
      { ...course, title: 5 },
    ]) {
      expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('removeTraining removes the course named', async () => {
    expect(await run('removeTraining', { training_id: COURSE })).toEqual({ ok: true, data: { id: COURSE, removed: true } });
    expect(ctl.ran[0]).toEqual({ fn: 'deleteTraining', orgId: 'org-1', input: { training_id: COURSE } });
  });

  it('setTrainingCompleted needs the answer true or false, and nothing else counts', async () => {
    await run('setTrainingCompleted', { training_id: COURSE, employee_id: OTHER, completed: true }, HR_VIEWER, hr(), fixture);
    await run('setTrainingCompleted', { training_id: COURSE, employee_id: OTHER, completed: false }, HR_VIEWER, hr(), fixture);
    expect(ctl.ran.map((r) => (r.input as { completed: boolean }).completed)).toEqual([true, false]);
    const schema = schemaOf('setTrainingCompleted');
    for (const bad of [
      { training_id: COURSE, employee_id: OTHER },
      { training_id: COURSE, employee_id: OTHER, completed: 'true' },
      { training_id: COURSE, employee_id: OTHER, completed: null },
      { training_id: COURSE, employee_id: '', completed: true },
      { training_id: '', employee_id: OTHER, completed: true },
    ]) {
      expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    const done = await run('setTrainingCompleted', { training_id: COURSE, employee_id: OTHER, completed: true }, HR_VIEWER, hr(), fixture);
    expect(done.data).toEqual({ training_id: COURSE, employee_id: OTHER, completed: true, employee: 'Aisyah Rahim' });
  });
});

describe('the announcement tools', () => {
  const post = { title: ' Cuti Deepavali ', body: '  Pejabat tutup.\n\nTerima kasih.  ', category: 'holiday', publish: true };

  it('keeps the whole body as typed, trims the title, and publishes only when told to', async () => {
    const published = await run('saveAnnouncement', post);
    expect(ctl.ran[0]).toEqual({
      fn: 'saveAnnouncement',
      orgId: 'org-1',
      input: { announcement_id: null, title: 'Cuti Deepavali', body: '  Pejabat tutup.\n\nTerima kasih.  ', category: 'holiday', publish: true },
    });
    expect(published.data).toMatchObject({ status: 'published', message: 'Published: everyone in the workspace can see it.' });
    const draft = await run('saveAnnouncement', { ...post, publish: false });
    expect(ctl.ran[1].input).toMatchObject({ publish: false });
    expect(draft.data).toMatchObject({ status: 'draft', message: 'This is a draft: only owners and admins can see it.' });
  });

  it('a missing body is empty text, and an empty or missing announcement id adds', async () => {
    for (const announcement_id of ['', null, undefined]) await run('saveAnnouncement', { ...post, body: null, announcement_id });
    expect(ctl.ran.map((r) => r.input)).toEqual(
      Array(3).fill({ announcement_id: null, title: 'Cuti Deepavali', body: '', category: 'holiday', publish: true }),
    );
  });

  it('refuses a missing title, an overlong body, an unknown category, a missing or non-boolean publish and a bad id, at the schema', () => {
    const schema = schemaOf('saveAnnouncement');
    expect(schema.safeParse(post).success).toBe(true);
    expect(schema.safeParse({ ...post, body: 'x'.repeat(5000) }).success).toBe(true);
    for (const bad of [
      { ...post, title: '  ' },
      { ...post, title: 'x'.repeat(201) },
      { ...post, body: 'x'.repeat(5001) },
      { ...post, body: 5 },
      { ...post, category: 'news' },
      { ...post, category: undefined },
      { ...post, publish: undefined },
      { ...post, publish: 'true' },
      { ...post, publish: null },
      { ...post, announcement_id: 'nope' },
    ]) {
      expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('publish, pull back and delete take one id and answer from the database’s row', async () => {
    expect((await run('publishAnnouncement', { announcement_id: ANNOUNCEMENT })).data.status).toBe('published');
    expect((await run('unpublishAnnouncement', { announcement_id: ANNOUNCEMENT })).data.status).toBe('draft');
    expect(await run('removeAnnouncement', { announcement_id: ANNOUNCEMENT })).toEqual({ ok: true, data: { id: ANNOUNCEMENT, removed: true } });
    expect(ctl.ran.map((r) => r.fn)).toEqual(['publishAnnouncement', 'unpublishAnnouncement', 'deleteAnnouncement']);
    for (const name of ['publishAnnouncement', 'unpublishAnnouncement', 'removeAnnouncement']) {
      expect(schemaOf(name).safeParse({ announcement_id: '' }).success, name).toBe(false);
      expect(schemaOf(name).safeParse({ announcement_id: ANNOUNCEMENT, publish: true }).data, name).toEqual({ announcement_id: ANNOUNCEMENT });
    }
  });

  it('a crash is a plain refusal that never logs the title or the text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.fail = 'throw';
    expect(await run('saveAnnouncement', post)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Deepavali');
    log.mockRestore();
  });
});

describe('listGoals', () => {
  it('a member gets their own goals only, with their ids, and no employee id; the others are never shown even when handed over', async () => {
    const result = await run('listGoals', {}, MEMBER, self(), fixture);
    expect(result.scope).toBe('your own records only');
    expect(result.goals).toEqual([{ id: 'g-mine', employee: 'Faiz Hakim', title: 'Learn SQL', progress: 40, due_date: '2026-12-31', status: 'on_track' }]);
    expect(JSON.stringify(result)).not.toContain('Run the audit');
  });

  it('an owner gets everyone’s goals with the goal id and the employee id the tools take', async () => {
    const result = await run('listGoals', {}, HR_VIEWER, hr(), fixture);
    expect(result.scope).toBe('everyone in the workspace');
    expect(result.goals).toHaveLength(2);
    expect(result.goals[1]).toMatchObject({ id: 'g-other', employee_id: OTHER, employee: 'Aisyah Rahim' });
    expect((await run('listGoals', { employee: 'aisyah', status: 'done' }, HR_VIEWER, hr(), fixture)).goals).toHaveLength(1);
  });

  it('without change tools (the demo, a viewer with no write access) it carries no id of any kind', async () => {
    for (const [viewer, write] of [[DEMO, null], [HR_VIEWER, null], [MEMBER, null]] as const) {
      const result = await run('listGoals', {}, viewer, write, fixture);
      for (const goal of result.goals) {
        expect(goal).not.toHaveProperty('id');
        expect(goal).not.toHaveProperty('employee_id');
      }
    }
  });

  it('a member not linked to an employee record gets none, and is told why', async () => {
    const result = await run('listGoals', {}, UNLINKED, null, fixture);
    expect(result.goals).toEqual([]);
    expect(result.not_linked).toEqual(expect.any(String));
  });
});

describe('listReviews', () => {
  it('a member gets their own released reviews with the scores, the rating, the score and the comment, and no id or status', async () => {
    const result = await run('listReviews', {}, MEMBER, self(), fixture);
    expect(result.scope).toBe('your own records only');
    expect(result.reviews.map((r: Loose) => r.period).sort()).toEqual(['FY 2025', 'H1 2026']);
    const mine = result.reviews.find((r: Loose) => r.period === 'H1 2026');
    expect(mine).toEqual({
      employee: 'Faiz Hakim', period: 'H1 2026', scores: { Communication: 5, Delivery: 4, Ownership: 3, Teamwork: 4.5 },
      rating: 'meets', score: 4.13, comment: 'Solid year.', reviewer: 'Kavitha', reviewed_at: '2026-06-30',
    });
    for (const review of result.reviews) {
      for (const key of ['id', 'employee_id', 'status', 'released_at']) expect(review, key).not.toHaveProperty(key);
    }
    expect(result).not.toHaveProperty('drafts');
  });

  it('a draft never reaches the person it is about: not the row, the comment, the period, a count or a hint', async () => {
    const result = await run('listReviews', {}, MEMBER, self(), fixture);
    const text = JSON.stringify(result);
    expect(text).not.toContain('SECRET DRAFT COMMENT');
    expect(text).not.toContain('H2 2026');
    expect(text).not.toContain('r-draft');
    expect(text).not.toMatch(/draft/i);
    expect(result.total).toBe(2);
    // Asking for the period that is only a draft gets the same empty answer as a period with no review at all.
    const asked = await run('listReviews', { period: 'H2 2026' }, MEMBER, self(), fixture);
    const never = await run('listReviews', { period: 'H1 2031' }, MEMBER, self(), fixture);
    expect(asked).toEqual(never);
    expect(asked.total).toBe(0);
    expect(asked.reviews).toEqual([]);
  });

  it('a member never gets a colleague’s review or comment, even when the rows are handed over', async () => {
    const result = await run('listReviews', {}, MEMBER, self(), fixture);
    expect(JSON.stringify(result)).not.toContain('COLLEAGUE COMMENT');
    expect((await run('listReviews', { employee: 'aisyah' }, MEMBER, self(), fixture)).reviews).toEqual([]);
    const summary = await run('getPerformanceSummary', {}, MEMBER, self(), fixture);
    // Their released review with a score; the older one has none to count.
    expect(summary.ratings).toEqual({ exceeds: 0, meets: 1, below: 0 });
    expect(summary.top.every((t: Loose) => t.employee === 'Faiz Hakim')).toBe(true);
  });

  it('a member with a draft only gets no review at all, with nothing to say a draft exists', async () => {
    const onlyDraft: PeopleData = { ...fixture, listReviews: async () => [review({ id: 'r-draft', status: 'draft', released_at: null, comment: 'SECRET' })] };
    const result = await run('listReviews', {}, MEMBER, self(), onlyDraft);
    expect(result.total).toBe(0);
    expect(result.reviews).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|draft|pending|not ready/i);
  });

  it('an older review with no competencies lists without scores, never NaN', async () => {
    const result = await run('listReviews', { period: 'fy 2025' }, MEMBER, self(), fixture);
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0]).not.toHaveProperty('scores');
    expect(result.reviews[0]).not.toHaveProperty('score');
    expect(JSON.stringify(result)).not.toMatch(/NaN|null.*score/);
    const asOwner = await run('listReviews', { period: 'FY 2025' }, HR_VIEWER, hr(), fixture);
    expect(asOwner.reviews[0]).not.toHaveProperty('scores');
    expect(JSON.stringify(asOwner)).not.toContain('NaN');
  });

  it('an owner gets every review with its status, its ids and how many are drafts; the period is read the way the card reads it', async () => {
    const result = await run('listReviews', {}, HR_VIEWER, hr(), fixture);
    expect(result.scope).toBe('everyone in the workspace');
    expect(result.total).toBe(4);
    expect(result.drafts).toBe(1);
    const draft = result.reviews.find((r: Loose) => r.id === 'r-draft');
    expect(draft).toMatchObject({ employee_id: ME, status: 'draft', comment: 'SECRET DRAFT COMMENT', released_at: null });
    const some = await run('listReviews', { period: 'h2 2026' }, HR_VIEWER, hr(), fixture);
    expect(some.reviews.map((r: Loose) => r.id)).toEqual(['r-draft']);
  });

  it('says so when the period neither parses nor matches, and still lists what is on record; a period that matched says nothing', async () => {
    const lost = await run('listReviews', { period: ' Q3 2026 ' }, MEMBER, self(), fixture);
    expect(lost.period_not_matched).toBe('Q3 2026');
    expect(lost.reviews.length).toBeGreaterThan(0);
    const ownerLost = await run('listReviews', { period: 'Q3 2026' }, HR_VIEWER, hr(), fixture);
    expect(ownerLost.period_not_matched).toBe('Q3 2026');
    for (const period of ['', 'H1 2026', 'fy 2025', '2026']) {
      expect(await run('listReviews', period ? { period } : {}, MEMBER, self(), fixture), period).not.toHaveProperty('period_not_matched');
    }
  });

  it('in the demo it lists as the screens do, drafts included, with no id', async () => {
    const result = await run('listReviews', {}, DEMO, null, fixture);
    expect(result.reviews.some((r: Loose) => r.status === 'draft')).toBe(true);
    for (const review of result.reviews) expect(review).not.toHaveProperty('id');
  });
});

describe('listTrainings', () => {
  const statuses = async (now: Date) =>
    Object.fromEntries(
      (await run('listTrainings', {}, HR_VIEWER, hr(), fixture, now)).trainings.map((t: Loose) => [t.title, t.status]),
    );

  it('works every course’s status out from its dates and the clock, never from a stored status', async () => {
    // The first course carries a stored status of "completed" in this fixture, and its dates say upcoming.
    expect(await statuses(NOW)).toEqual({
      'Upcoming course': 'upcoming', 'Running course': 'in_progress', 'Ended course': 'completed', 'Starts today': 'in_progress',
    });
  });

  it('at the boundaries, in Malaysia time whatever the server zone: first day, last day, the day after', async () => {
    const at = (iso: string) => new Date(iso);
    // Malaysia 9 Oct 00:30 (UTC 8 Oct 16:30): "Starts today" has started.
    expect((await statuses(at('2026-10-08T16:30:00Z')))['Starts today']).toBe('in_progress');
    // Malaysia 8 Oct 23:30 (UTC 15:30): it has not.
    expect((await statuses(at('2026-10-08T15:30:00Z')))['Starts today']).toBe('upcoming');
    // Its last day is also 9 Oct; Malaysia 10 Oct 00:30 (UTC 9 Oct 16:30) is the day after.
    expect((await statuses(at('2026-10-09T15:30:00Z')))['Starts today']).toBe('in_progress');
    expect((await statuses(at('2026-10-09T16:30:00Z')))['Starts today']).toBe('completed');
    // The running course ends 12 Oct.
    expect((await statuses(at('2026-10-12T15:30:00Z')))['Running course']).toBe('in_progress');
    expect((await statuses(at('2026-10-12T16:30:00Z')))['Running course']).toBe('completed');
  });

  it('filters by that worked-out status', async () => {
    const result = await run('listTrainings', { status: 'completed' }, HR_VIEWER, hr(), fixture);
    expect(result.trainings.map((t: Loose) => t.title)).toEqual(['Ended course']);
  });

  it('an owner sees who is enrolled and who is marked completed, with the ids the tools take', async () => {
    const result = await run('listTrainings', {}, HR_VIEWER, hr(), fixture);
    const upcoming = result.trainings.find((t: Loose) => t.title === 'Upcoming course');
    expect(upcoming).toMatchObject({ id: 'c-upcoming', enrolled: 2, completed_count: 0 });
    expect(upcoming.people).toEqual([
      { employee_id: OTHER, name: 'Aisyah Rahim', completed: false },
      { employee_id: ME, name: 'Faiz Hakim', completed: false },
    ]);
    expect(result.trainings.find((t: Loose) => t.title === 'Ended course').completed_count).toBe(1);
  });

  it('a member is told about themselves only: enrolled or not, completed, and whether they can enrol or withdraw now', async () => {
    const result = await run('listTrainings', {}, MEMBER, self(), fixture);
    const by = Object.fromEntries(result.trainings.map((t: Loose) => [t.title, t]));
    expect(by['Upcoming course']).toMatchObject({ id: 'c-upcoming', you_are_enrolled: true, you_can_enrol: false, you_can_withdraw: true });
    expect(by['Running course']).toMatchObject({ you_are_enrolled: false, you_can_enrol: true, you_can_withdraw: false });
    expect(by['Ended course']).toMatchObject({ you_are_enrolled: true, you_completed: true, you_can_enrol: false, you_can_withdraw: false });
    expect(by['Starts today']).toMatchObject({ you_can_enrol: true });
    for (const t of result.trainings) {
      for (const key of ['enrolled', 'people', 'completed_count']) expect(t, key).not.toHaveProperty(key);
    }
    // Aisyah’s enrolment in the running course is never shown to Faiz.
    expect(JSON.stringify(result)).not.toContain('Aisyah');
  });

  it('with no change tools there is no course id at all, and nothing says whether the viewer can enrol', async () => {
    for (const [viewer, write] of [[MEMBER, null], [DEMO, null], [HR_VIEWER, null]] as const) {
      const result = await run('listTrainings', {}, viewer, write, fixture);
      for (const t of result.trainings) {
        expect(t).not.toHaveProperty('id');
        expect(t).not.toHaveProperty('you_can_enrol');
      }
    }
  });

  it('an unlinked member is told so and gets no enrol advice', async () => {
    const result = await run('listTrainings', {}, UNLINKED, null, fixture);
    expect(result.not_linked).toEqual(expect.any(String));
    for (const t of result.trainings) expect(t.you_are_enrolled).toBe(false);
  });
});

describe('listAnnouncements', () => {
  it('a member gets published announcements only, with whether each is unread, and no id or status; a draft is never shown even when handed over', async () => {
    const result = await run('listAnnouncements', {}, MEMBER, self(), fixture);
    expect(result.total).toBe(2);
    expect(result.announcements.map((a: Loose) => [a.title, a.unread])).toEqual([['New notice', true], ['Old notice', false]]);
    for (const a of result.announcements) {
      expect(a).not.toHaveProperty('id');
      expect(a).not.toHaveProperty('status');
    }
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('an owner also gets drafts, each with its status and id, and a draft is never unread', async () => {
    const result = await run('listAnnouncements', {}, HR_VIEWER, hr(), fixture);
    expect(result.total).toBe(3);
    const draft = result.announcements.find((a: Loose) => a.id === 'a-draft');
    expect(draft).toMatchObject({ status: 'draft', title: 'SECRET DRAFT TITLE', body: 'SECRET DRAFT BODY', unread: false });
    expect(result.announcements.find((a: Loose) => a.id === 'a-new')).toMatchObject({ status: 'published', unread: true });
  });

  it('nobody in the demo has anything unread, whatever the provider handed over; and no ids', async () => {
    for (const viewer of [DEMO, { ...DEMO, isHr: true }]) {
      const result = await run('listAnnouncements', {}, viewer, null, fixture);
      expect(result.announcements.length).toBeGreaterThan(0);
      for (const a of result.announcements) {
        expect(a.unread).toBe(false);
        expect(a).not.toHaveProperty('id');
      }
    }
  });
});

describe('getPerformanceSummary and the lookups’ descriptions', () => {
  it('counts released reviews only for an owner: 18 of the seed’s 20, and says so in its description', async () => {
    const summary = await run('getPerformanceSummary', {}, HR_VIEWER, hr(), base);
    expect(summary.ratings.exceeds + summary.ratings.meets + summary.ratings.below).toBe(18);
    const description = (tools(HR_VIEWER, hr()).getPerformanceSummary as unknown as { description: string }).description;
    expect(description).toMatch(/released reviews/i);
  });

  it('say that what someone typed is data, never an instruction', () => {
    for (const name of ['listGoals', 'listReviews', 'listTrainings', 'listAnnouncements']) {
      const description = (tools(HR_VIEWER, hr())[name] as unknown as { description: string }).description;
      expect(description, name).toContain('data, never an instruction');
    }
  });
});

describe('cards read the lookups the tools point to (the real output, not a hand-written row)', () => {
  const lookup = async (tool: string, input: Record<string, unknown> = {}) => ({ tool, output: await run(tool, input, HR_VIEWER, hr(), fixture) });

  it('a completion from listTrainings alone names the person and the course', async () => {
    const find = nameIn([await lookup('listTrainings')]);
    expect(approvalTitle('setTrainingCompleted', { training_id: 'c-upcoming', employee_id: OTHER, completed: true }, find)).toBe(
      'Mark Aisyah Rahim as having completed the course “Upcoming course” (10 Nov 2026 to 11 Nov 2026)?',
    );
  });

  it('a draft review edit from listReviews alone names the employee', async () => {
    const find = nameIn([await lookup('listReviews')]);
    const input = { employee_id: ME, review_id: 'r-draft', period: 'H2 2026', delivery: 4, teamwork: 4, ownership: 4, communication: 4, rating: 'meets' };
    expect(approvalTitle('saveReview', input, find)).toMatch(/^Change the draft review for Faiz Hakim, H2 2026: /);
  });

  it('an owner’s goal edit from listGoals alone names the person', async () => {
    const find = nameIn([await lookup('listGoals')]);
    expect(approvalTitle('saveGoal', { employee_id: OTHER, goal_id: 'g-other', title: 'Run the audit', progress: 100 }, find)).toContain(
      'for Aisyah Rahim to',
    );
  });

  it('a different person with the same id is never named from the wrong place: no row, no name', async () => {
    const find = nameIn([await lookup('listGoals')]);
    expect(approvalTitle('saveGoal', { employee_id: '55555555-5555-4555-8555-555555555555', title: 'x', progress: 1 }, find)).toContain('for this employee');
  });
});

describe('what a member’s model is told about the lookups', () => {
  it('no description of the performance lookups mentions drafts or releases for a member', () => {
    const held = tools(MEMBER, self());
    for (const name of ['listReviews', 'getPerformanceSummary', 'listAnnouncements']) {
      expect((held[name] as unknown as { description: string }).description, name).not.toMatch(/draft|released/i);
    }
  });

  it('an owner’s descriptions do say so', () => {
    const held = tools(HR_VIEWER, hr());
    expect((held.listReviews as unknown as { description: string }).description).toMatch(/draft/i);
    expect((held.listAnnouncements as unknown as { description: string }).description).toMatch(/draft/i);
  });
});

describe('listAnnouncements counts what is new, past the rows shown', () => {
  const many: PeopleData = {
    ...fixture,
    listAnnouncements: async () => [
      ...Array.from({ length: 14 }, (_, n) => ({
        id: `a${n}`, title: `Notice ${n}`, body: 'x', category: 'general' as const, status: 'published' as const,
        published_at: '2026-10-08T01:00:00+00:00', author_name: 'K', edited_at: null, unread: n % 2 === 0,
      })),
      { id: 'd1', title: 'Draft', body: 'x', category: 'policy' as const, status: 'draft' as const, published_at: null, author_name: null, edited_at: null, unread: true },
    ],
  };

  it('a member: 7 of 14 are new although only 10 rows are shown, and a draft is never counted or shown', async () => {
    const result = await run('listAnnouncements', {}, MEMBER, self(), many);
    expect(result.announcements).toHaveLength(10);
    expect(result.total).toBe(14);
    expect(result.unread_total).toBe(7);
  });

  it('an owner: the same 7, the draft not counted', async () => {
    const result = await run('listAnnouncements', {}, HR_VIEWER, hr(), many);
    expect(result.total).toBe(15);
    expect(result.unread_total).toBe(7);
  });

  it('the demo: always 0', async () => {
    expect((await run('listAnnouncements', {}, DEMO, null, many)).unread_total).toBe(0);
  });
});

describe('an unreadable period filter', () => {
  it('matches on the text: a bare year finds that year’s released reviews', async () => {
    const result = await run('listReviews', { period: '2026' }, MEMBER, self(), fixture);
    expect(result.reviews.map((r: Loose) => r.period)).toEqual(['H1 2026']);
  });

  it('is dropped when nothing matches it, never an empty answer for something the model could not spell', async () => {
    const result = await run('listReviews', { period: 'last year' }, MEMBER, self(), fixture);
    expect(result.total).toBe(2);
  });

  it('a readable period that has no review is still empty', async () => {
    expect((await run('listReviews', { period: 'H1 2031' }, MEMBER, self(), fixture)).total).toBe(0);
  });
});

describe('a failed lookup', () => {
  it('logs the error’s name only, never its message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: PeopleData = { ...fixture, listReviews: async () => { throw new TypeError('SECRET DRAFT COMMENT'); } };
    expect(await run('listReviews', {}, MEMBER, self(), broken)).toEqual({ ok: false, error: 'Could not read HR data.' });
    expect(JSON.stringify(log.mock.calls)).toContain('TypeError');
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
    log.mockRestore();
  });
});
