import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PaymentVouchersView, type VouchersWriter } from '@/components/finance/payment-vouchers-view';
import { VoucherFormCard } from '@/components/finance/voucher-form-card';
import type { PaymentVoucherRow } from '@/lib/finance/cash-book';
import { voucherDecisionPayload } from '@/lib/finance/voucher-form';
import { SAMPLE_PAYMENT_VOUCHERS } from '@/screens/finance/cash-book-sample';
import { SAMPLE_TODAY } from '@/screens/finance/sales-sample';

/**
 * The Payment Vouchers screen as the server sends it: rendered to a string and read as markup (no DOM here). A
 * person who is given no `writer` (a viewer, the demo workspace, the sample) must see nothing that changes data.
 * Nothing can be pressed, so a question opens at the start (`initialAsk`) and its confirm button is read through the
 * captured props of the row component.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

// A closed menu draws nothing but its button. Here its items are drawn in place, so what the menu offers can be read.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Item = ({ children }: { children?: ReactNode }) => <div role="menuitem">{children}</div>;
  return {
    DropdownMenu: ({ children }: { children?: ReactNode }) => <div data-menu>{children}</div>,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: Item,
  };
});

// A closed select draws no options; the form card is read for its words only.
vi.mock('@/components/ui/select', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return { Select: Pass, SelectTrigger: Pass, SelectValue: () => null, SelectContent: Pass, SelectItem: Pass };
});

// The row that asks a question: its props are kept, so the test can press its confirm button.
type Asked = { label: string; confirmLabel: string; onConfirm: () => void };
const asked: Asked[] = [];
vi.mock('@/components/finance/confirm-row', () => ({
  ConfirmRow: (props: Asked & { children?: ReactNode }) => {
    asked.push(props);
    return (
      <tr>
        <td>
          <div role="group" aria-label={props.label}>
            {props.children}
          </div>
          <button type="button">{props.confirmLabel}</button>
        </td>
      </tr>
    );
  },
}));

// A write runs its call at once, with no transition.
vi.mock('@/components/finance/use-finance-action', () => ({
  useFinanceAction: () => ({
    pending: false,
    error: null,
    run: (call: () => Promise<unknown>) => {
      void call();
    },
    fail: () => {},
    clear: () => {},
  }),
}));

const ID = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OVER_BILLED = 'This order is over-billed: the bills come to RM 12,400.00, over its total of RM 10,000.00.';

const voucher = (over: Partial<PaymentVoucherRow> = {}): PaymentVoucherRow => ({
  transaction_id: ID,
  number: null,
  txn_date: '2026-10-05',
  method: 'fpx',
  amount: 300,
  status: 'pending_approval',
  reference: 'ACC 1',
  notes: 'Paid late once already',
  account_id: ACCOUNT,
  account_name: 'Maybank Current',
  account_kind: 'bank',
  contact_id: null,
  party_name: 'Syarikat Maju',
  kind: 'bill',
  category_id: null,
  category_name: null,
  documents: 'BILL-0007',
  approved_at: null,
  ...over,
});

const record = vi.fn(async () => ({ ok: false as const, error: 'no' }));
const approve = vi.fn(async () => ({ ok: true as const, data: { id: ID } }));
const reject = vi.fn(async () => ({ ok: true as const, data: { id: ID } }));
const remove = vi.fn(async () => ({ ok: true as const, data: { id: ID } }));
const never = async () => ({ ok: false as const, error: 'no' });
const writer = (canDecide: boolean, orderNotes: Record<string, string[]> = {}): VouchersWriter => ({
  actions: { record: never, approve, reject, remove },
  canDecide,
  accounts: [],
  contacts: [],
  categories: [],
  orderNotes,
});

const render = (w?: VouchersWriter, rows: PaymentVoucherRow[] = SAMPLE_PAYMENT_VOUCHERS, initialAsk?: { kind: 'approve' | 'reject' | 'delete'; id: string }) =>
  renderToStaticMarkup(<PaymentVouchersView rows={rows} today={SAMPLE_TODAY} followClock={false} writer={w} initialAsk={initialAsk} />);

/** How many row menus the markup holds. */
const menus = (html: string) => html.split('data-menu').length - 1;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const items = (html: string) => [...html.matchAll(/<div role="menuitem">([\s\S]*?)<\/div>/g)].map(([, inner]) => text(inner));

beforeEach(() => {
  asked.length = 0;
  vi.clearAllMocks();
});

