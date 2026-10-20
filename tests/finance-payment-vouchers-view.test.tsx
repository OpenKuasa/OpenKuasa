import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PaymentVouchersView, type VouchersWriter } from '@/components/finance/payment-vouchers-view';
import { VoucherFormCard } from '@/components/finance/voucher-form-card';
import type { PaymentVoucherRow } from '@/lib/finance/cash-book';
import { voucherDecisionPayload } from '@/lib/finance/voucher-form';
import { SAMPLE_PAYMENT_VOUCHERS } from '@/screens/finance/cash-book-sample';
import { SAMPLE_TODAY } from '@/screens/finance/sales-sample';
import { ringgitBill } from './helpers/bill-rows';

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
const submit = vi.fn(async () => ({ ok: true as const, data: { id: ID } }));
const remove = vi.fn(async () => ({ ok: true as const, data: { id: ID } }));
const markPaid = vi.fn(async () => ({ ok: true as const, data: { id: ID, number: 'PV-0007' } }));
const voidVoucher = vi.fn(async () => ({ ok: true as const, data: { id: ID } }));
const never = async () => ({ ok: false as const, error: 'no' });
const writer = (canDecide: boolean, orderNotes: Record<string, string[]> = {}): VouchersWriter => ({
  actions: { record: never, save: never, submit, approve, reject, markPaid, remove, voidVoucher },
  canDecide,
  accounts: [],
  contacts: [],
  categories: [],
  bills: [],
  payments: [],
  orders: [],
  orderNotes,
});

