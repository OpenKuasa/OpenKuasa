import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FinanceNoteEntityType } from '@/lib/finance/agent/scan';
import { buildFinanceAgentsView, type FinanceNoteView } from '@/screens/finance/agents-view';

const action = vi.hoisted(() => ({ del: vi.fn() }));
vi.mock('@/app/(app)/finance/agent-actions', () => ({ deleteFinanceAgentNoteAction: action.del }));

const { AgentNotesListBody, deleteNoteStep } = await import('@/components/finance/agent-notes-list');
type State = Parameters<typeof AgentNotesListBody>[0]['state'];

/**
 * There is no DOM here (node, no jsdom, no testing library), so a press is made by calling the
 * pressed element's own onClick from the list's element tree, and the list's state is driven by hand
 * the way AgentNotesList drives it: Delete asks, the question's button deletes, a refusal shows.
 */

const NOTE: FinanceNoteView = {
  id: 'n1',
  entityType: 'finance_invoice',
  entityId: 'i1',
  entityLabel: 'INV-0042',
  body: 'Overdue 14 days (as of 09 Oct 2026)',
  approvedBy: 'Aisyah',
  createdAt: '2026-10-09T02:00:00Z',
  href: '/finance/invoices',
};

type Props = { onClick?: () => void; children?: ReactNode; 'aria-label'?: string };

/** Every element in a tree of unrendered elements (function components are not called). */
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

const textOf = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(textOf).join('') : isValidElement<Props>(node) ? textOf(node.props.children) : node == null || typeof node === 'boolean' ? '' : String(node);

/** The button with this accessible name or this text. */
function press(tree: ReactNode, name: string) {
  const el = elements(tree).find((e) => typeof e.props.onClick === 'function' && (e.props['aria-label'] === name || textOf(e.props.children).trim() === name));
  if (!el) throw new Error(`no button "${name}"`);
  el.props.onClick!();
}

const IDLE: State = { confirmingId: null, pending: false, error: null };

function body(state: State, handlers: Partial<{ onAsk: (id: string) => void; onConfirm: (id: string) => void; onCancel: () => void }> = {}) {
  return AgentNotesListBody({
    notes: [NOTE],
    canEdit: true,
    state,
    onAsk: handlers.onAsk ?? (() => {}),
    onConfirm: handlers.onConfirm ?? (() => {}),
    onCancel: handlers.onCancel ?? (() => {}),
  });
}

describe('deleting an agent note', () => {
  it('asks first, then shows the refusal when the delete is refused', async () => {
    action.del.mockResolvedValueOnce({ ok: false, error: 'That note is already gone, or you may not delete it.' });
    let state = IDLE;

    // Delete only asks: nothing is deleted yet.
    press(body(state, { onAsk: (id) => (state = { ...state, confirmingId: id }) }), 'Delete note on INV-0042');
    expect(state.confirmingId).toBe('n1');
    expect(action.del).not.toHaveBeenCalled();
    const asking = renderToStaticMarkup(body(state));
    expect(asking).toContain('Delete this note? The document itself is not changed.');
    expect(asking).toContain('role="group" aria-label="Delete note on INV-0042"');

    // The question's own button deletes; the refusal comes back and shows under it.
    let confirmed: string | null = null;
    press(body(state, { onConfirm: (id) => (confirmed = id) }), 'Delete note');
    expect(confirmed).toBe('n1');
    state = { ...state, error: await deleteNoteStep(action.del, confirmed!) };
    expect(action.del).toHaveBeenCalledWith('n1');

    const html = renderToStaticMarkup(body(state));
    expect(html).toContain('<p role="alert" class="text-destructive">That note is already gone, or you may not delete it.</p>');
  });

  it('Cancel puts the row back', () => {
    let cancelled = false;
    press(body({ ...IDLE, confirmingId: 'n1' }, { onCancel: () => (cancelled = true) }), 'Cancel');
    expect(cancelled).toBe(true);
    expect(renderToStaticMarkup(body(IDLE))).not.toContain('Delete this note?');
  });

  it('turns a thrown action into a plain sentence, and a delete that went through into no refusal', async () => {
    expect(await deleteNoteStep(async () => { throw new Error('network'); }, 'n1')).toBe('Something went wrong.');
    expect(await deleteNoteStep(async () => ({ ok: true }), 'n1')).toBeNull();
  });

  it('names View and Delete after the note’s document', () => {
    const html = renderToStaticMarkup(body(IDLE));
    expect(html).toContain('aria-label="View INV-0042"');
    expect(html).toContain('aria-label="Delete note on INV-0042"');
  });

  it('offers no Delete to someone who cannot edit', () => {
    const html = renderToStaticMarkup(AgentNotesListBody({ notes: [NOTE], canEdit: false, state: IDLE, onAsk: () => {}, onConfirm: () => {}, onCancel: () => {} }));
    expect(html).not.toContain('Delete');
    expect(html).toContain('aria-label="View INV-0042"');
  });
});

describe('the View link of each kind of note', () => {
  const cases: [FinanceNoteEntityType, string | null, string][] = [
    ['finance_invoice', 'i1', '/finance/invoices'],
    ['finance_supplier_bill', 'b1', '/finance/supplier-bills'],
    ['finance_expense', 'e1', '/finance/expenses'],
    ['finance_quotation', 'q1', '/finance/quotations'],
    ['finance_bank_account', 'a1', '/finance/banking'],
    ['finance_sst_period', null, '/finance/sst-report'],
  ];

  it.each(cases)('%s links to %s', (entityType, entityId, href) => {
    const view = buildFinanceAgentsView({
      config: null,
      hasActiveSchedule: false,
      pending: [],
      decided: [],
      runs: [],
      suggestionsByRun: {},
      spentTodayCents: 0,
      spentWeekCents: 0,
      hasKey: true,
      notes: [{ ...NOTE, entityType, entityId }],
    });
    const html = renderToStaticMarkup(AgentNotesListBody({ notes: view.notes, canEdit: true, state: IDLE, onAsk: () => {}, onConfirm: () => {}, onCancel: () => {} }));
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain('aria-label="View INV-0042"');
  });
});
