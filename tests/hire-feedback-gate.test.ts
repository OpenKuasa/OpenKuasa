// tests/hire-feedback-gate.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import { isGateReason, type DeletionGate } from '@/lib/ai/hire-deletions';
import {
  ALREADY_COMPLETED, FEEDBACK_BLOCKS_REOPEN, FEEDBACK_EXISTS, FEEDBACK_NOT_COMPLETED, HIRE_FEEDBACK_TOOL_NAMES, HIRE_INTERVIEW_KIND_TOOL_NAMES,
  HIRE_INTERVIEW_TOOL_NAMES, INTERVIEW_CHANGED_SINCE, INTERVIEW_CHECK_FAILED, INTERVIEW_GONE, NO_FEEDBACK_TO_CLEAR, NO_FEEDBACK_TO_REPLACE, ONE_INTERVIEW_CHANGE,
  feedbackNotHeld, feedbackRuleProblem, guardInterviewChanges, interviewCardDecision, interviewCheckFor, interviewNotLookedUp,
} from '@/lib/ai/hire-interview-gate';
import { refusalForUser } from '@/components/chat/tool-parts';
import type { Feedback } from '@/lib/hire/interview-feedback';
import { interviewCardFromLists } from '@/lib/hire/namesakes';
import { createSeedHireData } from '@/lib/hire/seed';
import type { InterviewStatus } from '@/lib/hire/types';

const NOW = new Date('2026-10-10T04:00:00Z');
const APP = '44444444-4444-4444-8444-444444444481';
const IV = '11111111-1111-4111-8111-111111111181';
const IV2 = '22222222-2222-4222-8222-222222222282';
const MADE_UP = '99999999-9999-4999-8999-999999999981';
// A name and a job nobody else in the sample data has.
const WHO = 'Putri Maisarah Dahlan';
const JOB = 'Night Auditor';
/** 3:00 pm on Tuesday 6 October 2026 in Kuala Lumpur; 11:00 am on Thursday 1 October. */
const AT = '2026-10-06T07:00:00.000Z';
const EARLIER = '2026-10-01T03:00:00.000Z';
/** 10:05:40 am on Wednesday 7 October 2026 in Kuala Lumpur. */
const SAVED = '2026-10-07T02:05:40.000Z';
const STORED: Feedback = { rating: 3, recommendation: 'hold', comments: 'Unsure about night shifts.', recorded_at: SAVED };
const LINE = 'This interview: Tue 6 Oct 2026, 3:00 pm · video · 1 hour · No place or link given';
const NONE_YET = `${LINE}\nNow: completed · no feedback yet`;
const HAS = `${LINE}\nNow: completed · feedback 3 out of 5 · Hold · saved Wed 7 Oct 2026, 10:05:40 am`;
const SAVE = { id: IV, rating: 4, recommendation: 'advance' };

type State = { status: InterviewStatus; feedback: Feedback | null; second?: InterviewStatus; fail?: boolean; gone?: boolean };
/** One application with one interview (and, with `second`, an earlier one); the checks read these rows. */
const world = (state: State) => {
  const base = createSeedHireData(NOW);
  const interview = (id: string, scheduled_at: string, status: InterviewStatus, feedback: Feedback | null) => ({
    id, application_id: APP, candidate_name: WHO, job_title: JOB, scheduled_at, kind: 'video' as const, interviewer_name: null, status,
    created_at: '2026-09-25T02:00:00.000Z', updated_at: '2026-10-06T08:00:00.000Z', duration_minutes: 60, place: null, notes: null,
    application_stage: 'interview' as const, application_outcome: 'active' as const, ...(feedback ? { feedback } : {}),
  });
  const listInterviews = async () => [
    ...(state.gone ? [] : [interview(IV, AT, state.status, state.feedback)]),
    ...(state.second ? [interview(IV2, EARLIER, state.second, null)] : []),
  ];
  const listApplications = async () =>
    (await base.listApplications()).map((a, n) => (n === 0 ? { ...a, id: APP, candidate_name: WHO, job_title: JOB, stage: 'interview' as const, outcome: 'active' as const } : a));
  const interviewCard = async (id: unknown) => {
    if (state.fail) throw new Error('putri@example.my could not be read');
    return interviewCardFromLists(id, await listInterviews(), await listApplications());
  };
  return { ...base, listInterviews, listApplications, interviewCard };
};
const check = (state: State) => interviewCheckFor(world(state));
const COMPLETED: State = { status: 'completed', feedback: null };
const RATED: State = { status: 'completed', feedback: STORED };
const SCHEDULED: State = { status: 'scheduled', feedback: null };

