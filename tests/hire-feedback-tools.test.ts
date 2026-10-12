// tests/hire-feedback-tools.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHireTools } from '@/lib/ai/hire-tools';
import { HIRE_FEEDBACK_TOOL_NAMES } from '@/lib/ai/hire-interview-gate';
import { HIRE_WRITE_TOOL_NAMES, combineToolkits, hireProduct } from '@/lib/ai/products';
import { changeHeading, changeRows } from '@/lib/chat/change-rows';
import { approvalDetail, approvalTitle, collectNames, kindOfTool, nameIn } from '@/lib/chat/change-titles';
import { toolMeta } from '@/components/chat/tool-parts';
import { clearInterviewFeedbackInput, saveInterviewFeedbackInput } from '@/lib/hire/capabilities';
import type { Feedback } from '@/lib/hire/interview-feedback';
import { createSeedHireData } from '@/lib/hire/seed';
import type { HireData } from '@/lib/hire/types';

// The real schemas; only the two feedback changes are recorded instead of run.
const applied = vi.hoisted(() => ({ save: vi.fn(), clear: vi.fn() }));
vi.mock('@/lib/hire/capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hire/capabilities')>()),
  saveInterviewFeedback: applied.save,
  clearInterviewFeedback: applied.clear,
}));

const NOW = new Date('2026-10-10T04:00:00Z');
const IV = '77777777-7777-4777-8777-777777777777';
/** 10:05:40 am on Wednesday 7 October 2026 in Kuala Lumpur. */
const SAVED = '2026-10-07T02:05:40.000Z';
const FEEDBACK: Feedback = { rating: 4, recommendation: 'advance', comments: 'Strong on key accounts.', recorded_at: SAVED };
const ctx = { client: {} as never, orgId: 'org1' };
const data = createSeedHireData(NOW);
// The tool results are untyped JSON; the tests read them loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
type Tool = { description: string; inputSchema: unknown; execute: (input: unknown, options: unknown) => Promise<Loose> };
const writer = () => createHireTools(data, NOW, { ctx, canWrite: true }) as unknown as Record<string, Tool>;
const OPTIONS = { toolCallId: 't', messages: [] };

beforeEach(() => {
  applied.save.mockReset();
  applied.clear.mockReset();
});

describe('the two feedback tools', () => {
  it('are change tools: in the hiring list after 4a\'s six, offered only to someone who may write, and each needs approval', () => {
    expect(HIRE_WRITE_TOOL_NAMES.slice(-2)).toEqual([...HIRE_FEEDBACK_TOOL_NAMES]);
    const none = Object.keys(createHireTools(data, NOW));
    const viewer = Object.keys(createHireTools(data, NOW, { ctx, canWrite: false }));
    const member = Object.keys(writer());
    for (const name of HIRE_FEEDBACK_TOOL_NAMES) {
      expect(none, name).not.toContain(name);
      expect(viewer, name).not.toContain(name);
      expect(member, name).toContain(name);
    }
    const { toolApproval } = combineToolkits([hireProduct({ data, write: { ctx, canWrite: true } })]);
    for (const name of HIRE_FEEDBACK_TOOL_NAMES) expect(toolApproval?.[name], name).toBe('user-approval');
  });
  it('take the capability\'s own schema, so a screen and the assistant cannot accept different things', () => {
    const tools = writer();
    expect(tools.saveInterviewFeedback.inputSchema).toBe(saveInterviewFeedbackInput);
    expect(tools.clearInterviewFeedback.inputSchema).toBe(clearInterviewFeedbackInput);
  });
  it('say what they do, and that a recommendation moves nothing', () => {
    const tools = writer();
    expect(tools.saveInterviewFeedback.description).toBe(
      'Record feedback on ONE completed interview: a rating from 1 to 5, a recommendation (advance, hold or reject) and comments. ' +
        'Use the interview\'s id from listInterviews. It does not move, reject or rate the application. ' +
        'When the rating or the recommendation is your own reading, put the grounds in basis.',
    );
    expect(tools.clearInterviewFeedback.description).toBe('Clear the feedback on ONE interview for good. Use the interview\'s id from listInterviews.');
  });
  it('hand the input to the capability and answer with its result, long comments cut as a lookup cuts them', async () => {
    const tools = writer();
    const change = { id: IV, candidate: 'Aina Rahman', job: 'Sales Executive', status: 'completed', scheduled_at: null, replaced: false, marked_completed: false, message: 'Saved.', confirmed: true };
    applied.save.mockResolvedValue({ ok: true, data: { ...change, feedback: { ...FEEDBACK, comments: 'c'.repeat(700) } } });
    const input = { id: IV, rating: 4, recommendation: 'advance', comments: 'c'.repeat(700) };
    const saved = await tools.saveInterviewFeedback.execute(input, OPTIONS);
    expect(applied.save).toHaveBeenCalledTimes(1);
    expect(applied.save.mock.calls[0][0]).toBe(ctx);
    expect(applied.save.mock.calls[0][1]).toEqual(input);
    // No "last seen" version is ever passed by the assistant: the gate's last check does that job.
    expect(applied.save.mock.calls[0]).toHaveLength(2);
    expect(saved).toMatchObject({ ok: true, data: { id: IV, candidate: 'Aina Rahman', job: 'Sales Executive', message: 'Saved.', replaced: false } });
    expect(saved.data.feedback).toEqual({
      rating: 4, recommendation: 'advance', comments: `${'c'.repeat(600)}…`, comments_cut: true, recorded_at: SAVED, recorded: 'Wed 7 Oct 2026, 10:05 am',
    });
    applied.clear.mockResolvedValue({ ok: true, data: { ...change, feedback: null, message: 'Cleared.' } });
    expect(await tools.clearInterviewFeedback.execute({ id: IV }, OPTIONS)).toMatchObject({ ok: true, data: { id: IV, feedback: null, message: 'Cleared.' } });
    expect(applied.clear.mock.calls[0][1]).toEqual({ id: IV });
  });
  it('a refusal is handed on as it is', async () => {
    const refused = { ok: false, error: 'This interview already has feedback. Open it to edit it.' };
    applied.save.mockResolvedValue(refused);
    expect(await writer().saveInterviewFeedback.execute({ id: IV, rating: 4, recommendation: 'advance' }, OPTIONS)).toBe(refused);
  });
  it('have no entry of their own among the tool labels: like every hiring change but 4a\'s six, they are named for what they do', () => {
    for (const name of HIRE_FEEDBACK_TOOL_NAMES) expect(toolMeta(name).isFallback, name).toBe(true);
    expect(changeHeading('saveInterviewFeedback')).toBe('Save interview feedback');
    expect(changeHeading('clearInterviewFeedback')).toBe('Clear interview feedback');
  });
});

