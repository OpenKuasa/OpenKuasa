import { type ReactElement, type ReactNode, isValidElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CashReceiptsView } from '@/components/finance/cash-receipts-view';
import { ExpensesView } from '@/components/finance/expenses-view';
import { PaymentVouchersView } from '@/components/finance/payment-vouchers-view';
import { SavedNoteCard } from '@/components/finance/saved-note-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger } from '@/components/ui/select';
import type { WrittenReceipt } from '@/lib/finance/cash-book-views';
import type { WrittenExpense } from '@/lib/finance/expense-form';
import type { WrittenVoucher } from '@/lib/finance/voucher-form';
import { SAMPLE_CASH_RECEIPTS, SAMPLE_EXPENSES, SAMPLE_PAYMENT_VOUCHERS } from '@/screens/finance/cash-book-sample';
import { SAMPLE_TODAY } from '@/screens/finance/sales-sample';

/**
 * The three screens that keep the row just written, so they can say when it is not in the list (Payment Vouchers,
 * Cash Receipts, Expenses). While that row is listed there is nothing to say. Changing the list then (the period, the
 * search, a filter, "View all") must forget it: otherwise the note turns up later by itself, under the very control
 * the person is using. It takes the focus as it appears, so the Enter that chose a filter also pressed its Close
 * button, and the next letters typed into the search went to that button instead.
 *
 * No DOM here. The hooks are given fixed values, so each screen is called as a plain function and the element tree it
 * returns walked: `written` is seeded, each list control is used, and what was asked of `written`'s setter is read.
 */

const seat = vi.hoisted(() => ({
  /** Which of the screen's states that start as `null` is `written`, counting from 0. */
  at: 0,
  seen: 0,
  written: null as unknown,
  set: (() => {}) as (next: unknown) => void,
}));

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  // Every state keeps its first value and ignores its setter, but `written`: that one is seeded and its setter kept.
  useState: (init: unknown) => {
    if (init === null) {
      const mine = seat.seen === seat.at;
      seat.seen += 1;
      if (mine) return [seat.written, seat.set];
    }
    return [typeof init === 'function' ? (init as () => unknown)() : init, () => {}];
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/components/finance/use-local-today', () => ({ useLocalToday: (today: string) => today }));
vi.mock('@/components/finance/use-finance-action', () => ({
  useFinanceAction: () => ({ pending: false, error: null, run: () => {}, fail: () => {}, clear: () => {} }),
}));

type El = ReactElement<{ children?: ReactNode; [prop: string]: unknown }>;
/** Every element under a node, through any prop that holds elements (a header's `actions`, a card's `action`). Components are not rendered. */
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as El;
  return [el, ...Object.values(el.props).flatMap(elements)];
}

/** The controls that change which rows are listed, by name, each with a way to use it. */
function listControls(tree: El[]): Record<string, () => void> {
  const found: Record<string, () => void> = {};
  for (const el of tree) {
    if (el.type === Select) {
      const trigger = elements(el.props.children).find((child) => child.type === SelectTrigger);
      found[String(trigger?.props['aria-label'])] = () => (el.props.onValueChange as (value: string) => void)('another');
    } else if (el.type === Input && el.props.type === 'search') {
      found.Search = () => (el.props.onChange as (event: unknown) => void)({ target: { value: 'z' } });
    } else if (el.type === Button && 'aria-pressed' in el.props) {
      found['View all'] = () => (el.props.onClick as () => void)();
    }
  }
  return found;
}

/** Twelve rows dated today, so the first is on screen and "View all" is offered. */
const twelve = <T,>(row: T, id: (n: number) => Partial<T>): T[] => Array.from({ length: 12 }, (_, n) => ({ ...row, ...id(n) }));

const vouchers = twelve(SAMPLE_PAYMENT_VOUCHERS[0], (n) => ({ transaction_id: `voucher-${n}`, txn_date: SAMPLE_TODAY, status: 'scheduled' as const }));
const receipts = twelve(SAMPLE_CASH_RECEIPTS[0], (n) => ({ transaction_id: `receipt-${n}`, txn_date: SAMPLE_TODAY, status: 'posted' as const, number: `RC-${n}` }));
const expenses = twelve(SAMPLE_EXPENSES[0], (n) => ({ id: `expense-${n}`, expense_date: SAMPLE_TODAY, status: 'approved' as const }));

const SCREENS: { name: string; at: number; controls: string[]; written: (id: string) => unknown; draw: () => ReactNode }[] = [
  {
    name: 'Payment Vouchers',
    // `open` starts from a function, so `written` is the first state that starts as null.
    at: 0,
    controls: ['Kind', 'Period', 'Search', 'Status', 'View all'],
    written: (id): WrittenVoucher => ({ id, status: 'scheduled', recorded: false, payee: 'Syarikat Maju', amount: 300, date: SAMPLE_TODAY }),
    draw: () => PaymentVouchersView({ rows: vouchers, today: SAMPLE_TODAY, followClock: false }),
  },
  {
    name: 'Cash Receipts',
    // After `open`.
    at: 1,
    controls: ['Period', 'Search', 'Status', 'View all'],
    written: (id): WrittenReceipt => ({ id, kind: 'posted', number: 'RC-0', date: SAMPLE_TODAY }),
    draw: () => CashReceiptsView({ rows: receipts, today: SAMPLE_TODAY, followClock: false }),
  },
  {
    name: 'Expenses',
    // After `open`, before `paid`.
    at: 1,
    controls: ['Category', 'Search', 'Status', 'View all'],
    written: (id): WrittenExpense => ({ id, status: 'approved', vendor: 'Syarikat Maju', amount: 300, date: SAMPLE_TODAY }),
    draw: () => ExpensesView({ rows: expenses, today: SAMPLE_TODAY, followClock: false }),
  },
];

const LISTED = { 'Payment Vouchers': 'voucher-0', 'Cash Receipts': 'receipt-0', Expenses: 'expense-0' } as Record<string, string>;

describe.each(SCREENS)('the row just written on $name', (screen) => {
  const set = vi.fn<(next: unknown) => void>();
  const draw = (writtenId: string) => {
    seat.at = screen.at;
    seat.seen = 0;
    seat.written = screen.written(writtenId);
    seat.set = set;
    return elements(screen.draw());
  };
  const note = (tree: El[]) => tree.filter((el) => el.type === SavedNoteCard && el.props.subtitle === 'It is not in the list below');

  beforeEach(() => set.mockClear());

  it('has every control that changes the list (so none is missed below)', () => {
    expect(Object.keys(listControls(draw(LISTED[screen.name]))).sort()).toEqual(screen.controls);
  });

  it.each(screen.controls)('is forgotten when %s changes the list while it is listed, so its note cannot turn up later', (control) => {
    const tree = draw(LISTED[screen.name]);
    // It is on screen: nothing is said about it.
    expect(note(tree)).toHaveLength(0);
    listControls(tree)[control]();
    expect(set).toHaveBeenCalledWith(null);
  });

  it.each(screen.controls)('is kept when %s changes the list under its note, which stays and says what hides it now', (control) => {
    const tree = draw('not-in-the-list');
    expect(note(tree)).toHaveLength(1);
    listControls(tree)[control]();
    expect(set).not.toHaveBeenCalled();
  });
});