describe('the feedback tools are members of the interview kind', () => {
  it('4a\'s six are as they were, and the kind is the six followed by the two', () => {
    expect(HIRE_INTERVIEW_TOOL_NAMES).toEqual(['scheduleInterview', 'recordPastInterview', 'rescheduleInterview', 'cancelInterview', 'setInterviewOutcome', 'reopenInterview']);
    expect(HIRE_FEEDBACK_TOOL_NAMES).toEqual(['saveInterviewFeedback', 'clearInterviewFeedback']);
    expect(HIRE_INTERVIEW_KIND_TOOL_NAMES).toEqual([...HIRE_INTERVIEW_TOOL_NAMES, ...HIRE_FEEDBACK_TOOL_NAMES]);
  });
});

describe('what feedback\'s own rules refuse', () => {
  const at = (status: InterviewStatus, feedback: Feedback | null = null) => ({ status, ...(feedback ? { feedback } : {}) });
  it('a save on a completed interview: the input must say replace exactly when feedback is there, and never mark_completed', () => {
    expect(feedbackRuleProblem('saveInterviewFeedback', SAVE, at('completed'))).toBeNull();
    expect(feedbackRuleProblem('saveInterviewFeedback', { ...SAVE, replace: true }, at('completed', STORED))).toBeNull();
    expect(feedbackRuleProblem('saveInterviewFeedback', SAVE, at('completed', STORED))).toBe(FEEDBACK_EXISTS);
    expect(feedbackRuleProblem('saveInterviewFeedback', { ...SAVE, replace: false }, at('completed', STORED))).toBe(FEEDBACK_EXISTS);
    expect(feedbackRuleProblem('saveInterviewFeedback', { ...SAVE, replace: true }, at('completed'))).toBe(NO_FEEDBACK_TO_REPLACE);
    expect(feedbackRuleProblem('saveInterviewFeedback', { ...SAVE, mark_completed: true }, at('completed'))).toBe(ALREADY_COMPLETED);
    expect(feedbackRuleProblem('saveInterviewFeedback', { ...SAVE, mark_completed: false }, at('completed'))).toBeNull();
  });
  it('a save on a scheduled interview: only with mark_completed, and never as a replacement', () => {
    expect(feedbackRuleProblem('saveInterviewFeedback', SAVE, at('scheduled'))).toBe(FEEDBACK_NOT_COMPLETED);
    expect(feedbackRuleProblem('saveInterviewFeedback', { ...SAVE, mark_completed: 'true' }, at('scheduled'))).toBe(FEEDBACK_NOT_COMPLETED);
    expect(feedbackRuleProblem('saveInterviewFeedback', { ...SAVE, mark_completed: true }, at('scheduled'))).toBeNull();
    expect(feedbackRuleProblem('saveInterviewFeedback', { ...SAVE, mark_completed: true, replace: true }, at('scheduled'))).toBe(NO_FEEDBACK_TO_REPLACE);
  });
  it('a save on an interview that did not take place is refused whatever was sent, and says which it was', () => {
    for (const input of [SAVE, { ...SAVE, mark_completed: true }, { ...SAVE, replace: true }]) {
      expect(feedbackRuleProblem('saveInterviewFeedback', input, at('cancelled'))).toBe(feedbackNotHeld('cancelled'));
      expect(feedbackRuleProblem('saveInterviewFeedback', input, at('no_show'))).toBe(feedbackNotHeld('no_show'));
    }
    expect(feedbackNotHeld('cancelled')).toBe(
      'This interview did not take place (it is marked cancelled), so it cannot have feedback. Nothing was changed. ' +
        'If it did take place, use “Mark as scheduled again” and then “Mark completed and add feedback” on the Interviews screen.',
    );
    expect(feedbackNotHeld('no_show')).toContain('(it is marked as a no-show)');
  });
  it('a clear needs feedback to clear; "scheduled again" is refused while there is some', () => {
    expect(feedbackRuleProblem('clearInterviewFeedback', { id: IV }, at('completed', STORED))).toBeNull();
    expect(feedbackRuleProblem('clearInterviewFeedback', { id: IV }, at('completed'))).toBe(NO_FEEDBACK_TO_CLEAR);
    expect(feedbackRuleProblem('reopenInterview', { id: IV }, at('completed', STORED))).toBe(FEEDBACK_BLOCKS_REOPEN);
    expect(feedbackRuleProblem('reopenInterview', { id: IV }, at('completed'))).toBeNull();
    expect(feedbackRuleProblem('reopenInterview', { id: IV }, at('cancelled'))).toBeNull();
  });
  it('has nothing to say about 4a\'s other changes; an input that is not an object is read as one that sets nothing', () => {
    for (const tool of ['cancelInterview', 'setInterviewOutcome', 'rescheduleInterview', 'scheduleInterview']) {
      expect(feedbackRuleProblem(tool, { id: IV }, at('completed', STORED)), tool).toBeNull();
    }
    expect(feedbackRuleProblem('saveInterviewFeedback', null, at('completed'))).toBeNull();
    expect(feedbackRuleProblem('saveInterviewFeedback', null, at('completed', STORED))).toBe(FEEDBACK_EXISTS);
  });
  it('the sentences, word for word', () => {
    expect(FEEDBACK_NOT_COMPLETED).toBe(
      'This interview is still marked scheduled, so no feedback was prepared. Feedback is for a completed interview: ask the user whether it took place. ' +
        'If they said it did, prepare it again with mark_completed set to true.',
    );
    expect(FEEDBACK_EXISTS).toBe(
      'This interview already has feedback, so nothing was prepared. Tell the user what the feedback is and ask whether to replace it. ' +
        'If they say yes, prepare it again with replace set to true.',
    );
    expect(NO_FEEDBACK_TO_REPLACE).toBe('This interview has no feedback yet, so there is nothing to replace. Prepare it again without replace.');
    expect(NO_FEEDBACK_TO_CLEAR).toBe('This interview has no feedback to clear. Nothing was changed.');
    expect(ALREADY_COMPLETED).toBe('This interview is already marked completed. Prepare it again without mark_completed.');
    expect(FEEDBACK_BLOCKS_REOPEN).toBe(
      'This interview has feedback, so it cannot be marked as scheduled again. Nothing was changed. ' +
        'Clear the feedback first: ask for that on its own, or use “Clear feedback” on the Interviews screen.',
    );
  });
  it('each is a gate reason (so it is never the turn\'s one), and what a person reads has no id and no words meant for the model', () => {
    const all = [FEEDBACK_NOT_COMPLETED, feedbackNotHeld('cancelled'), feedbackNotHeld('no_show'), FEEDBACK_EXISTS, NO_FEEDBACK_TO_REPLACE, NO_FEEDBACK_TO_CLEAR, ALREADY_COMPLETED, FEEDBACK_BLOCKS_REOPEN];
    for (const reason of all) {
      expect(isGateReason(reason), reason).toBe(true);
      const line = refusalForUser(reason);
      expect(line, reason).not.toBe('This was stopped before it was shown for approval. Nothing was changed.');
      expect(line, reason).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(line, reason).not.toMatch(/list[A-Z]|Never guess|Stop here|ask the user|Tell the user|Prepare it again|mark_completed|replace set/);
    }
    expect(refusalForUser(FEEDBACK_NOT_COMPLETED)).toBe(
      'This interview is still marked scheduled, so no feedback was prepared. Say that it took place and ask again, or use “Mark completed and add feedback” on the Interviews screen.',
    );
    expect(refusalForUser(FEEDBACK_EXISTS)).toBe(
      'This interview already has feedback, so nothing was prepared. Say that it should be replaced and ask again, or use “Edit feedback” on the Interviews screen.',
    );
    expect(refusalForUser(NO_FEEDBACK_TO_REPLACE)).toBe('This interview had no feedback to replace, so nothing was prepared. Ask again to add the feedback.');
    expect(refusalForUser(ALREADY_COMPLETED)).toBe('This interview was already marked completed, so nothing was prepared. Ask again to add the feedback.');
    // Written for a person already: shown as they are.
    for (const reason of [feedbackNotHeld('cancelled'), NO_FEEDBACK_TO_CLEAR, FEEDBACK_BLOCKS_REOPEN]) expect(refusalForUser(reason)).toBe(reason);
    // A database refusal's sentence is not one of these: it is a result, not a gate's reason.
    expect(isGateReason('Feedback is for a completed interview. Mark this one completed first.')).toBe(false);
  });
});

