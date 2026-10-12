// tests/chat-denied-step.test.tsx
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovalCard, ToolStepCard } from '@/components/chat/tool-cards';
import { refusalForUser, toPendingApproval, toToolStep } from '@/components/chat/tool-parts';
import {
  AMBIGUOUS_DELETION, DELETION_CHECK_FAILED, NAMESAKE_APPEARED, ONE_DELETION, lookTheSameApplications, lookTheSameCandidates, notLookedUp,
} from '@/lib/ai/hire-deletions';
import {
  AMBIGUOUS_POOL_CHANGE, NOT_IN_POOL_MOVE, ONE_POOL_CHANGE, POOL_CHECK_FAILED, POOL_NAMESAKE_APPEARED, jobNotLookedUp,
  lookTheSameInPool, poolNotLookedUp,
} from '@/lib/ai/hire-pool-gate';
import {
  AMBIGUOUS_INTERVIEW_CHANGE, APPLICATION_NOT_ACTIVE, INTERVIEW_CHANGED_SINCE, INTERVIEW_GONE, LINK_HIDDEN, LINK_IN_INTERVIEWER, NOTHING_WOULD_CHANGE, SAME_TIME_SENT, INTERVIEW_CHECK_FAILED, LINK_NOT_GIVEN, ONE_INTERVIEW_CHANGE, interviewNotLookedUp,
  lookTheSameInterviews,
} from '@/lib/ai/hire-interview-gate';

/**
 * A change can be stopped in two ways: the user says no on its card, or the
 * server refuses it before any card exists (one deletion a turn, an unclear
 * name). Only the first is the user's doing, and the chat must not say
 * otherwise. As the server sends it: no DOM here, so nothing is pressed.
 */
const REASON = 'One deletion at a time. One is already prepared for approval.';
const SHOWN = 'Only one deletion is prepared at a time, and one was already prepared. Ask for this one again afterwards.';
const part = (approval: Record<string, unknown>, state = 'output-denied') =>
  ({ type: 'tool-deleteCandidate', toolCallId: 'c1', state, input: { id: 'x' }, approval }) as never;

describe('a change that did not run', () => {
  it('keeps the server\'s reason when it refused the change itself', () => {
    expect(toToolStep(part({ id: 'r1', approved: false, reason: REASON, isAutomatic: true }), 'm', 0)).toMatchObject({ denied: true, reason: SHOWN });
    // A chat opened again keeps the reason and not the automatic mark.
    expect(toToolStep(part({ id: 'r1', approved: false, reason: REASON }), 'm', 0)).toMatchObject({ denied: true, reason: SHOWN });
  });
  it('has no reason when the user said no', () => {
    const step = toToolStep(part({ id: 'r1', approved: false }), 'm', 0)!;
    expect(step.denied).toBe(true);
    expect(step.reason).toBeUndefined();
    expect(toToolStep(part({ id: 'r1', approved: false, reason: '' }), 'm', 0)!.reason).toBeUndefined();
  });
  it('has no reason on a change that ran', () => {
    const step = toToolStep(part({ id: 'r1', approved: true, reason: 'fine' }, 'output-available'), 'm', 0)!;
    expect(step.denied).toBe(false);
    expect(step.reason).toBeUndefined();
  });
  it('shows the reason, and does not say "Not approved", for a change the server refused', () => {
    const html = renderToStaticMarkup(<ToolStepCard step={toToolStep(part({ id: 'r1', approved: false, reason: REASON, isAutomatic: true }), 'm', 0)!} />);
    expect(html).toContain(SHOWN);
    expect(html).not.toContain(REASON);
    expect(html).toContain('Not shown for approval');
    expect(html).not.toContain('Not approved');
  });
  it('still reads "Not approved" for a change the user rejected', () => {
    const html = renderToStaticMarkup(<ToolStepCard step={toToolStep(part({ id: 'r1', approved: false }), 'm', 0)!} />);
    expect(html).toContain('Not approved');
    expect(html).not.toContain('Not shown for approval');
  });
});

describe('a card waiting for the user', () => {
  it('is not made for a request the server answered itself', () => {
    expect(toPendingApproval(part({ id: 'r1' }, 'approval-requested'))).toMatchObject({ approvalId: 'r1', toolName: 'deleteCandidate' });
    expect(toPendingApproval(part({ id: 'r1', isAutomatic: true }, 'approval-requested'))).toBeNull();
  });
});

