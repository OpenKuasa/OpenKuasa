import { describe, expect, it, vi } from 'vitest';
import type { SavedAnnouncement } from '@/lib/people/announcement-writes';
import type { SavedGoal, SavedReview, SavedTraining } from '@/lib/people/performance-writes';

const executed = vi.hoisted(() => ({
  counts: {} as Record<string, number>,
  last: null as unknown,
  tool: 'saveGoal',
  input: {} as object | string,
  /** What the model was shown after the approval: the tool messages of its last prompt. */
  shown: [] as unknown[],
}));

const bump = (name: string, input: unknown) => {
  executed.counts[name] = (executed.counts[name] ?? 0) + 1;
  executed.last = input;
};

const ME = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const GOAL = '44444444-4444-4444-8444-444444444441';
const REVIEW = '44444444-4444-4444-8444-444444444442';
const COURSE = '44444444-4444-4444-8444-444444444443';
const ANNOUNCEMENT = '44444444-4444-4444-8444-444444444444';
const USER = '99999999-9999-4999-8999-999999999999';

// Typed so a field the write path adds to a result and the tool drops fails to compile here.
const goal: SavedGoal = { id: GOAL, employee_id: ME, title: 'Learn SQL', progress: 40, due_date: null, status: 'on_track' };
const savedReview: SavedReview = {
  id: REVIEW, employee_id: OTHER, period: 'H1 2026', competencies: { Delivery: 4, Teamwork: 4.5, Ownership: 3, Communication: 5 },
  score: 4.13, rating: 'meets', comment: null, status: 'draft', released_at: null, reviewer_name: 'Kavitha', reviewed_at: '2026-10-09',
};
const course: SavedTraining = { id: COURSE, title: 'Safety induction', category: null, provider: null, starts_on: '2026-11-10', ends_on: '2026-11-11' };
const announcement: SavedAnnouncement = {
  id: ANNOUNCEMENT, title: 'Cuti Deepavali', body: 'Tutup.', category: 'holiday', status: 'draft', published_at: null, edited_at: null, author_name: null,
};

vi.mock('@/lib/people/performance-writes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/people/performance-writes')>();
  const record = (name: string, data: unknown) => async (_ctx: unknown, input: unknown) => {
    bump(name, input);
    return { ok: true as const, data };
  };
  return {
    ...actual,
    saveGoal: record('saveGoal', goal),
    deleteGoal: record('deleteGoal', { id: GOAL, employee_id: ME }),
    saveReview: record('saveReview', savedReview),
    releaseReview: record('releaseReview', { ...savedReview, status: 'released' }),
    deleteReview: record('deleteReview', { id: REVIEW, employee_id: OTHER }),
    saveTraining: record('saveTraining', course),
    deleteTraining: record('deleteTraining', { id: COURSE }),
    enrol: record('enrol', { training_id: COURSE, employee_id: ME, completed: false }),
    unenrol: record('unenrol', { training_id: COURSE, employee_id: ME }),
    setTrainingCompleted: record('setTrainingCompleted', { training_id: COURSE, employee_id: OTHER, completed: true }),
  };
});

vi.mock('@/lib/people/announcement-writes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/people/announcement-writes')>();
  const record = (name: string, data: unknown) => async (_ctx: unknown, input: unknown) => {
    bump(name, input);
    return { ok: true as const, data };
  };
  return {
    ...actual,
    saveAnnouncement: record('saveAnnouncement', announcement),
    publishAnnouncement: record('publishAnnouncement', { ...announcement, status: 'published', published_at: '2026-10-09T04:00:00+00:00' }),
    unpublishAnnouncement: record('unpublishAnnouncement', announcement),
    deleteAnnouncement: record('deleteAnnouncement', { id: ANNOUNCEMENT }),
  };
});