describe('the server read behind a feedback card', () => {
  it('a card for feedback carries which interview it is and how it stands now, both read from the server\'s row', async () => {
    expect(await check(COMPLETED)('saveInterviewFeedback', SAVE)).toEqual({ ok: true, note: NONE_YET, namesakes: [] });
    expect(await check(RATED)('saveInterviewFeedback', { ...SAVE, replace: true })).toEqual({ ok: true, note: HAS, namesakes: [] });
    expect(await check(RATED)('clearInterviewFeedback', { id: IV })).toEqual({ ok: true, note: HAS, namesakes: [] });
    expect(await check(SCHEDULED)('saveInterviewFeedback', { ...SAVE, mark_completed: true }))
      .toEqual({ ok: true, note: `${LINE}\nNow: scheduled · no feedback yet`, namesakes: [] });
    // Nothing of the input is on the line: not the rating, not the comments.
    const noted = await check(COMPLETED)('saveInterviewFeedback', { ...SAVE, comments: 'Strong on key accounts.' });
    expect(JSON.stringify(noted)).not.toMatch(/key accounts|4 out of 5/);
  });
  it('lists the person\'s other interviews: two completed ones are easily taken for each other', async () => {
    const two = await check({ ...COMPLETED, second: 'completed' })('saveInterviewFeedback', SAVE);
    expect(two).toEqual({ ok: true, note: `${NONE_YET}\nAlso closed for ${WHO}: Thu 1 Oct 2026, 11:00 am · video · completed (${JOB})`, namesakes: [] });
    const ahead = await check({ ...RATED, second: 'scheduled' })('clearInterviewFeedback', { id: IV });
    expect(ahead).toEqual({ ok: true, note: `${HAS}\nAlso scheduled for ${WHO}: Thu 1 Oct 2026, 11:00 am · video (${JOB})`, namesakes: [] });
  });
  it('refuses, before any card, what the rules refuse; an interview that has gone and a failed read are said as 4a says them', async () => {
    expect(await check(RATED)('saveInterviewFeedback', SAVE)).toEqual({ ok: false, refusal: FEEDBACK_EXISTS });
    expect(await check(COMPLETED)('saveInterviewFeedback', { ...SAVE, replace: true })).toEqual({ ok: false, refusal: NO_FEEDBACK_TO_REPLACE });
    expect(await check(SCHEDULED)('saveInterviewFeedback', SAVE)).toEqual({ ok: false, refusal: FEEDBACK_NOT_COMPLETED });
    expect(await check({ status: 'no_show', feedback: null })('saveInterviewFeedback', SAVE)).toEqual({ ok: false, refusal: feedbackNotHeld('no_show') });
    expect(await check(COMPLETED)('clearInterviewFeedback', { id: IV })).toEqual({ ok: false, refusal: NO_FEEDBACK_TO_CLEAR });
    expect(await check(RATED)('reopenInterview', { id: IV })).toEqual({ ok: false, refusal: FEEDBACK_BLOCKS_REOPEN });
    expect(await check({ ...COMPLETED, gone: true })('saveInterviewFeedback', SAVE)).toEqual({ ok: false, refusal: INTERVIEW_GONE });
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await check({ ...COMPLETED, fail: true })('saveInterviewFeedback', SAVE)).toEqual({ ok: false, refusal: INTERVIEW_CHECK_FAILED });
    expect(JSON.stringify(said.mock.calls)).not.toContain('putri@');
    said.mockRestore();
  });
  it('4a\'s cards are as they were: no "Now" line on a change that is not about feedback', async () => {
    expect(await check(SCHEDULED)('cancelInterview', { id: IV })).toEqual({ ok: true, note: LINE, namesakes: [] });
    expect(await check(COMPLETED)('reopenInterview', { id: IV })).toEqual({ ok: true, note: LINE, namesakes: [] });
  });
  it('the last check on Approve: feedback changed or cleared since the card stops the change; another interview coming or going does not', async () => {
    const shown = { note: HAS };
    const replace = { ...SAVE, replace: true };
    // Unchanged: the same card again.
    expect(interviewCardDecision(await check(RATED)('saveInterviewFeedback', replace), shown)).toEqual({ type: 'user-approval', reason: HAS });
    // A colleague edited it one second later.
    const edited: State = { status: 'completed', feedback: { ...STORED, recorded_at: '2026-10-07T02:05:41.000Z' } };
    expect(interviewCardDecision(await check(edited)('saveInterviewFeedback', replace), shown)).toEqual({ type: 'denied', reason: INTERVIEW_CHANGED_SINCE });
    expect(interviewCardDecision(await check(edited)('clearInterviewFeedback', { id: IV }), shown)).toEqual({ type: 'denied', reason: INTERVIEW_CHANGED_SINCE });
    // A colleague cleared it: the rule's own words.
    expect(interviewCardDecision(await check(COMPLETED)('saveInterviewFeedback', replace), shown)).toEqual({ type: 'denied', reason: NO_FEEDBACK_TO_REPLACE });
    // A colleague added feedback after a card that said there was none.
    expect(interviewCardDecision(await check(RATED)('saveInterviewFeedback', SAVE), { note: NONE_YET })).toEqual({ type: 'denied', reason: FEEDBACK_EXISTS });
    // Another closed interview of the person appeared: which interview the yes was for has not changed.
    const more = await check({ ...RATED, second: 'completed' })('saveInterviewFeedback', replace);
    expect(interviewCardDecision(more, shown)).toMatchObject({ type: 'user-approval' });
  });
});

