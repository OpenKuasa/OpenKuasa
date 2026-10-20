import { type ReactElement, type ReactNode, isValidElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VoucherFormCard } from '@/components/finance/voucher-form-card';
import { Button } from '@/components/ui/button';
import type { BillListRow } from '@/lib/finance/bills';
import type { PaymentOutRow } from '@/lib/finance/money';
import { draftVoucherForm, newVoucherForm, voucherPayableBills } from '@/lib/finance/voucher-form';
import type { PaymentVoucherRow } from '@/lib/finance/cash-book';
import { ringgitBill } from './helpers/bill-rows';

/**
 * The voucher form card, read without a DOM. Its hooks are given fixed values, so the card can be called as a plain
 * function and the element tree it returns walked: the selects' keys, the classes of the form and the triggers, and
 * what each button does when pressed (the actions are mocks that record their calls).
 */

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  // The first state is the draft the card was given, or the empty form; setting it does nothing here.
  useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
  useId: () => 'id',
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
const failed = vi.fn();
vi.mock('@/components/finance/use-finance-action', () => ({
  useFinanceAction: () => ({
    pending: false,
    error: null,
    // The call runs at once; its answer is not needed here.
    run: (call: () => Promise<unknown>) => {
      void call();
    },
    fail: failed,
    clear: () => {},
  }),
}));

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CATEGORY = '99999999-9999-4999-8999-999999999999';
const MAJU = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VOUCHER = '55555555-5555-4555-8555-555555555555';
const BILL = 'b1111111-1111-4111-8111-111111111111';
const TODAY = '2026-10-12';
const OVER_BILLED = 'BILL-0007 is against PO-0001, whose bills come to RM 12,400.00, over its total of RM 10,000.00.';

const accounts = [{ id: ACCOUNT, name: 'Maybank Current', kind: 'bank' as const, bank_name: 'Maybank', currency: 'MYR' }];
const categories = [{ id: CATEGORY, name: 'Utilities' }];
const bills: BillListRow[] = [
  {
    id: BILL, bill_no: 'BILL-0007', supplier_id: MAJU, supplier_name: 'Syarikat Maju', bill_date: '2026-10-01', due_date: '2026-10-31', total: 132.5, paid: 0,
    balance: 132.5, display_status: 'pending' as const, purchase_order_id: 'po1', purchase_order_no: 'PO-0001', category_id: null, category_name: null,
  },
].map((b) => ringgitBill(b));
const payable = voucherPayableBills(bills, [], null);
const orders = [{ id: 'po1', po_no: 'PO-0001', total: 10000, billed_total: 12400, received_total: 0, over_billed: true, billed_over_received: false, currency: 'MYR' }];
const draftRow: PaymentVoucherRow = {
  transaction_id: VOUCHER, number: null, txn_date: '2026-10-05', method: 'cheque', amount: 132.5, status: 'draft', reference: null, notes: null,
  account_id: ACCOUNT, account_name: 'Maybank Current', account_kind: 'bank', contact_id: MAJU, party_name: 'Syarikat Maju', kind: 'bill',
  category_id: null, category_name: null, documents: 'BILL-0007', approved_at: null,
};
const split: PaymentOutRow[] = [
  {
    allocation_id: 'x', transaction_id: VOUCHER, number: null, txn_date: '2026-10-05', method: 'cheque', amount: 132.5, transaction_amount: 132.5, status: 'draft',
    reference: null, account_id: ACCOUNT, account_name: 'Maybank Current', bill_id: BILL, bill_no: 'BILL-0007', supplier_name: 'Syarikat Maju',
  },
];
/** An existing draft for the bills (Edit), and a new voucher for a category, both filled in so that pressing a button sends. */
const billsDraft = draftVoucherForm(draftRow, split, bills, accounts);
const newCategory = { ...newVoucherForm(accounts, categories, TODAY), payeeName: 'Tenaga', categoryId: CATEGORY, amount: '40' };

type Done = { ok: true; data: { id: string; status: 'draft' | 'pending_approval' | 'scheduled' } };
const record = vi.fn<(input: unknown) => Promise<Done>>(async () => ({ ok: true, data: { id: VOUCHER, status: 'scheduled' } }));
const save = vi.fn<(input: unknown) => Promise<Done>>(async () => ({ ok: true, data: { id: VOUCHER, status: 'draft' } }));

