import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PaymentVouchersView, type VouchersWriter } from '@/components/finance/payment-vouchers-view';
import type { PaymentVoucherRow } from '@/lib/finance/cash-book';
import { SAMPLE_TODAY } from '@/screens/finance/sales-sample';

/**
 * What the Mark as paid and Void menu items open, what the question presses with, and what the screen remembers of
 * the write afterwards (which is what its note is made from). Rendered to markup, with the state setters and the
 * dropdown items recorded so the test can press what a person would.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

// Every value the view hands a state setter is kept, in order.
const sets: unknown[] = [];
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (init: unknown) => {
      const [value, set] = (actual.useState as (i: unknown) => [unknown, (v: unknown) => void])(init);
      return [
        value,
        (next: unknown) => {
          sets.push(next);
          set(next);
        },
      ];
    },
  };
});

const selects: Array<() => void> = [];
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Item = ({ children, onSelect }: { children?: ReactNode; onSelect?: () => void }) => {
    if (onSelect) selects.push(onSelect);
    return <div role="menuitem">{children}</div>;
  };
  return {
    DropdownMenu: ({ children }: { children?: ReactNode }) => <div data-menu>{children}</div>,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: Item,
  };
});

vi.mock('@/components/ui/select', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return { Select: Pass, SelectTrigger: Pass, SelectValue: () => null, SelectContent: Pass, SelectItem: Pass };
});

type DateInput = { type?: string; value: string; onChange: (e: { target: { value: string } }) => void; onKeyDown: (e: { key: string; preventDefault: () => void }) => void };
const dateBoxes: DateInput[] = [];
vi.mock('@/components/ui/input', () => ({
  Input: (props: DateInput) => {
    if (props.type === 'date') dateBoxes.push(props);
    return <input defaultValue={props.value} />;
  },
}));

type Asked = { label: string; confirmLabel: string; onConfirm: () => void };
const asked: Asked[] = [];
vi.mock('@/components/finance/confirm-row', () => ({
  ConfirmRow: (props: Asked & { children?: ReactNode }) => {
    asked.push(props);
    return (
      <tr>
        <td>{props.children}</td>
      </tr>
    );
  },
}));

const state = { pending: false };
const clear = vi.fn();
vi.mock('@/components/finance/use-finance-action', () => ({
  useFinanceAction: () => ({
    pending: state.pending,
    error: null,
    // The call runs, and when it succeeds its follow-up runs with the data, as the real hook does.
    run: async (call: () => Promise<{ ok: boolean; data?: unknown }>, done?: (data: unknown) => void) => {
      const result = await call();
      if (result.ok) done?.(result.data);
    },
    fail: () => {},
    clear: () => clear(),
  }),
}));

const ID = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const PAID_ON = '2026-10-07';

const voucher = (over: Partial<PaymentVoucherRow> = {}): PaymentVoucherRow => ({
  transaction_id: ID,
  number: null,
  txn_date: '2026-10-05',
  method: 'fpx',
  amount: 300,
  status: 'scheduled',
  reference: null,
  notes: null,
  account_id: ACCOUNT,
  account_name: 'Maybank Current',
  account_kind: 'bank',
  contact_id: null,
  party_name: 'Tenaga Nasional',
  kind: 'other',
  category_id: null,
  category_name: 'Utilities',
  documents: null,
  approved_at: '2026-10-05T00:00:00Z',
  ...over,
});
const toPay = voucher();
const paid = voucher({ status: 'posted', number: 'PV-0007' });

const markPaid = vi.fn(async () => ({ ok: true as const, data: { id: ID, number: 'PV-0007' } }));
const voidVoucher = vi.fn(async () => ({ ok: true as const, data: { id: ID } }));
const never = async () => ({ ok: false as const, error: 'no' });
const writer: VouchersWriter = {
  actions: { record: never, save: never, submit: never, approve: never, reject: never, markPaid, remove: never, voidVoucher },
  canDecide: true,
  accounts: [],
  contacts: [],
  categories: [],
  bills: [],
  payments: [],
  orders: [],
  orderNotes: {},
};

const render = (rows: PaymentVoucherRow[], initialAsk?: { kind: 'markPaid' | 'void'; id: string }) =>
  renderToStaticMarkup(<PaymentVouchersView rows={rows} today={SAMPLE_TODAY} followClock={false} writer={writer} initialAsk={initialAsk} />);
const labels = (html: string) => [...html.matchAll(/<div role="menuitem">([\s\S]*?)<\/div>/g)].map(([, inner]) => inner.replace(/<[^>]+>/g, '').trim());
/** The question a state setter was last given. */
const lastOpen = () => [...sets].reverse().find((v) => typeof v === 'object' && v !== null && 'kind' in v) as { kind: string; paidOn?: string } | undefined;
const lastWritten = () => [...sets].reverse().find((v) => typeof v === 'object' && v !== null && 'recorded' in v) as
  | { id: string; status: string; date: string; recorded: boolean }
  | undefined;
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  sets.length = 0;
  selects.length = 0;
  asked.length = 0;
  dateBoxes.length = 0;
  state.pending = false;
  vi.clearAllMocks();
});

