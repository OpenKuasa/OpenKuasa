import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExpensesView, type ExpensesWriter } from '@/components/finance/expenses-view';
import { SAMPLE_EXPENSES } from '@/screens/finance/cash-book-sample';
import { SAMPLE_TODAY } from '@/screens/finance/sales-sample';

/**
 * The Expenses screen as the server sends it: rendered to a string and read as markup (no DOM here). A person
 * who is given no `writer` (a viewer, the demo workspace, the sample) must see nothing that changes data.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

const never = async () => ({ ok: false as const, error: 'no' });
const writer: ExpensesWriter = {
  actions: { save: never, approve: never, reject: never, remove: never },
  canDecide: true,
  contacts: [],
  categories: [],
};

const render = (w?: ExpensesWriter) =>
  renderToStaticMarkup(<ExpensesView rows={SAMPLE_EXPENSES} today={SAMPLE_TODAY} followClock={false} writer={w} />);

describe('the Expenses screen', () => {
  it('has no New expense button, no Actions column and no row menu without a writer', () => {
    const html = render();
    expect(html).toContain('Expenses');
    expect(html).not.toContain('New expense');
    expect(html).not.toContain('Actions');
    expect(html).not.toContain('aria-haspopup');
  });
  it('draws the paperclip in the row of an expense that has a receipt, as a button and not a link', () => {
    const receipts = {
      [SAMPLE_EXPENSES[0].id]: [
        { id: 'r1', file_name: 'petrol-5-oct.png', mime_type: 'image/png' as const, has_file: true, expense_id: SAMPLE_EXPENSES[0].id, bill_id: null },
      ],
    };
    const html = renderToStaticMarkup(
      <ExpensesView rows={SAMPLE_EXPENSES} today={SAMPLE_TODAY} followClock={false} receipts={receipts} receiptLinkOf={never} />,
    );
    expect(html).toContain('aria-label="Download the receipt petrol-5-oct.png"');
    expect(html.match(/Download the receipt/g)).toHaveLength(1);
    expect(html).not.toContain('<a ');
  });
  it('has them for a writer (so the test above would notice them)', () => {
    const html = render(writer);
    expect(html).toContain('New expense');
    expect(html).toContain('Actions');
  });
});