const props = (draft?: ReturnType<typeof newVoucherForm>) => ({
  accounts, contacts: [], categories, payable, orders, today: TODAY, canDecide: true, draft, actions: { record, save }, onClose: () => {},
});
const card = (draft?: ReturnType<typeof newVoucherForm>) => VoucherFormCard(props(draft)) as ReactElement;

/** Every element under a node, depth first. Components are not rendered: their props.children are what the card handed them. */
type El = ReactElement<{ children?: ReactNode; [prop: string]: unknown }>;
function elements(node: ReactNode): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as El;
  return [el, ...elements(el.props.children)];
}
const all = (draft?: ReturnType<typeof newVoucherForm>) => elements(card(draft));
const labelOf = (el: El) => (Array.isArray(el.props.children) ? el.props.children.join('') : String(el.props.children));
const buttons = (draft?: ReturnType<typeof newVoucherForm>) => all(draft).filter((e) => e.type === Button);
const button = (draft: ReturnType<typeof newVoucherForm> | undefined, label: string) => buttons(draft).find((b) => labelOf(b) === label)!;
const press = (draft: ReturnType<typeof newVoucherForm> | undefined, label: string) => (button(draft, label).props.onClick as () => void)();
const submitForm = (draft?: ReturnType<typeof newVoucherForm>) =>
  (all(draft).find((e) => e.type === 'form')!.props.onSubmit as (e: unknown) => void)({ preventDefault: () => {} });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the selects of the two kinds', () => {
  it('have keys of their own, so that changing the kind does not reuse one select for the other (the payee was emptied)', () => {
    const selects = (draft?: ReturnType<typeof newVoucherForm>) =>
      all(draft)
        .filter((e) => e.props.value !== undefined && e.props.onValueChange !== undefined && e.key !== null)
        .map((e) => e.key);
    expect(selects(billsDraft)).toContain('supplier');
    expect(selects(billsDraft)).not.toContain('payee');
    expect(selects(newCategory)).toContain('payee');
    expect(selects(newCategory)).not.toContain('supplier');
  });
});

describe('the card at a phone\'s width', () => {
  it('is one column below md, so that a long supplier name cannot widen it, and its two long selects may shrink', () => {
    for (const draft of [billsDraft, newCategory]) {
      const form = all(draft).find((e) => e.type === 'form')!;
      expect(form.props.className).toBe('grid grid-cols-1 gap-3 md:grid-cols-12');
      const triggers = all(draft).filter((e) => typeof e.props.id === 'string' && /-(supplier|payee)$/.test(e.props.id));
      expect(triggers.length).toBe(1);
      expect(triggers[0].props.className).toContain('min-w-0');
    }
  });
});

describe('the buttons', () => {
  it('sends a draft for the bills for approval with the first button, and only saves it with "Save draft"', () => {
    submitForm(billsDraft);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({ kind: 'bills', id: VOUCHER, send: true });
    expect(record).not.toHaveBeenCalled();
    save.mockClear();
    press(billsDraft, 'Save draft');
    expect(save.mock.calls[0][0]).toMatchObject({ kind: 'bills', id: VOUCHER, send: false });
    expect(record).not.toHaveBeenCalled();
  });
  it('records a new voucher for a category with the first button, and saves a draft with "Save as draft", sending nothing', () => {
    submitForm(newCategory);
    expect(record).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    record.mockClear();
    press(newCategory, 'Save as draft');
    expect(save.mock.calls[0][0]).toMatchObject({ kind: 'category', send: false });
    expect(record).not.toHaveBeenCalled();
  });
  it('sends nothing when the form is refused, and says why', () => {
    submitForm({ ...newCategory, amount: '' });
    expect(record).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
  });
});

describe('the note under the ticked bills', () => {
  const words = (draft?: ReturnType<typeof newVoucherForm>) => renderToStaticMarkup(card(draft)).replace(/<[^>]+>/g, ' ');
  it('is drawn when a ticked bill belongs to an over-billed order', () => {
    expect(words(billsDraft)).toContain(OVER_BILLED);
  });
  it('is not drawn when no bill is ticked, or for a category', () => {
    expect(words({ ...billsDraft, amounts: {} })).not.toContain('over its total');
    expect(words(newCategory)).not.toContain('over its total');
  });
});