describe('a card for a deletion when two people share the name', () => {
  const LINE = 'More than one candidate is called Aisyah Lim. This one: aina.r@example.com · added 03 Oct 2026.';
  const ID = '11111111-1111-4111-8111-111111111111';
  const named = () => 'Aisyah Lim';
  it('takes the line from the request the server made, never from the change\'s input', () => {
    expect(toPendingApproval(part({ id: 'r1', requestReason: LINE }, 'approval-requested'))).toMatchObject({ note: LINE });
    expect(toPendingApproval(part({ id: 'r1' }, 'approval-requested'))).not.toHaveProperty('note');
    expect(toPendingApproval(part({ id: 'r1', requestReason: '  ' }, 'approval-requested'))).not.toHaveProperty('note');
  });
  it('shows the line between the title and the warning', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard approval={{ approvalId: 'r1', toolName: 'deleteCandidate', input: { id: ID }, note: LINE }} named={named} onDecide={() => {}} />,
    );
    const [title, line, warning] = ['Delete candidate “Aisyah Lim”?', LINE, 'Every application, interview and CV file of theirs is deleted too. This cannot be undone.'].map((s) => html.indexOf(s));
    expect(title).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(title);
    expect(warning).toBeGreaterThan(line);
  });
  it('is the card it always was when nobody shares the name', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard approval={{ approvalId: 'r1', toolName: 'deleteCandidate', input: { id: ID } }} named={named} onDecide={() => {}} />,
    );
    expect(html).toContain('Delete candidate “Aisyah Lim”?');
    expect(html).toContain('Every application, interview and CV file of theirs is deleted too. This cannot be undone.');
    expect(html).not.toContain('More than one');
  });
});

// When the user approves and the server's last check then stops the change, the browser is told only that the
// call was denied (the SDK sends `tool-output-denied` and nothing else): the part still says `approved: true`.
describe('a change the user approved that a last check stopped', () => {
  const stopped = part({ id: 'r1', approved: true });
  it('is told apart from a rejection and from a change that was never shown', () => {
    expect(toToolStep(stopped, 'm', 0)).toMatchObject({ denied: true, afterApproval: true });
    expect(toToolStep(part({ id: 'r1', approved: false }), 'm', 0)).not.toHaveProperty('afterApproval');
    expect(toToolStep(part({ id: 'r1', approved: false, reason: REASON, isAutomatic: true }), 'm', 0)).not.toHaveProperty('afterApproval');
    expect(toToolStep(part({ id: 'r1', approved: true }, 'output-available'), 'm', 0)).not.toHaveProperty('afterApproval');
  });
  it('reads "Not done" with a line that says the approval was theirs and nothing changed', () => {
    const html = renderToStaticMarkup(<ToolStepCard step={toToolStep(stopped, 'm', 0)!} />);
    expect(html).toContain('Not done');
    expect(html).toContain('This was approved, but a last check stopped it. Nothing was changed.');
    expect(html).not.toContain('Not approved');
    expect(html).not.toContain('Not shown for approval');
  });
});

