import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExpensePayCard } from '@/components/finance/expense-pay-card';
import { SavedNoteCard } from '@/components/finance/saved-note-card';
import type { ExpenseRow } from '@/lib/finance/expenses';

/**
 * The classes that keep a long unbroken vendor name inside the card on a phone. There is no DOM or layout here, so
 * the markup is read: a grid item does not shrink below its content unless it says min-w-0, and `break-words` alone
 * does not make it shrink (measured at 390px: the form was 668px wide in a 294px card and the amount was out of sight).
 */

const row: ExpenseRow = {
  id: '55555555-5555-4555-8555-555555555555',
  expense_date: '2026-10-05',
  category_id: '99999999-9999-4999-8999-999999999999',
  category_name: 'Rent',
  vendor_id: null,
  vendor_name: 'V'.repeat(72),
  amount: 120,
  sst_amount: 0,
  notes: null,
  status: 'approved',
  display_status: 'approved',
  paid: 0,
  held: 0,
  method: null,
  paid_on: null,
  updated_at: '2026-10-12T09:15:22.123456+00:00',
};

const pay = async () => ({ ok: false as const, error: 'no' });

describe('the Mark paid card on a phone', () => {
  const html = renderToStaticMarkup(<ExpensePayCard row={row} accounts={[]} today="2026-10-12" pay={pay} onClose={() => {}} />);
  const form = html.match(/<form[^>]*class="([^"]*)"/)?.[1] ?? '';
  const sentence = html.match(/<p class="([^"]*)"><span class="font-medium">RM 120.00/)?.[1] ?? '';

  it('lays the form out in one column that may shrink, below the medium width', () => {
    expect(form.split(' ')).toEqual(expect.arrayContaining(['grid', 'grid-cols-1', 'md:grid-cols-12']));
  });
  it('lets the sentence about the expense break anywhere and shrink', () => {
    expect(sentence.split(' ')).toEqual(expect.arrayContaining(['min-w-0', '[overflow-wrap:anywhere]']));
    expect(html).toContain('V'.repeat(72));
  });
});

describe('the note after a payment on a phone', () => {
  it('lets its text break anywhere and shrink', () => {
    const html = renderToStaticMarkup(
      <SavedNoteCard title="t" subtitle="s" href="/finance/payment-vouchers" linkLabel="Payment Vouchers" onClose={() => {}}>
        {'V'.repeat(72)}
      </SavedNoteCard>,
    );
    const classes = html.match(/<p id="[^"]*" role="status" class="([^"]*)"/)?.[1] ?? '';
    expect(classes.split(' ')).toEqual(expect.arrayContaining(['min-w-0', '[overflow-wrap:anywhere]']));
  });
});
