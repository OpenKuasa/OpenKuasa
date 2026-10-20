/**
 * The cash book: every movement of money, one row each. Cash Receipts lists
 * money in and Payment Vouchers money out, whatever it is for, so a payment
 * that Payments In, Payments Out or Refunds shows per document is one row
 * here. `kind` says what a row is and therefore which screen changes it.
 * This file only reads. A receipt's writes are in cash-receipts.ts and a
 * voucher's in vouchers.ts. org_id comes from the context.
 */
import { BASE_CURRENCY } from './currencies';
import { PAYMENT_PAGE_SIZE, type PaymentInRow, type PaymentMethod } from './money';
import type { FinanceWriteContext } from './result';

/** A movement of money is a `finance_transactions` row, and takes that table's statuses. */
export type CashBookStatus = PaymentInRow['status'];

/** `invoice`: a payment against invoices, also on Payments In. `income`: money that settles no invoice and carries a category. */
export type CashReceiptKind = 'invoice' | 'income';

/** One movement of money in. `transaction_id` is the row's key. A draft or voided receipt is included; callers filter. */
export type CashReceiptRow = {
  transaction_id: string;
  number: string | null;
  txn_date: string;
  method: PaymentMethod;
  amount: number;
  status: CashBookStatus;
  reference: string | null;
  notes: string | null;
  account_id: string;
  account_name: string;
  account_kind: 'bank' | 'cash';
  contact_id: string | null;
  /** Who paid: the contact's name, or the name that was typed. Nobody may be named. */
  party_name: string | null;
  kind: CashReceiptKind;
  category_id: string | null;
  category_name: string | null;
  /** The numbers of the invoices it pays, in order, separated by ", ". */
  documents: string | null;
  /**
   * `amount` is in the account's currency, `transaction_currency` (stage 5b); `amount_myr` is the ringgit received
   * (`amount` on a ringgit account). The reads always give them; they are optional so that rows made by hand
   * (samples, tests) need not, and are then ringgit.
   */
  transaction_currency?: string;
  amount_myr?: number;
};

/**
 * `bill`: a payment to a supplier, also on Payments Out. `refund`: money back
 * to a customer, also on Refunds. `expense`: a payment of approved expenses.
 * `other`: money that settles no document and carries a category.
 */
export type PaymentVoucherKind = 'bill' | 'refund' | 'expense' | 'other';

/** One movement of money out. `transaction_id` is the row's key. Every status is included; callers filter. */
export type PaymentVoucherRow = {
  transaction_id: string;
  number: string | null;
  txn_date: string;
  method: PaymentMethod;
  amount: number;
  status: CashBookStatus;
  reference: string | null;
  notes: string | null;
  account_id: string;
  account_name: string;
  account_kind: 'bank' | 'cash';
  contact_id: string | null;
  /** Who was paid: the contact's name, or the name that was typed. */
  party_name: string | null;
  kind: PaymentVoucherKind;
  /**
   * The payment's own category. A voucher of kind `other` carries one. A
   * payment to a supplier and a refund are recorded without one, and so is a
   * voucher that pays expenses (`finance_record_voucher` refuses one there),
   * so for kind `expense` this is null: the view gives the name of the
   * expenses' category and no id for it.
   */
  category_id: string | null;
  /**
   * `expense`: the name of the category its expenses share, or nothing when
   * they are of several. Every other kind: the name of the payment's own
   * category, which a bill and a refund do not have.
   */
  category_name: string | null;
  /** The numbers of the bills, invoices or credit notes it pays; an expense has no number. */
  documents: string | null;
  /** When an owner or admin approved or rejected it; null for a payment nobody had to approve. */
  approved_at: string | null;
  /**
   * `amount` is in the account's currency, `currency` (stage 5b); `amount_myr` is the ringgit that left (`amount` on
   * a ringgit account). The reads always give them; optional so that rows made by hand need not, and are then ringgit.
   */
  currency?: string;
  amount_myr?: number;
};

/** What a cash-book row adds to a ringgit figure: its ringgit, which on a ringgit account is its amount. */
export function cashBookRinggit(row: { amount: number; amount_myr?: number }): number {
  return row.amount_myr ?? row.amount;
}

/**
 * The currency a cash-book row's `amount` is in: the account's. A receipt reads it as `transaction_currency` (its
 * view's `currency` is the invoices'), a voucher as `currency`.
 */
export function cashBookCurrency(row: { transaction_currency?: string; currency?: string }): string {
  return row.transaction_currency ?? row.currency ?? BASE_CURRENCY;
}

const SHARED_COLUMNS =
  'transaction_id,number,txn_date,method,amount,status,reference,notes,account_id,account_name,account_kind,' +
  'contact_id,party_name,kind,category_id,category_name,documents';
// Stage 5b: the movement's currency and its ringgit. A receipt's `currency` is the invoices' (3b); its movement's is
// `transaction_currency`. A voucher's `currency` is its movement's.
const CASH_RECEIPT_COLUMNS = `${SHARED_COLUMNS},transaction_currency,amount_myr`;
const PAYMENT_VOUCHER_COLUMNS = `${SHARED_COLUMNS},approved_at,currency,amount_myr`;

/** Every row of one of the two cash book views, newest first, read a page at a time. */
async function listCashBookRows<T extends { amount: number }>(
  ctx: FinanceWriteContext,
  view: 'finance_cash_receipts' | 'finance_payment_vouchers',
  columns: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAYMENT_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from(view)
      .select(columns)
      .eq('org_id', ctx.orgId)
      .order('txn_date', { ascending: false })
      .order('transaction_id', { ascending: true })
      .range(from, from + PAYMENT_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(
      ...page.map((row) => ({
        ...(row as unknown as T),
        amount: Number(row.amount),
        ...('amount_myr' in row && row.amount_myr !== null ? { amount_myr: Number(row.amount_myr) } : {}),
      })),
    );
    if (page.length < PAYMENT_PAGE_SIZE) return rows;
  }
}

/** Every movement of money in. */
export async function listCashReceipts(ctx: FinanceWriteContext): Promise<CashReceiptRow[]> {
  return listCashBookRows<CashReceiptRow>(ctx, 'finance_cash_receipts', CASH_RECEIPT_COLUMNS);
}

/** Every movement of money out. */
export async function listPaymentVouchers(ctx: FinanceWriteContext): Promise<PaymentVoucherRow[]> {
  return listCashBookRows<PaymentVoucherRow>(ctx, 'finance_payment_vouchers', PAYMENT_VOUCHER_COLUMNS);
}