// The reason on a refused change was written for the model: it can name tools and carry a row's id. What the
// person reads is a line written for them, chosen by how the reason begins. The reasons are the server's own
// constants, so this fails if one of them is reworded without its line here.
describe('the line a person reads on a change the server refused', () => {
  const ID = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  const each: [string, string][] = [
    [ONE_DELETION, SHOWN],
    [AMBIGUOUS_DELETION, 'More than one record matches that name, so nothing was prepared. Say which one you mean, then ask again.'],
    [notLookedUp('candidate', ID), 'The assistant had not looked this record up, so nothing was prepared. Ask again and it will look it up first.'],
    [notLookedUp('application', ID), 'The assistant had not looked this record up, so nothing was prepared. Ask again and it will look it up first.'],
    [NAMESAKE_APPEARED, 'A last check stopped this, because someone else with the same name had appeared. Nothing was deleted. Ask for it again.'],
    // These three were written for a person already, and say whose name it is.
    [lookTheSameCandidates('Aisyah Lim'), lookTheSameCandidates('Aisyah Lim')],
    [lookTheSameApplications('Aisyah Lim', 'Barista'), lookTheSameApplications('Aisyah Lim', 'Barista')],
    [DELETION_CHECK_FAILED, DELETION_CHECK_FAILED],
    [ONE_POOL_CHANGE, 'Only one talent pool change is prepared at a time, and one was already prepared. Ask for this one again afterwards.'],
    [AMBIGUOUS_POOL_CHANGE, 'More than one record matches that name, so nothing was prepared. Say which one you mean, then ask again.'],
    [poolNotLookedUp(ID), 'The assistant had not looked this record up, so nothing was prepared. Ask again and it will look it up first.'],
    [jobNotLookedUp(ID), 'The assistant had not looked this record up, so nothing was prepared. Ask again and it will look it up first.'],
    [NOT_IN_POOL_MOVE, 'This person is not in the talent pool, so no move was prepared. Add them to the talent pool first, then ask again.'],
    [POOL_NAMESAKE_APPEARED, 'A last check stopped this, because someone else with the same name had appeared. Nothing was changed. Ask for it again.'],
    // Written for a person already.
    [lookTheSameInPool('Zarina Lau'), lookTheSameInPool('Zarina Lau')],
    [POOL_CHECK_FAILED, POOL_CHECK_FAILED],
    [ONE_INTERVIEW_CHANGE, 'Only one interview change is prepared at a time, and one was already prepared. Ask for this one again afterwards.'],
    [interviewNotLookedUp(ID), 'The assistant had not looked this record up, so nothing was prepared. Ask again and it will look it up first.'],
    [AMBIGUOUS_INTERVIEW_CHANGE, 'More than one record matches that name, so nothing was prepared. Say which one you mean, then ask again.'],
    [LINK_NOT_GIVEN, 'That link was not one you gave since the last interview card, so nothing was prepared: give the link again in your message, or ask again without one.'],
    [INTERVIEW_CHANGED_SINCE, 'A last check stopped this, because the interview had been changed since the card was shown. Nothing was changed. Ask for it again.'],
    // Written for a person already.
    [lookTheSameInterviews('Aina Rahman', 'Sales Executive'), lookTheSameInterviews('Aina Rahman', 'Sales Executive')],
    [INTERVIEW_CHECK_FAILED, INTERVIEW_CHECK_FAILED],
    [INTERVIEW_GONE, INTERVIEW_GONE],
    [APPLICATION_NOT_ACTIVE, APPLICATION_NOT_ACTIVE],
    [SAME_TIME_SENT, 'The time given was the time this interview already has, so nothing was prepared. Ask again for only what should change.'],
    [NOTHING_WOULD_CHANGE, NOTHING_WOULD_CHANGE],
    // Tuah's team, of a change whose record was already answered (the sentence is the proposal store's own).
    [
      'This change is no longer waiting for approval: it was already answered, it waited more than an hour, or it is not one that was prepared here. Nothing was saved. If the user still wants it, prepare it again.',
      'This change is no longer waiting for approval: it was already answered, or it waited too long. Nothing was saved. Ask for it again if you still want it.',
    ],
    [LINK_HIDDEN, 'That link had hidden characters in it, so nothing was prepared: type the link out by hand in your message, or ask again without one.'],
    [LINK_IN_INTERVIEWER, 'The interviewer\'s name held a link, so nothing was prepared. A link goes in the Place or link field: give it as the place and ask again, or type it there on the Interviews screen.'],
  ];
  it.each(each)('%s', (reason, line) => {
    expect(refusalForUser(reason)).toBe(line);
  });
  it('never shows an id, a tool\'s name or words meant for the model', () => {
    for (const [reason] of each) {
      const line = refusalForUser(reason);
      expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(line).not.toMatch(/list[A-Z]|Never guess|Stop here|ask the user|Prepare it again/);
    }
  });
  it('shows nothing of a reason it does not know', () => {
    expect(refusalForUser(`Some new refusal about ${ID} and listCandidates`)).toBe('This was stopped before it was shown for approval. Nothing was changed.');
  });
  it('is what the step carries', () => {
    const step = toToolStep(part({ id: 'r1', approved: false, reason: notLookedUp('candidate', ID), isAutomatic: true }), 'm', 0)!;
    expect(step.reason).toBe('The assistant had not looked this record up, so nothing was prepared. Ask again and it will look it up first.');
    expect(renderToStaticMarkup(<ToolStepCard step={step} />)).not.toContain(ID);
  });
});