vi.mock('@/lib/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/provider')>();
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  return {
    ...actual,
    getModel: () =>
      new MockLanguageModelV4({
        doStream: async (options: { prompt: { role: string }[] }) => {
          const resumed = options.prompt.some((m) => m.role === 'tool');
          if (resumed) executed.shown = options.prompt.filter((m) => m.role === 'tool');
          const chunks: Record<string, unknown>[] = resumed
            ? [
                { type: 'text-start', id: 'a' },
                { type: 'text-delta', id: 'a', delta: 'Done.' },
                { type: 'text-end', id: 'a' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
              ]
            : [
                { type: 'tool-call', toolCallId: 't1', toolName: executed.tool, input: typeof executed.input === 'string' ? executed.input : JSON.stringify(executed.input) },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
              ];
          return { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }) };
        },
      } as unknown as ConstructorParameters<typeof MockLanguageModelV4>[0]) as never,
  };
});

const { runLekiu } = await import('@/lib/ai/agents/orchestrator');
// After this file's mocks and the values they use are in place: the helpers load the tools too.
const { withLekiu } = await import('./helpers/approvals');
const { createSeedPeopleData } = await import('@/lib/people/seed');
const { approvalDetail, approvalTitle, nameIn } = await import('@/lib/chat/change-titles');

const data = createSeedPeopleData(new Date('2026-10-09T04:00:00Z'));
const ctx = { client: {} as never, orgId: 'org1' };
const asMember = {
  data,
  viewer: { employeeId: ME, isHr: false, isDemo: false },
  write: { ctx, tier: 'self' as const, employeeId: ME, receipt: null, userId: USER },
};
const asUnlinkedMember = {
  data,
  viewer: { employeeId: null, isHr: false, isDemo: false },
  write: { ctx, tier: 'self' as const, employeeId: null, receipt: null, userId: USER },
};
const asOwner = {
  data,
  viewer: { employeeId: null, isHr: true, isDemo: false },
  write: { ctx, tier: 'hr' as const, employeeId: null, receipt: null, userId: USER },
};
const asLinkedOwner = {
  data,
  viewer: { employeeId: ME, isHr: true, isDemo: false },
  write: { ctx, tier: 'hr' as const, employeeId: ME, receipt: null, userId: USER },
};
const asViewerRole = { data, viewer: { employeeId: ME, isHr: false, isDemo: false }, write: undefined };
const asDemoOwner = { data, viewer: { employeeId: null, isHr: true, isDemo: true }, write: undefined };
const ask = [{ role: 'user' as const, content: 'Please' }];

// The orchestrator logs one line per model call, some after a test has finished; it is not what these tests are about.
vi.spyOn(console, 'log').mockImplementation(() => {});

const reset = (tool: string, input: object | string) => {
  Object.assign(executed, { counts: {}, last: null, shown: [], tool, input });
};
const ran = (name: string) => executed.counts[name] ?? 0;
const total = () => Object.values(executed.counts).reduce((sum, n) => sum + n, 0);

type People = typeof asMember | typeof asOwner | typeof asLinkedOwner;
type Case = { tool: string; write: string; who: People; sent: object | string; saved: unknown; card: string; detail?: string | null };

const REVIEW_SENT = { employee_id: OTHER, period: 'h1 2026', delivery: '4', teamwork: 4.5, ownership: ' 3 ', communication: 5, rating: 'meets' };
const REVIEW_SAVED = {
  employee_id: OTHER, review_id: null, period: 'H1 2026',
  competencies: { Delivery: 4, Teamwork: 4.5, Ownership: 3, Communication: 5 }, rating: 'meets', comment: null,
};
const REVIEW_CARD =
  'Save a draft review for this employee, H1 2026: Delivery 4, Teamwork 4.5, Ownership 3, Communication 5, rated meets expectations, no comment?';

