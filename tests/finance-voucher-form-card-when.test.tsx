import { type ReactElement, type ReactNode, isValidElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VoucherFormCard } from '@/components/finance/voucher-form-card';
import type { BillListRow } from '@/lib/finance/bills';
import { draftVoucherForm, newVoucherForm, voucherPayableBills } from '@/lib/finance/voucher-form';
import type { PaymentVoucherRow } from '@/lib/finance/cash-book';
import { ringgitBill } from './helpers/bill-rows';

/**
 * The "When" choice of the voucher form card (To be paid / Paid now), read without a DOM as the form-card test does:
 * who is drawn it, on which forms, which radio starts chosen, and whether the first button sends `paid_now`.
 */

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
  useId: () => 'id',
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
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

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CATEGORY = '99999999-9999-4999-8999-999999999999';
const MAJU = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VOUCHER = '55555555-5555-4555-8555-555555555555';
const BILL = 'b1111111-1111-4111-8111-111111111111';
const TODAY = '2026-10-12';

const accounts = [{ id: ACCOUNT, name: 'Maybank Current', kind: 'bank' as const, bank_name: 'Maybank', currency: 'MYR' }];
const categories = [{ id: CATEGORY, name: 'Utilities' }];
const bills: BillListRow[] = [
  {
    id: BILL, bill_no: 'BILL-0007', supplier_id: MAJU, supplier_name: 'Syarikat Maju', bill_date: '2026-10-01', due_date: '2026-10-31', total: 132.5, paid: 0,
    balance: 132.5, display_status: 'pending' as const, purchase_order_id: null, purchase_order_no: null, category_id: null, category_name: null,
  },
].map((b) => ringgitBill(b));
const payable = voucherPayableBills(bills, [], null);
const draftRow: PaymentVoucherRow = {
  transaction_id: VOUCHER, number: null, txn_date: '2026-10-05', method: 'cheque', amount: 132.5, status: 'draft', reference: null, notes: null,
  account_id: ACCOUNT, account_name: 'Maybank Current', account_kind: 'bank', contact_id: MAJU, party_name: 'Syarikat Maju', kind: 'bill',
  category_id: null, category_name: null, documents: 'BILL-0007', approved_at: null,
};
const split = [
  {
    allocation_id: 'x', transaction_id: VOUCHER, number: null, txn_date: '2026-10-05', method: 'cheque' as const, amount: 132.5, transaction_amount: 132.5,
    status: 'draft' as const, reference: null, account_id: ACCOUNT, account_name: 'Maybank Current', bill_id: BILL, bill_no: 'BILL-0007', supplier_name: 'Syarikat Maju',
  },
];
const billsDraft = draftVoucherForm(draftRow, split, bills, accounts);
const newCategory = { ...newVoucherForm(accounts, categories, TODAY), payeeName: 'Tenaga', categoryId: CATEGORY, amount: '40' };
// A category draft being edited has an id, so the first button sends it for approval.
const categoryDraft = { ...newCategory, id: VOUCHER };
const billsNew = { ...newCategory, kind: 'bills' as const };

type Done = { ok: true; data: { id: string; status: 'draft' | 'pending_approval' | 'scheduled' } };
const record = vi.fn<(input: unknown) => Promise<Done>>(async () => ({ ok: true, data: { id: VOUCHER, status: 'scheduled' } }));
const save = vi.fn<(input: unknown) => Promise<Done>>(async () => ({ ok: true, data: { id: VOUCHER, status: 'draft' } }));

type Form = ReturnType<typeof newVoucherForm>;
const card = (draft: Form, canDecide: boolean) =>
  VoucherFormCard({ accounts, contacts: [], categories, payable, orders: [], today: TODAY, canDecide, draft, actions: { record, save }, onClose: () => {} }) as ReactElement;

type El = ReactElement<{ children?: ReactNode; [prop: string]: unknown }>;
function elements(node: ReactNode): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as El;
  return [el, ...elements(el.props.children)];
}
const radios = (draft: Form, canDecide: boolean) => elements(card(draft, canDecide)).filter((e) => e.type === 'input' && e.props.type === 'radio');
const submit = (draft: Form, canDecide: boolean) =>
  (elements(card(draft, canDecide)).find((e) => e.type === 'form')!.props.onSubmit as (e: unknown) => void)({ preventDefault: () => {} });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the "When" choice', () => {
  it('is drawn to an owner or admin on a new voucher for a category: two radios, "To be paid" chosen', () => {
    const found = radios(newCategory, true);
    expect(found).toHaveLength(2);
    expect(found.map((r) => r.props.checked)).toEqual([true, false]);
  });
  it('shows "Paid now" chosen when the form holds it', () => {
    expect(radios({ ...newCategory, paidNow: true }, true).map((r) => r.props.checked)).toEqual([false, true]);
  });
  it('is not drawn to a member', () => {
    expect(radios(newCategory, false)).toHaveLength(0);
  });
  it('is not drawn on a voucher for bills, or on a draft being edited, whoever looks', () => {
    for (const form of [billsDraft, billsNew, categoryDraft]) {
      expect(radios(form, true)).toHaveLength(0);
      expect(radios(form, false)).toHaveLength(0);
    }
  });
});

describe('what the first button sends', () => {
  it('sends paid_now when Paid now is chosen by an owner or admin', () => {
    submit({ ...newCategory, paidNow: true }, true);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ paid_now: true });
  });
  it('sends no paid_now by default, and none for a member even if the form holds Paid now', () => {
    submit(newCategory, true);
    expect(record.mock.calls[0][0]).not.toHaveProperty('paid_now');
    record.mockClear();
    submit({ ...newCategory, paidNow: true }, false);
    expect(record.mock.calls[0][0]).not.toHaveProperty('paid_now');
  });
  it('never records a draft or a voucher for bills as paid', () => {
    submit({ ...categoryDraft, paidNow: true }, true);
    submit({ ...billsNew, paidNow: true }, true);
    expect(record).not.toHaveBeenCalled();
  });
});