describe('the menu items', () => {
  it('open the question they are named for: Mark as paid the Mark as paid question, Void the Void question', () => {
    const html = render([toPay, voucher({ transaction_id: '66666666-6666-4666-8666-666666666666', status: 'posted', number: 'PV-0008' })]);
    expect(labels(html)).toEqual(['Mark as paid', 'Delete', 'Void']);
    selects[0]();
    expect(lastOpen()).toMatchObject({ kind: 'markPaid', row: { transaction_id: ID } });
    sets.length = 0;
    selects[1]();
    expect(lastOpen()?.kind).toBe('delete');
    sets.length = 0;
    selects[2]();
    expect(lastOpen()?.kind).toBe('void');
  });
});

describe('Mark as paid', () => {
  it('remembers the day paid as the voucher\'s date and its status as Paid, not the date it had', async () => {
    render([toPay], { kind: 'markPaid', id: ID });
    expect(dateBoxes[0].value).toBe(SAMPLE_TODAY);
    asked[0].onConfirm();
    await settled();
    expect(markPaid).toHaveBeenCalledWith({ id: ID, paid_on: SAMPLE_TODAY });
    expect(SAMPLE_TODAY).not.toBe(toPay.txn_date);
    expect(lastWritten()).toMatchObject({ id: ID, status: 'posted', date: SAMPLE_TODAY, recorded: false });
  });
  it('does not send again while it is still saving, from the button or from Enter in the date box', async () => {
    state.pending = true;
    render([toPay], { kind: 'markPaid', id: ID });
    asked[0].onConfirm();
    dateBoxes[0].onKeyDown({ key: 'Enter', preventDefault: () => {} });
    await settled();
    expect(markPaid).not.toHaveBeenCalled();
  });
  it('sends from Enter in the date box when it is not saving', async () => {
    render([toPay], { kind: 'markPaid', id: ID });
    dateBoxes[0].onKeyDown({ key: 'Enter', preventDefault: () => {} });
    await settled();
    expect(markPaid).toHaveBeenCalledTimes(1);
  });
  it('clears an earlier refusal when the date is typed again', () => {
    render([toPay], { kind: 'markPaid', id: ID });
    clear.mockClear();
    dateBoxes[0].onChange({ target: { value: PAID_ON } });
    expect(clear).toHaveBeenCalled();
    expect(lastOpen()).toMatchObject({ kind: 'markPaid', paidOn: PAID_ON });
  });
});

describe('Void', () => {
  it('presses with the id only, and remembers the voucher as Void, not as paid', async () => {
    render([paid], { kind: 'void', id: ID });
    asked[0].onConfirm();
    await settled();
    expect(voidVoucher).toHaveBeenCalledWith({ id: ID });
    expect(lastWritten()).toMatchObject({ id: ID, status: 'void', date: '2026-10-05' });
  });
});