describe('listInterviews, with feedback', () => {
  const AT = '2026-10-06T07:00:00.000Z';
  const interview = (id: string, over: Record<string, unknown> = {}) => ({
    id, application_id: 'a1', candidate_name: 'Aina Rahman', job_title: 'Sales Executive', scheduled_at: AT, kind: 'video',
    interviewer_name: 'Farah Lim', status: 'completed', created_at: '2026-10-01T02:00:00.000Z', updated_at: '2026-10-07T02:05:40.000Z',
    duration_minutes: 45, place: null, notes: null, application_stage: 'interview', application_outcome: 'active',
    ...over,
  });
  const from = (...rows: ReturnType<typeof interview>[]): HireData => ({ ...data, listInterviews: async () => rows as never });
  const list = (input: Record<string, unknown>, source: HireData) =>
    (createHireTools(source, NOW).listInterviews as unknown as Tool).execute(input, OPTIONS);
  // One with feedback, one completed without, one still ahead, one cancelled: four people, so nothing is ambiguous.
  const four = from(
    interview('rated', { feedback: FEEDBACK }),
    interview('bare', { candidate_name: 'Farid bin Osman', application_id: 'a2', scheduled_at: '2026-10-05T07:00:00.000Z' }),
    interview('ahead', { candidate_name: 'Mei Ling Tan', application_id: 'a3', scheduled_at: '2026-10-20T07:00:00.000Z', status: 'scheduled' }),
    interview('off', { candidate_name: 'Ben Tan', application_id: 'a4', scheduled_at: '2026-10-04T07:00:00.000Z', status: 'cancelled' }),
  );
  const byId = (out: Loose) => new Map<string, Loose>(out.interviews.map((i: { id: string }) => [i.id, i]));

  it('gives every row its feedback: the rating, the recommendation, the comments, and when it was saved with the date and the year; null when there is none', async () => {
    const rows = byId(await list({}, four));
    expect(rows.get('rated').feedback).toEqual({
      rating: 4, recommendation: 'advance', comments: 'Strong on key accounts.', comments_cut: false, recorded_at: SAVED, recorded: 'Wed 7 Oct 2026, 10:05 am',
    });
    for (const id of ['bare', 'ahead', 'off']) expect(rows.get(id).feedback, id).toBeNull();
  });
  it('cuts comments longer than 600 characters and says so', async () => {
    const out = await list({}, from(interview('long', { feedback: { ...FEEDBACK, comments: 'c'.repeat(601) } })));
    expect(out.interviews[0].feedback).toMatchObject({ comments: `${'c'.repeat(600)}…`, comments_cut: true });
  });
  it('filters on feedback: those that have some, or the completed ones that have none yet', async () => {
    expect((await list({ hasFeedback: true }, four)).interviews.map((i: { id: string }) => i.id)).toEqual(['rated']);
    expect((await list({ hasFeedback: false }, four)).interviews.map((i: { id: string }) => i.id)).toEqual(['bare']);
    expect((await list({ hasFeedback: false }, four)).total).toBe(1);
    expect((await list({}, four)).total).toBe(4);
    expect((await list({ hasFeedback: true, candidate: 'farid' }, four)).total).toBe(0);
  });
  it('never lets the model choose the workspace, and takes no id', () => {
    const shape = (createHireTools(four, NOW).listInterviews as unknown as { inputSchema: { shape: Record<string, unknown> } }).inputSchema.shape;
    expect(Object.keys(shape).sort()).toEqual(['candidate', 'hasFeedback', 'jobTitle', 'limit', 'status', 'when']);
  });
});

