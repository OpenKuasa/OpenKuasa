// tests/chat-denied-step.test.tsx
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovalCard, ToolStepCard } from '@/components/chat/tool-cards';
import { toPendingApproval, toToolStep } from '@/components/chat/tool-parts';

/**
 * A change can be stopped in two ways: the user says no on its card, or the
 * server refuses it before any card exists (one deletion a turn, an unclear
 * name). Only the first is the user's doing, and the chat must not say
 * otherwise. As the server sends it: no DOM here, so nothing is pressed.
 */
const REASON = 'One deletion at a time. One is already prepared for approval.';
const part = (approval: Record<string, unknown>, state = 'output-denied') =>
  ({ type: 'tool-deleteCandidate', toolCallId: 'c1', state, input: { id: 'x' }, approval }) as never;

describe('a change that did not run', () => {
  it('keeps the server\'s reason when it refused the change itself', () => {
    expect(toToolStep(part({ id: 'r1', approved: false, reason: REASON, isAutomatic: true }), 'm', 0)).toMatchObject({ denied: true, reason: REASON });
    // A chat opened again keeps the reason and not the automatic mark.
    expect(toToolStep(part({ id: 'r1', approved: false, reason: REASON }), 'm', 0)).toMatchObject({ denied: true, reason: REASON });
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
    expect(html).toContain(REASON);
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