/** What the model sends (extra arguments, empty strings and nulls included), and what must reach the write path. */
const CASES: Case[] = [
  {
    tool: 'saveGoal', write: 'saveGoal', who: asMember,
    sent: { title: ' Learn SQL ', progress: 40, due_date: '', at_risk: null, goal_id: '', employee_id: OTHER, note: 'x' },
    saved: { employee_id: ME, goal_id: null, title: 'Learn SQL', progress: 40, due_date: null, at_risk: false },
    card: 'Add a goal for yourself: “Learn SQL”, 40% done, no due date, on track?',
  },
  {
    tool: 'saveGoal', write: 'saveGoal', who: asMember,
    sent: { title: 'Learn SQL', progress: 100, due_date: '2026-12-31', at_risk: true, goal_id: GOAL },
    saved: { employee_id: ME, goal_id: GOAL, title: 'Learn SQL', progress: 100, due_date: '2026-12-31', at_risk: true },
    card: 'Change a goal that was not in the list above for yourself to “Learn SQL”, 100% done, due 31 Dec 2026, done?',
  },
  {
    tool: 'saveGoal', write: 'saveGoal', who: asOwner,
    sent: { employee_id: OTHER, title: 'Run the audit', progress: 0, goal_id: null, extra: 1 },
    saved: { employee_id: OTHER, goal_id: null, title: 'Run the audit', progress: 0, due_date: null, at_risk: false },
    card: 'Add a goal for this employee: “Run the audit”, 0% done, no due date, on track?',
  },
  {
    tool: 'removeGoal', write: 'deleteGoal', who: asMember, sent: { goal_id: GOAL, employee_id: OTHER, reason: 'x' },
    saved: { goal_id: GOAL }, card: 'Remove a goal that was not in the list above?', detail: 'This cannot be undone.',
  },
  {
    tool: 'enrolInTraining', write: 'enrol', who: asMember, sent: { training_id: COURSE, employee_id: OTHER, note: 'x' },
    saved: { training_id: COURSE, employee_id: ME }, card: 'Enrol yourself in a course that was not in the list above?',
  },
  {
    tool: 'enrolInTraining', write: 'enrol', who: asOwner, sent: { training_id: COURSE, employee_id: OTHER },
    saved: { training_id: COURSE, employee_id: OTHER }, card: 'Enrol this employee in a course that was not in the list above?',
  },
  {
    tool: 'withdrawFromTraining', write: 'unenrol', who: asMember, sent: { training_id: COURSE, employee_id: null },
    saved: { training_id: COURSE, employee_id: ME }, card: 'Withdraw yourself from a course that was not in the list above?',
  },
  {
    tool: 'withdrawFromTraining', write: 'unenrol', who: asLinkedOwner, sent: { training_id: COURSE, employee_id: '' },
    saved: { training_id: COURSE, employee_id: ME }, card: 'Withdraw yourself from a course that was not in the list above?',
  },
  {
    tool: 'saveReview', write: 'saveReview', who: asOwner, sent: { ...REVIEW_SENT, extra: 1, status: 'released' },
    saved: REVIEW_SAVED, card: REVIEW_CARD, detail: 'A draft: the employee cannot see it yet.',
  },
  {
    tool: 'saveReview', write: 'saveReview', who: asOwner,
    sent: { ...REVIEW_SENT, review_id: '', comment: '' },
    saved: REVIEW_SAVED, card: REVIEW_CARD, detail: 'A draft: the employee cannot see it yet.',
  },
  {
    tool: 'saveReview', write: 'saveReview', who: asOwner,
    sent: { ...REVIEW_SENT, period: 'FY2026', review_id: REVIEW, comment: ' Steady quarter. ' },
    saved: { ...REVIEW_SAVED, period: 'FY 2026', review_id: REVIEW, comment: 'Steady quarter.' },
    card: 'Change the draft review for this employee, FY 2026: Delivery 4, Teamwork 4.5, Ownership 3, Communication 5, rated meets expectations, comment “Steady quarter.”?',
    detail: 'A draft: the employee cannot see it yet.',
  },
  {
    tool: 'releaseReview', write: 'releaseReview', who: asOwner, sent: { review_id: REVIEW, status: 'draft', employee_id: OTHER },
    saved: { review_id: REVIEW }, card: 'Release a review that was not in the list above?', detail: 'The employee will be able to see it.',
  },
  {
    tool: 'deleteReview', write: 'deleteReview', who: asOwner, sent: { review_id: REVIEW, force: true },
    saved: { review_id: REVIEW }, card: 'Delete a review that was not in the list above?',
    detail: 'A draft: the employee cannot see it yet. This cannot be undone.',
  },
  {
    tool: 'saveTraining', write: 'saveTraining', who: asOwner,
    sent: { title: ' Safety induction ', category: '', provider: null, starts_on: '2026-11-10', ends_on: '2026-11-11', training_id: '', capacity: 5 },
    saved: { training_id: null, title: 'Safety induction', category: null, provider: null, starts_on: '2026-11-10', ends_on: '2026-11-11' },
    card: 'Add the course “Safety induction” (10 Nov 2026 to 11 Nov 2026, no category, no provider)?',
  },
  {
    tool: 'saveTraining', write: 'saveTraining', who: asOwner,
    sent: { title: 'Safety induction', category: 'Safety', provider: 'NIOSH', starts_on: '2026-11-10', ends_on: '2026-11-10', training_id: COURSE },
    saved: { training_id: COURSE, title: 'Safety induction', category: 'Safety', provider: 'NIOSH', starts_on: '2026-11-10', ends_on: '2026-11-10' },
    card: 'Change a course that was not in the list above to “Safety induction” (on 10 Nov 2026, category “Safety”, provider “NIOSH”)?',
  },
  {
    tool: 'removeTraining', write: 'deleteTraining', who: asOwner, sent: { training_id: COURSE, cascade: true },
    saved: { training_id: COURSE }, card: 'Remove a course that was not in the list above?',
    detail: 'Everyone enrolled is removed from it too. This cannot be undone.',
  },
  {
    tool: 'setTrainingCompleted', write: 'setTrainingCompleted', who: asOwner, sent: { training_id: COURSE, employee_id: OTHER, completed: true, note: 'x' },
    saved: { training_id: COURSE, employee_id: OTHER, completed: true },
    card: 'Mark this employee as having completed a course that was not in the list above?',
    detail: 'A course with someone marked as completed cannot be removed until this is undone.',
  },
  {
    tool: 'setTrainingCompleted', write: 'setTrainingCompleted', who: asOwner, sent: { training_id: COURSE, employee_id: OTHER, completed: false },
    saved: { training_id: COURSE, employee_id: OTHER, completed: false },
    card: "Undo this employee's completion of a course that was not in the list above?",
  },
  {
    tool: 'saveAnnouncement', write: 'saveAnnouncement', who: asOwner,
    sent: { title: ' Cuti Deepavali ', body: '  Tutup.\nTerima kasih.  ', category: 'holiday', publish: true, announcement_id: '', author: 'x' },
    saved: { announcement_id: null, title: 'Cuti Deepavali', body: '  Tutup.\nTerima kasih.  ', category: 'holiday', publish: true },
    card: 'Publish the new announcement “Cuti Deepavali” (holiday): “  Tutup.\nTerima kasih.  ”?', detail: 'Everyone in the workspace will see it.',
  },
  {
    tool: 'saveAnnouncement', write: 'saveAnnouncement', who: asOwner,
    sent: { title: 'Cuti', body: null, category: 'general', publish: false, announcement_id: ANNOUNCEMENT },
    saved: { announcement_id: ANNOUNCEMENT, title: 'Cuti', body: '', category: 'general', publish: false },
    card: 'Save changes to an announcement that was not in the list above, as “Cuti” (general): no text?',
    detail: 'Saved without publishing: a draft stays a draft, and a published announcement stays published and shows the changes.',
  },
  {
    tool: 'publishAnnouncement', write: 'publishAnnouncement', who: asOwner, sent: { announcement_id: ANNOUNCEMENT, publish: true },
    saved: { announcement_id: ANNOUNCEMENT }, card: 'Publish an announcement that was not in the list above?', detail: 'Everyone in the workspace will see it.',
  },
  {
    tool: 'unpublishAnnouncement', write: 'unpublishAnnouncement', who: asOwner, sent: { announcement_id: ANNOUNCEMENT, x: 1 },
    saved: { announcement_id: ANNOUNCEMENT }, card: 'Pull back to a draft an announcement that was not in the list above?', detail: 'Members will no longer see it.',
  },
  {
    tool: 'removeAnnouncement', write: 'deleteAnnouncement', who: asOwner, sent: { announcement_id: ANNOUNCEMENT, x: 1 },
    saved: { announcement_id: ANNOUNCEMENT }, card: 'Delete an announcement that was not in the list above?',
    detail: "This cannot be undone. Everyone's read marks for it are deleted too.",
  },
];

