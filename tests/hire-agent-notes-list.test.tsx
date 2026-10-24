import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HireNoteEntityType } from '@/lib/hire/agent/scan';
import { buildHireAgentsView, type HireNoteView } from '@/screens/hire/agents-view';

const action = vi.hoisted(() => ({ del: vi.fn() }));
vi.mock('@/app/(app)/hire/agent-actions', () => ({ deleteHireAgentNoteAction: action.del }));

const { AgentNotesListBody, deleteNoteStep } = await import('@/components/hire/agent-notes-list');
type State = Parameters<typeof AgentNotesListBody>[0]['state'];

/**
 * No DOM here (node, no jsdom): a press calls the pressed element's own onClick from the list's
 * element tree, and the list's state is driven by hand the way AgentNotesList drives it.
 */

const NOTE: HireNoteView = {
  id: 'n1',
  entityType: 'hire_application',
  entityId: 'a1',
  entityLabel: 'Aina Rahman · Sales Executive',
  body: 'Aina Rahman · Sales Executive has been at Applied for 6 days (as of 20 Oct 2026).',
  approvedBy: 'Farah',
  createdAt: '2026-10-20T02:00:00Z',
  href: '/hire/applications',
};

type Props = { onClick?: () => void; children?: ReactNode; 'aria-label'?: string };

function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

const textOf = (node: ReactNode): string =>
  Array.isArray(node)
    ? node.map(textOf).join('')
    : isValidElement<Props>(node)
      ? textOf(node.props.children)
      : node == null || typeof node === 'boolean'
        ? ''
        : String(node);

function press(tree: ReactNode, name: string) {
  const el = elements(tree).find(
    (e) => typeof e.props.onClick === 'function' && (e.props['aria-label'] === name || textOf(e.props.children).trim() === name),
  );
  if (!el) throw new Error(`no button "${name}"`);
  el.props.onClick!();
}

const IDLE: State = { confirmingId: null, pending: false, error: null };
const LABEL = 'Aina Rahman · Sales Executive';
const noop = () => {};

function body(state: State, handlers: Partial<{ onAsk: (id: string) => void; onConfirm: (id: string) => void; onCancel: () => void }> = {}) {
  return AgentNotesListBody({
    notes: [NOTE],
    canEdit: true,
    state,
    onAsk: handlers.onAsk ?? noop,
    onConfirm: handlers.onConfirm ?? noop,
    onCancel: handlers.onCancel ?? noop,
  });
}

describe('deleting a Lekir agent note', () => {
  it('asks first, then shows the refusal when the delete is refused', async () => {
    action.del.mockResolvedValueOnce({ ok: false, error: 'That note is already gone, or you may not delete it.' });
    let state = IDLE;

    press(body(state, { onAsk: (id) => (state = { ...state, confirmingId: id }) }), `Delete note on ${LABEL}`);
    expect(state.confirmingId).toBe('n1');
    expect(action.del).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(body(state))).toContain('Delete this note? The record itself is not changed.');

    let confirmed: string | null = null;
    press(body(state, { onConfirm: (id) => (confirmed = id) }), 'Delete note');
    expect(confirmed).toBe('n1');
    state = { ...state, error: await deleteNoteStep(action.del, confirmed!) };
    expect(action.del).toHaveBeenCalledWith('n1');
    expect(renderToStaticMarkup(body(state))).toContain(
      '<p role="alert" class="text-destructive">That note is already gone, or you may not delete it.</p>',
    );
  });

  it('Cancel puts the row back', () => {
    let cancelled = false;
    press(body({ ...IDLE, confirmingId: 'n1' }, { onCancel: () => (cancelled = true) }), 'Cancel');
    expect(cancelled).toBe(true);
    expect(renderToStaticMarkup(body(IDLE))).not.toContain('Delete this note?');
  });

  it('turns a thrown action into a plain sentence, and a delete that went through into no refusal', async () => {
    expect(
      await deleteNoteStep(async () => {
        throw new Error('network');
      }, 'n1'),
    ).toBe('Something went wrong.');
    expect(await deleteNoteStep(async () => ({ ok: true }), 'n1')).toBeNull();
  });

  it('shows the label, the note, who approved and when; no Delete for someone who cannot edit', () => {
    const html = renderToStaticMarkup(
      AgentNotesListBody({ notes: [NOTE], canEdit: false, state: IDLE, onAsk: noop, onConfirm: noop, onCancel: noop }),
    );
    expect(html).toContain(LABEL);
    expect(html).toContain('Approved by Farah');
    expect(html).toContain('20 Oct 2026');
    expect(html).not.toContain('Delete');
    expect(html).toContain(`aria-label="View ${LABEL}"`);
  });

  it('says so when there are none and when they could not be read', () => {
    const list = (notes: HireNoteView[] | null) =>
      renderToStaticMarkup(AgentNotesListBody({ notes, canEdit: true, state: IDLE, onAsk: noop, onConfirm: noop, onCancel: noop }));
    expect(list([])).toContain('No notes yet.');
    expect(list(null)).toContain('load the notes');
  });
});

describe('the View link of each kind of note', () => {
  const cases: [HireNoteEntityType, string, string][] = [
    ['hire_application', LABEL, '/hire/applications'],
    ['hire_interview', LABEL, '/hire/interviews'],
    ['hire_job', 'Sales Executive', '/hire/jobs'],
    ['hire_candidate', 'Aina Rahman', '/hire/talent-pool?q=Aina%20Rahman'],
  ];

  it.each(cases)('%s links to its screen', (entityType, entityLabel, href) => {
    const view = buildHireAgentsView({
      config: null,
      hasActiveSchedule: false,
      pending: [],
      decided: [],
      runs: [],
      suggestionsByRun: {},
      spentTodayCents: 0,
      spentWeekCents: 0,
      hasKey: true,
      notes: [{ ...NOTE, entityType, entityLabel }],
    });
    const html = renderToStaticMarkup(
      AgentNotesListBody({ notes: view.notes, canEdit: true, state: IDLE, onAsk: noop, onConfirm: noop, onCancel: noop }),
    );
    expect(html).toContain(`href="${href}"`);
  });
});