const render = (w?: VouchersWriter, rows: PaymentVoucherRow[] = SAMPLE_PAYMENT_VOUCHERS, initialAsk?: { kind: 'edit' | 'submit' | 'approve' | 'reject' | 'markPaid' | 'delete' | 'void'; id: string }) =>
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
  it('gives a member a menu on every row that is not yet paid and belongs here, and an owner one more on each paid row that does', () => {
    // Every waiting row of the sample is of a kind that belongs here, so it has Delete for both. A paid row has Void, for an owner or admin only.
    const paidHere = SAMPLE_PAYMENT_VOUCHERS.slice(0, 10).filter((v) => v.status === 'posted' && (v.kind === 'expense' || v.kind === 'other')).length;
    expect(paidHere).toBeGreaterThan(0);
    expect(menus(render(writer(true)))).toBe(menus(render(writer(false))) + paidHere);
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

describe('a draft\'s menu', () => {
  const rows = [voucher({ status: 'draft' })];

  it('offers an owner and a member Edit, Send for approval and Delete', () => {
    expect(items(render(writer(true), rows))).toEqual(['Edit', 'Send for approval', 'Delete']);
    expect(items(render(writer(false), rows))).toEqual(['Edit', 'Send for approval', 'Delete']);
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

describe('paying and voiding', () => {
  const toPay = voucher({ kind: 'other', status: 'scheduled', documents: null, category_name: 'Utilities' });
  const paid = { ...toPay, status: 'posted' as const, number: 'PV-0007' };

  it('offers an owner Mark as paid and Delete on a To be paid voucher that belongs here, and a member Delete only', () => {
    expect(items(render(writer(true), [toPay]))).toEqual(['Mark as paid', 'Delete']);
    expect(items(render(writer(false), [toPay]))).toEqual(['Delete']);
  });
  it('offers an owner Void on a paid one, a member no menu, and nobody one on a paid supplier payment', () => {
    expect(items(render(writer(true), [paid]))).toEqual(['Void']);
    expect(menus(render(writer(false), [paid]))).toBe(0);
    expect(menus(render(writer(true), [{ ...paid, kind: 'bill' }]))).toBe(0);
  });
  it('asks the day it was paid, starting from today, and presses Mark as paid with the id and that day only', () => {
    const html = render(writer(true), [toPay], { kind: 'markPaid', id: ID });
    expect(html).toContain('type="date"');
    expect(html).toContain(`value="${SAMPLE_TODAY}"`);
    // The amount, the payee and the account are drawn in bold, each in an element of its own.
    expect(text(html)).toMatch(/Mark the payment of RM 300\.00 to Syarikat Maju , from Maybank Current , as paid on/);
    expect(text(html)).toContain('It gets its payment voucher number and moves the books on that date. After this it cannot be changed or deleted, only voided.');
    expect(text(html)).toContain('Category: Utilities · Method: FPX');
    expect(asked[0].confirmLabel).toBe('Mark as paid');
    asked[0].onConfirm();
    expect(markPaid).toHaveBeenCalledWith({ id: ID, paid_on: SAMPLE_TODAY });
    expect(voidVoucher).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it('asks before voiding, by number, and presses Void with the id only', () => {
    const html = render(writer(true), [paid], { kind: 'void', id: ID });
    expect(text(html)).toMatch(/Void PV-0007 , the payment of RM 300\.00 to Syarikat Maju , paid on 05 Oct 2026 from Maybank Current \? The money counts as back in the account/);
    expect(text(html)).toContain('It is kept as Void (find it under Void in the status filter), and this cannot be undone.');
    expect(asked[0].confirmLabel).toBe('Void voucher');
    asked[0].onConfirm();
    expect(voidVoucher).toHaveBeenCalledWith({ id: ID });
    expect(markPaid).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
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

  it('shows the same line under the Send question of a draft, and no over-billing note', () => {
    const html = render(writer(false, notes), [voucher({ status: 'draft' })], { kind: 'submit', id: ID });
    expect(text(html)).toContain('Method: FPX · Reference: ACC 1 · Notes: Paid late once already');
    expect(html).not.toContain('role="status"');
  });

  it('presses Send for approval with the draft as it was shown', () => {
    const draft = voucher({ status: 'draft' });
    render(writer(false), [draft], { kind: 'submit', id: ID });
    expect(asked[0].confirmLabel).toBe('Send for approval');
    asked[0].onConfirm();
    expect(submit).toHaveBeenCalledWith(voucherDecisionPayload(draft));
    expect(approve).not.toHaveBeenCalled();
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

describe('Edit on a draft', () => {
  const BILL = 'b1111111-1111-4111-8111-111111111111';
  const MAJU = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const draft = voucher({ status: 'draft', contact_id: MAJU, amount: 100, reference: 'ACC 1', notes: 'Paid late once already', documents: 'BILL-0007' });
  const bill = {
    id: BILL, bill_no: 'BILL-0007', supplier_id: MAJU, supplier_name: 'Syarikat Maju', bill_date: '2026-10-01', due_date: '2026-10-31', total: 132.5, paid: 0,
    balance: 132.5, display_status: 'pending' as const, purchase_order_id: null, purchase_order_no: null, category_id: null, category_name: null,
  };
  // The draft holds RM 100.00 of the bill; someone else's waiting voucher holds RM 10.00 of it.
  const held = (transaction: string, amount: number, status: 'draft' | 'pending_approval') => ({
    allocation_id: `${transaction}-a`, transaction_id: transaction, number: null, txn_date: '2026-10-05', method: 'fpx' as const, amount, transaction_amount: amount, status,
    reference: null, account_id: ACCOUNT, account_name: 'Maybank Current', bill_id: BILL, bill_no: 'BILL-0007', supplier_name: 'Syarikat Maju',
  });
  const editor = (): VouchersWriter => ({
    ...writer(false),
    accounts: [{ id: ACCOUNT, name: 'Maybank Current', kind: 'bank', bank_name: 'Maybank', currency: 'MYR' }],
    bills: [ringgitBill(bill)],
    payments: [held(ID, 100, 'draft'), held('other', 10, 'pending_approval')],
  });
  const html = () => render(editor(), [draft], { kind: 'edit', id: ID });

  it('opens the form on the draft, filled with what it holds, and no question', () => {
    const markup = html();
    expect(markup).toContain('Edit draft voucher');
    expect(markup).toContain('value="ACC 1"');
    expect(markup).toContain('value="Paid late once already"');
    expect(markup).toContain('aria-label="Amount to pay on BILL-0007" value="100.00"');
    expect(markup).toContain('Save draft');
    expect(markup).not.toContain('New voucher</h3>');
    expect(asked).toHaveLength(0);
    expect(text(markup)).not.toContain('Delete voucher');
  });
  it('gives the draft its own part of the bill back: the bill can take RM 122.50, not the RM 22.50 left beside it', () => {
    const words = text(html());
    expect(words).toContain('RM 122.50 to pay');
    expect(words).not.toContain('RM 22.50 to pay');
  });
});

describe('the voucher form card', () => {
  const card = (canDecide: boolean) =>
    text(
      renderToStaticMarkup(
        <VoucherFormCard
          accounts={[]}
          contacts={[]}
          categories={[]}
          payable={[]}
          orders={[]}
          today="2026-10-12"
          canDecide={canDecide}
          actions={{ record, save: record }}
          onClose={() => {}}
        />,
      ),
    );

  it('says before the save what saving does for an owner or admin, and names the button', () => {
    const html = card(true);
    expect(html).toContain('A voucher you save is approved at once and reads To be paid: you are an owner or admin. Nothing is paid until it is marked paid.');
    expect(html).toContain('Save voucher');
    expect(html).toContain('Save as draft');
  });
  it('says what it does for a member, and names the button', () => {
    const html = card(false);
    expect(html).toContain('This voucher waits as Pending approval until an owner or admin approves or rejects it. Until then it cannot be changed, only deleted.');
    expect(html).toContain('Send for approval');
    expect(html).toContain('Save as draft');
  });
});