describe('the Approve cards for feedback', () => {
  const listed = { tool: 'listInterviews', output: { total: 1, interviews: [{ id: IV, application_id: 'a1', candidate: 'Aina Rahman', job: 'Sales Executive', status: 'completed' }] } };
  const found = nameIn([listed]);
  const LAST = 'This does not move or reject the application.';

  it('both tools are about an interview, and their results name it for a later turn', () => {
    expect(kindOfTool('saveInterviewFeedback')).toBe('interview');
    expect(kindOfTool('clearInterviewFeedback')).toBe('interview');
    const result = { tool: 'saveInterviewFeedback', output: { ok: true, data: { id: IV, candidate: 'Aina Rahman', job: 'Sales Executive', message: 'Saved.' } } };
    expect(collectNames([result])[`interview:${IV}`]).toBe('Aina Rahman (Sales Executive)');
  });
  it('titles name the person and the job from a lookup, or say the interview was not listed', () => {
    expect(approvalTitle('saveInterviewFeedback', { id: IV, rating: 4, recommendation: 'advance' }, found)).toBe('Record feedback on the interview with Aina Rahman (Sales Executive)?');
    expect(approvalTitle('clearInterviewFeedback', { id: IV }, found)).toBe('Clear the feedback on the interview with Aina Rahman (Sales Executive)?');
    expect(approvalTitle('saveInterviewFeedback', { id: 'a1', rating: 4, recommendation: 'advance' }, found))
      .toBe('Record feedback on the interview with an interview that was not in the list above?');
  });
  it('the second line shows everything that will be saved: the rating, the recommendation, the comments, the grounds, and whether it REPLACES', () => {
    expect(approvalDetail('saveInterviewFeedback', { id: IV, rating: 4, recommendation: 'advance', comments: 'Strong on key accounts.' }))
      .toBe(`4 out of 5 · Recommendation: Advance · Comments: Strong on key accounts. · ${LAST}`);
    expect(approvalDetail('saveInterviewFeedback', { id: IV, rating: 2, recommendation: 'reject', basis: 'She could not explain her pipeline numbers.', replace: true }))
      .toBe(`2 out of 5 · Recommendation: Reject · No comments · Why: She could not explain her pipeline numbers. · Replaces the feedback already recorded. · ${LAST}`);
    expect(approvalDetail('saveInterviewFeedback', { id: IV, rating: 4, recommendation: 'advance', mark_completed: true }))
      .toBe(`4 out of 5 · Recommendation: Advance · No comments · Also marks the interview completed. · ${LAST}`);
    expect(approvalDetail('saveInterviewFeedback', { id: IV, rating: 4, recommendation: 'advance', comments: 'c'.repeat(2000) }))
      .toBe(`4 out of 5 · Recommendation: Advance · Comments: ${'c'.repeat(600)}… (and 1,400 more characters) · ${LAST}`);
    expect(approvalDetail('clearInterviewFeedback', { id: IV })).toBe('The rating, the recommendation and the comments are removed. This cannot be undone.');
  });
  it('4a\'s cards and the application rating\'s card are worded as before', () => {
    expect(approvalDetail('cancelInterview', { id: IV })).toBe('It stays in the list as cancelled. Nothing is sent to the candidate.');
    expect(approvalDetail('rateApplication', { id: IV, rating: 4, basis: 'Six years in sales.' })).toBe('Why: Six years in sales.');
  });
  it('the list of values holds every value whole, under labels a person can read', () => {
    const input = { id: IV, rating: 4, recommendation: 'advance', comments: 'c'.repeat(2000), mark_completed: true, replace: true, basis: 'Because of the two enterprise deals.' };
    const rows = changeRows('saveInterviewFeedback', input, found);
    expect(rows.map((row) => [row.label, row.to])).toEqual([
      ['Interview', 'Aina Rahman (Sales Executive)'],
      ['Rating', '4'],
      ['Recommendation', 'advance'],
      ['Comments', 'c'.repeat(2000)],
      ['Also marks it completed', 'Yes'],
      ['Replaces existing feedback', 'Yes'],
      ['Why (shown here, not saved)', 'Because of the two enterprise deals.'],
    ]);
    expect(changeRows('clearInterviewFeedback', { id: IV }, found).map((row) => [row.label, row.to])).toEqual([['Interview', 'Aina Rahman (Sales Executive)']]);
    // The same label on the application rating's card: `basis` is one field wherever it is.
    expect(changeRows('rateApplication', { id: 'x', rating: 4, basis: 'Six years in sales.' }).map((row) => row.label)).toContain('Why (shown here, not saved)');
  });
});