describe('the Payment Vouchers screen', () => {
  it('has no New voucher button, no Actions column and no row menu without a writer', () => {
    const html = render();
    expect(html).toContain('Payment Vouchers');
    expect(html).not.toContain('New voucher');
    expect(html).not.toContain('Actions');
    expect(html).not.toContain('data-menu');
  });
  it('has them for a writer (so the test above would notice them)', () => {
    const html = render(writer(true));
    expect(html).toContain('New voucher');
    expect(html).toContain('Actions');
    expect(menus(html)).toBeGreaterThan(0);
  });
  it('gives a member a menu on the same rows as an owner: what differs is inside it', () => {
    // Every waiting row of the sample is of a kind that belongs here, so it has Delete for both.
    expect(menus(render(writer(false)))).toBe(menus(render(writer(true))));
  });
  it('still links a supplier payment and a refund to their own screens', () => {
    const html = render(writer(true));
    expect(html).toContain('href="/finance/payments-out"');
    expect(html).toContain('To be paid');
  });
});

describe('a waiting voucher\'s menu', () => {
  const rows = [voucher()];

  it('offers an owner Approve, Reject and Delete', () => {
    expect(items(render(writer(true), rows))).toEqual(['Approve', 'Reject', 'Delete']);
  });
  it('offers a member Delete and neither Approve nor Reject', () => {
    expect(items(render(writer(false), rows))).toEqual(['Delete']);
  });
  it('offers a viewer nothing', () => {
    expect(items(render(undefined, rows))).toEqual([]);
  });
});

describe('the Kind link', () => {
  it('says "Managed on Payments Out" only once the supplier payment is to be paid', () => {
    expect(render(writer(true), [voucher({ status: 'scheduled', approved_at: '2026-10-06T00:00:00Z' })])).toContain('title="Managed on Payments Out"');
    for (const status of ['draft', 'pending_approval'] as const) {
      const html = render(writer(true), [voucher({ status })]);
      expect(html).toContain('href="/finance/payments-out"');
      expect(html).not.toContain('Managed on');
    }
  });
});

describe('the questions', () => {
  const rows = [voucher()];
  const notes = { [ID]: [OVER_BILLED] };

  it('draws the over-billing note under the Approve question of a voucher whose bills are over-billed, and nowhere else', () => {
    const approving = render(writer(true, notes), rows, { kind: 'approve', id: ID });
    expect(approving).toContain('role="status"');
    expect(text(approving)).toContain(OVER_BILLED);
    for (const kind of ['reject', 'delete'] as const) {
      const html = render(writer(true, notes), rows, { kind, id: ID });
      expect(html).not.toContain('role="status"');
      expect(text(html)).not.toContain(OVER_BILLED);
    }
  });

  it('draws no note when there is none to give', () => {
    expect(render(writer(true), rows, { kind: 'approve', id: ID })).not.toContain('role="status"');
  });

  it('shows the method, reference and notes under the Approve and the Reject question, as text', () => {
    for (const kind of ['approve', 'reject'] as const) {
      const html = render(writer(true), [voucher({ notes: '<b>x</b> Paid late' })], { kind, id: ID });
      expect(text(html)).toContain('Method: FPX · Reference: ACC 1 · Notes: &lt;b&gt;x&lt;/b&gt; Paid late');
      expect(html).not.toContain('<b>x</b>');
    }
    expect(text(render(writer(true), rows, { kind: 'delete', id: ID }))).not.toContain('Reference: ACC 1');
  });

  it('presses Approve with the voucher as it was shown', () => {
    render(writer(true), rows, { kind: 'approve', id: ID });
    asked[0].onConfirm();
    expect(approve).toHaveBeenCalledWith(voucherDecisionPayload(rows[0]));
    expect(reject).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('presses Reject with the voucher as it was shown', () => {
    render(writer(true), rows, { kind: 'reject', id: ID });
    asked[0].onConfirm();
    expect(reject).toHaveBeenCalledWith(voucherDecisionPayload(rows[0]));
    expect(approve).not.toHaveBeenCalled();
  });

  it('presses Delete with the status the row showed, whatever it is', () => {
    for (const status of ['draft', 'pending_approval'] as const) {
      asked.length = 0;
      remove.mockClear();
      render(writer(false), [voucher({ status })], { kind: 'delete', id: ID });
      expect(asked[0].confirmLabel).toBe('Delete voucher');
      asked[0].onConfirm();
      expect(remove).toHaveBeenCalledWith({ id: ID, status });
    }
  });
});

describe('the voucher form card', () => {
  const card = (canDecide: boolean) =>
    text(
      renderToStaticMarkup(
        <VoucherFormCard accounts={[]} contacts={[]} categories={[]} today="2026-10-12" canDecide={canDecide} actions={{ record }} onClose={() => {}} />,
      ),
    );

  it('says before the save what saving does for an owner or admin, and names the button', () => {
    const html = card(true);
    expect(html).toContain('A voucher you save is approved at once and reads To be paid: you are an owner or admin. Nothing is paid until it is marked paid.');
    expect(html).toContain('Save voucher');
  });
  it('says what it does for a member, and names the button', () => {
    const html = card(false);
    expect(html).toContain('This voucher waits as Pending approval until an owner or admin approves or rejects it. Until then it cannot be changed, only deleted.');
    expect(html).toContain('Send for approval');
  });
});