type Part = { type: string; toolCallId?: string; toolName?: string; input?: unknown; approvalId?: string };

const history = (call: Part, request: Part, approved: boolean) => [
  ...ask,
  {
    role: 'assistant' as const,
    content: [
      { type: 'tool-call' as const, toolCallId: call.toolCallId!, toolName: call.toolName!, input: call.input },
      { type: 'tool-approval-request' as const, approvalId: request.approvalId!, toolCallId: call.toolCallId! },
    ],
  },
  { role: 'tool' as const, content: [{ type: 'tool-approval-response' as const, approvalId: request.approvalId!, approved }] },
];

const firstTurn = async (c: Pick<Case, 'tool' | 'sent'>, people: People = asOwner) => {
  reset(c.tool, c.sent);
  const first = runLekiu(...withLekiu(ask, people));
  await first.consumeStream();
  const parts = (await first.content) as Part[];
  return { parts, call: parts.find((p) => p.type === 'tool-call'), request: parts.find((p) => p.type === 'tool-approval-request') };
};

const rows = CASES.map((c) => [c.tool, JSON.stringify(c.sent), c] as const);

describe('Lekiu’s performance, training and announcement changes require approval', () => {
  it.each(rows)('%s sent as %s: a card appears first and nothing is written until it is approved', async (_tool, _sent, c) => {
    const { call, request } = await firstTurn(c, c.who);
    expect(ran(c.write)).toBe(0);
    expect(total()).toBe(0);
    expect(call?.toolName).toBe(c.tool);
    expect(request).toBeDefined();
    // The card shows what will be saved, read through the SDK's own input parsing (extra arguments dropped).
    expect(approvalTitle(c.tool, call?.input)).toBe(c.card);
    expect(approvalDetail(c.tool, call?.input)).toBe(c.detail ?? null);
    for (const dropped of ['extra', 'note', 'reason', 'force', 'cascade', 'capacity', 'author', 'x', 'status']) {
      if (!(dropped in (c.sent as object))) continue;
      expect(call?.input, dropped).not.toHaveProperty(dropped);
    }
  });

  it.each(rows)('%s sent as %s: once approved, the write runs exactly once with the normalised values', async (_tool, _sent, c) => {
    const { call, request } = await firstTurn(c, c.who);
    expect(call).toBeDefined();
    expect(request).toBeDefined();
    const second = runLekiu(...withLekiu(history(call!, request!, true), c.who));
    await second.consumeStream();
    expect(ran(c.write)).toBe(1);
    expect(total()).toBe(1);
    expect(executed.last).toEqual(c.saved);
    expect(await second.text).toBe('Done.');
  });

  it.each(rows)('%s sent as %s: rejecting it writes nothing and the turn continues', async (_tool, _sent, c) => {
    const { call, request } = await firstTurn(c, c.who);
    const second = runLekiu(...withLekiu(history(call!, request!, false), c.who));
    await second.consumeStream();
    expect(total()).toBe(0);
    expect(await second.text).toBe('Done.');
  });

  it('a member’s schemas drop an employee id the model sends, so the card and the write are for them', async () => {
    const { call } = await firstTurn(CASES[0], asMember);
    expect(call?.input).not.toHaveProperty('employee_id');
    const enrol = await firstTurn(CASES[4], asMember);
    expect(enrol.call?.input).not.toHaveProperty('employee_id');
    // An owner’s call keeps the employee they named.
    const owner = await firstTurn(CASES[5], asOwner);
    expect(owner.call?.input).toMatchObject({ employee_id: OTHER });
  });

  it('every tool has at least one row', () => {
    const tools = [...new Set(CASES.map((c) => c.tool))];
    expect(tools.sort()).toEqual([
      'deleteReview', 'enrolInTraining', 'publishAnnouncement', 'releaseReview', 'removeAnnouncement', 'removeGoal', 'removeTraining',
      'saveAnnouncement', 'saveGoal', 'saveReview', 'saveTraining', 'setTrainingCompleted', 'unpublishAnnouncement', 'withdrawFromTraining',
    ]);
  });

  it('the card, read with a finder built from an earlier lookup, names the person, the goal, the review, the course and the announcement', async () => {
    const find = nameIn([
      { tool: 'listEmployees', output: { employees: [{ id: OTHER, name: 'Aisyah Rahim' }, { id: ME, name: 'Faiz Hakim' }] } },
      { tool: 'listGoals', output: { goals: [{ id: GOAL, employee: 'Faiz Hakim', title: 'Learn SQL', progress: 40, due_date: '2026-12-31', status: 'on_track' }] } },
      {
        tool: 'listReviews',
        output: {
          reviews: [{
            id: REVIEW, employee: 'Aisyah Rahim', period: 'H1 2026', status: 'draft', scores: { Delivery: 4, Teamwork: 4.5, Ownership: 3, Communication: 5 },
            rating: 'meets', score: 4.13, comment: 'Steady quarter.',
          }],
        },
      },
      {
        tool: 'listTrainings',
        output: { trainings: [{ id: COURSE, title: 'Safety induction', starts_on: '2026-11-10', ends_on: '2026-11-11', status: 'upcoming', completed_count: 0 }] },
      },
      { tool: 'listAnnouncements', output: { announcements: [{ id: ANNOUNCEMENT, status: 'draft', title: 'Cuti Deepavali', body: 'Tutup.', category: 'holiday' }] } },
    ]);
    const expected: Record<string, string> = {
      saveGoal: 'Add a goal for yourself: “Learn SQL”, 40% done, no due date, on track?',
      removeGoal: 'Remove the goal “Learn SQL” of Faiz Hakim (40% done, due 31 Dec 2026, on track)?',
      enrolInTraining: 'Enrol yourself in the course “Safety induction” (10 Nov 2026 to 11 Nov 2026)?',
      withdrawFromTraining: 'Withdraw yourself from the course “Safety induction” (10 Nov 2026 to 11 Nov 2026)?',
      saveReview: 'Save a draft review for Aisyah Rahim, H1 2026: Delivery 4, Teamwork 4.5, Ownership 3, Communication 5, rated meets expectations, no comment?',
      releaseReview: 'Release the review for Aisyah Rahim, H1 2026: Delivery 4, Teamwork 4.5, Ownership 3, Communication 5, overall 4.13, rated meets expectations, comment “Steady quarter.”?',
      deleteReview: 'Delete the review for Aisyah Rahim, H1 2026: Delivery 4, Teamwork 4.5, Ownership 3, Communication 5, overall 4.13, rated meets expectations, comment “Steady quarter.”?',
      saveTraining: 'Add the course “Safety induction” (10 Nov 2026 to 11 Nov 2026, no category, no provider)?',
      removeTraining: "Remove the course “Safety induction” (10 Nov 2026 to 11 Nov 2026) and everyone's enrolment in it?",
      setTrainingCompleted: 'Mark Aisyah Rahim as having completed the course “Safety induction” (10 Nov 2026 to 11 Nov 2026)?',
      saveAnnouncement: 'Publish the new announcement “Cuti Deepavali” (holiday): “  Tutup.\nTerima kasih.  ”?',
      removeAnnouncement: 'Delete the announcement “Cuti Deepavali” (holiday): “Tutup.”?',
      publishAnnouncement: 'Publish the announcement “Cuti Deepavali” (holiday): “Tutup.”?',
      unpublishAnnouncement: 'Pull back to a draft the announcement “Cuti Deepavali” (holiday): “Tutup.”?',
    };
    // A finder-ready sent for the rows whose ids differ from the lookup's (the goal and the course rows have the same ids).
    const withIds = (c: Case): object => {
      const sent = c.sent as Record<string, unknown>;
      if (c.tool === 'saveGoal') return { ...sent, goal_id: null, employee_id: '' };
      if (c.tool === 'saveTraining') return { ...sent, training_id: '' };
      return sent;
    };
    const seen = new Set<string>();
    for (const c of CASES) {
      if (seen.has(c.tool)) continue;
      seen.add(c.tool);
      const { call } = await firstTurn({ tool: c.tool, sent: withIds(c) }, c.who);
      expect(call, c.tool).toBeDefined();
      expect(approvalTitle(c.tool, call?.input, find), c.tool).toBe(expected[c.tool]);
    }
    expect([...seen].sort()).toEqual(Object.keys(expected).sort());
    // A goal being changed, and a course and an announcement being edited, are named from the lookup too.
    const edit = await firstTurn(CASES[1], asMember);
    expect(approvalTitle('saveGoal', edit.call?.input, find)).toBe('Change the goal “Learn SQL” for yourself to “Learn SQL”, 100% done, due 31 Dec 2026, done?');
    const course = await firstTurn(CASES[14], asOwner);
    expect(approvalTitle('saveTraining', course.call?.input, find)).toBe(
      'Change the course “Safety induction” to “Safety induction” (on 10 Nov 2026, category “Safety”, provider “NIOSH”)?',
    );
    const post = await firstTurn(CASES[19], asOwner);
    expect(approvalTitle('saveAnnouncement', post.call?.input, find)).toBe(
      'Save changes to the announcement “Cuti Deepavali”, as “Cuti” (general): no text?',
    );
  });

  it.each([
    ['saveGoal', { title: '   ', progress: 40 }],
    ['saveGoal', { title: 'Learn SQL', progress: '40' }],
    ['saveGoal', { title: 'Learn SQL', progress: 140 }],
    ['saveGoal', { title: 'Learn SQL', progress: 40, due_date: 'next week' }],
    ['saveGoal', { title: 'Learn SQL', progress: 40, goal_id: 'nope' }],
    ['saveGoal', { title: 'Learn SQL', progress: 40, at_risk: 'yes' }],
    ['removeGoal', { goal_id: '' }],
    ['removeGoal', ''],
    ['enrolInTraining', { training_id: '' }],
    ['enrolInTraining', { training_id: 5 }],
    ['withdrawFromTraining', {}],
  ])('%s with %j is refused by the schema before any card, for a member', async (tool, sent) => {
    const { request } = await firstTurn({ tool, sent }, asMember);
    expect(total()).toBe(0);
    expect(request).toBeUndefined();
  });

  it.each([
    ['saveReview', { ...REVIEW_SENT, delivery: undefined }],
    ['saveReview', { ...REVIEW_SENT, ownership: '' }],
    ['saveReview', { ...REVIEW_SENT, teamwork: 4.7 }],
    ['saveReview', { ...REVIEW_SENT, communication: '5.0' }],
    ['saveReview', { ...REVIEW_SENT, communication: null }],
    ['saveReview', { ...REVIEW_SENT, period: 'last year' }],
    ['saveReview', { ...REVIEW_SENT, period: '' }],
    ['saveReview', { ...REVIEW_SENT, rating: 'excellent' }],
    ['saveReview', { ...REVIEW_SENT, employee_id: '' }],
    ['saveReview', { ...REVIEW_SENT, comment: 5 }],
    ['releaseReview', { review_id: '' }],
    ['releaseReview', {}],
    ['deleteReview', { review_id: 'r1' }],
    ['saveTraining', { title: 'x', starts_on: '2026-11-12', ends_on: '2026-11-10' }],
    ['saveTraining', { title: 'x', starts_on: '2026-11-12' }],
    ['saveTraining', { title: '', starts_on: '2026-11-10', ends_on: '2026-11-10' }],
    ['saveTraining', { title: 'x', starts_on: 'soon', ends_on: '2026-11-10' }],
    ['removeTraining', { training_id: '' }],
    ['setTrainingCompleted', { training_id: COURSE, employee_id: OTHER }],
    ['setTrainingCompleted', { training_id: COURSE, employee_id: OTHER, completed: 'yes' }],
    ['setTrainingCompleted', { training_id: COURSE, employee_id: '', completed: true }],
    ['saveAnnouncement', { title: 'Cuti', body: 'x', category: 'general' }],
    ['saveAnnouncement', { title: 'Cuti', body: 'x', category: 'general', publish: 'true' }],
    ['saveAnnouncement', { title: 'Cuti', body: 'x', category: 'news', publish: true }],
    ['saveAnnouncement', { title: ' ', body: 'x', category: 'general', publish: true }],
    ['saveAnnouncement', { title: 'Cuti', body: 'x'.repeat(5001), category: 'general', publish: true }],
    ['publishAnnouncement', { announcement_id: '' }],
    ['unpublishAnnouncement', {}],
    ['removeAnnouncement', ''],
  ])('%s with %j is refused by the schema before any card, for an owner', async (tool, sent) => {
    const { request } = await firstTurn({ tool, sent }, asOwner);
    expect(total()).toBe(0);
    expect(request).toBeUndefined();
  });

  it('an owner with no employee record who names nobody gets a refusal from the tool, and nothing is written', async () => {
    const c = { tool: 'saveGoal', sent: { title: 'Learn SQL', progress: 40 } };
    const { call, request } = await firstTurn(c, asOwner);
    expect(request).toBeDefined();
    const second = runLekiu(...withLekiu(history(call!, request!, true), asOwner));
    await second.consumeStream();
    expect(total()).toBe(0);
    // The model is told why, in the sentence the tool gives, and not that anything was saved.
    const results = executed.shown;
    expect(JSON.stringify(results)).toContain('Say which employee this is for. Your own account is not linked to an employee record.');
  });

  it.each([
    ['saveGoal', { title: 'Learn SQL', progress: 40 }],
    ['enrolInTraining', { training_id: COURSE }],
    ['withdrawFromTraining', { training_id: COURSE }],
  ])('%s with an employee_id that is not an id, or not text, is refused before any card, for an owner', async (tool, base) => {
    for (const employee_id of ['Aisyah', 'not-an-id', 5, true, {}, ['x']]) {
      const { request } = await firstTurn({ tool, sent: { ...base, employee_id } }, asOwner);
      expect(total(), String(employee_id)).toBe(0);
      expect(request, String(employee_id)).toBeUndefined();
    }
  });

  it.each(CASES.filter((c, i, all) => all.findIndex((d) => d.tool === c.tool) === i && c.who === asOwner).map((c) => [c.tool, c] as const))(
    'a member cannot reach %s: the tool is not theirs, so no card and no write even if the model asks',
    async (_tool, c) => {
      const { request } = await firstTurn(c, asMember);
      expect(total()).toBe(0);
      expect(request).toBeUndefined();
    },
  );

  it.each([
    ['a member not linked to an employee record', asUnlinkedMember],
    ['a viewer, linked or not, with no write access', asViewerRole],
    ['an owner of the demo workspace', asDemoOwner],
  ])('%s cannot reach any of them', async (_who, people) => {
    for (const c of CASES) {
      const { request } = await firstTurn(c, people as unknown as People);
      expect(total(), c.tool).toBe(0);
      expect(request, c.tool).toBeUndefined();
    }
  });

  it('nothing in the conversation can approve for the person: a call replayed with no approval response writes nothing', async () => {
    const c = CASES[8];
    const { call, request } = await firstTurn(c, c.who);
    reset(c.tool, c.sent);
    const replay = runLekiu(...withLekiu(history(call!, request!, false).slice(0, 2), c.who));
    await replay.consumeStream();
    expect(total()).toBe(0);
  });
});