describe('one interview change a turn, feedback included', () => {
  type Gate = DeletionGate;
  const approval = Object.fromEntries(['createJob', 'setInterviewOutcome', ...HIRE_FEEDBACK_TOOL_NAMES].map((name) => [name, 'user-approval'])) as Record<string, 'user-approval'>;
  const listed = [
    { role: 'user', content: `Feedback for ${WHO}: 4, advance` },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'l1', toolName: 'listInterviews', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'l1', toolName: 'listInterviews', output: { type: 'json', value: { total: 2, interviews: [
      { id: IV, application_id: APP, candidate: WHO, job: JOB, status: 'completed' },
      { id: IV2, application_id: APP, candidate: WHO, job: JOB, status: 'scheduled' },
    ] } } }] },
  ] as ModelMessage[];
  const guarded = (state: State) => guardInterviewChanges(approval, check(state))!;
  const ask = (gates: Record<string, 'user-approval' | Gate>, tool: string, input: unknown, toolCallId: string, messages = listed) =>
    (gates[tool] as Gate)(input, { toolCallId, messages });
  const DENIED = { type: 'denied', reason: ONE_INTERVIEW_CHANGE };
  const BOTH: State = { ...COMPLETED, second: 'scheduled' };
  const outcome = { id: IV2, outcome: 'completed' };

  it('gates both tools and leaves every other tool as it was', () => {
    const gates = guarded(COMPLETED);
    expect(gates.createJob).toBe('user-approval');
    for (const name of ['setInterviewOutcome', ...HIRE_FEEDBACK_TOOL_NAMES]) expect(typeof gates[name], name).toBe('function');
  });
  it('the first reaches a card with its lines; a second of the kind in the same request is denied, whichever came first', async () => {
    const a = guarded(BOTH);
    expect(await ask(a, 'saveInterviewFeedback', SAVE, 'c1')).toMatchObject({ type: 'user-approval', reason: expect.stringContaining('Now: completed · no feedback yet') });
    expect(await ask(a, 'setInterviewOutcome', outcome, 'c2')).toEqual(DENIED);
    const b = guarded(BOTH);
    expect(await ask(b, 'setInterviewOutcome', outcome, 'c1')).toMatchObject({ type: 'user-approval' });
    expect(await ask(b, 'saveInterviewFeedback', SAVE, 'c2')).toEqual(DENIED);
    const c = guarded(RATED);
    expect(await ask(c, 'clearInterviewFeedback', { id: IV }, 'c1')).toMatchObject({ type: 'user-approval' });
    expect(await ask(c, 'saveInterviewFeedback', { ...SAVE, replace: true }, 'c2')).toEqual(DENIED);
  });
  it('a feedback card earlier in the turn is the turn\'s one for a later request too; the next message is a new turn', async () => {
    const earlier = [...listed, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'saveInterviewFeedback', input: SAVE }] }] as ModelMessage[];
    expect(await ask(guarded(BOTH), 'setInterviewOutcome', outcome, 'c2', earlier)).toEqual(DENIED);
    const next = [...earlier, { role: 'user', content: 'Now mark the other one completed' }] as ModelMessage[];
    expect(await ask(guarded(BOTH), 'setInterviewOutcome', outcome, 'c3', next)).toMatchObject({ type: 'user-approval' });
  });
  it('a call this gate refused is not the turn\'s one: sent again as the refusal says, it reaches a card', async () => {
    const gates = guarded(SCHEDULED);
    expect(await ask(gates, 'saveInterviewFeedback', SAVE, 'c1')).toEqual({ type: 'denied', reason: FEEDBACK_NOT_COMPLETED });
    expect(await ask(gates, 'saveInterviewFeedback', { ...SAVE, mark_completed: true }, 'c2')).toEqual({ type: 'user-approval', reason: `${LINE}\nNow: scheduled · no feedback yet` });
    // The same across requests: the refused call is in the messages, with its reason.
    const refused = [
      ...listed,
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'saveInterviewFeedback', input: SAVE }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'saveInterviewFeedback', output: { type: 'execution-denied', reason: FEEDBACK_NOT_COMPLETED } }] },
    ] as ModelMessage[];
    expect(await ask(guarded(SCHEDULED), 'saveInterviewFeedback', { ...SAVE, mark_completed: true }, 'c2', refused)).toMatchObject({ type: 'user-approval' });
  });
  it('an id nobody looked up as an interview gets no card, and is told where to get a real one', async () => {
    expect(await ask(guarded(COMPLETED), 'saveInterviewFeedback', { ...SAVE, id: MADE_UP }, 'c1')).toEqual({ type: 'denied', reason: interviewNotLookedUp(MADE_UP) });
    expect(await ask(guarded(COMPLETED), 'clearInterviewFeedback', { id: APP }, 'c1')).toEqual({ type: 'denied', reason: interviewNotLookedUp(APP) });
  });
});
