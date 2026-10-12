/**
 * Sample banking data (Rimba Ventures Sdn Bhd), shown on Banking when there
 * is no database. Banking lists every movement of money, so the sample's
 * receipts and vouchers are its movements: the same money on Cash Receipts
 * or Payment Vouchers and on Banking, once each. Two transfers between
 * accounts are added, which the cash book never shows. Each account's
 * balance is its opening balance and its posted movements added up, as the
 * database works it out.
 */
import type { BankAccountRow, BankTransactionRow } from '@/lib/finance/banking';
import type { CashReceiptRow, PaymentVoucherRow } from '@/lib/finance/cash-book';
import { SAMPLE_CASH_RECEIPTS, SAMPLE_PAYMENT_VOUCHERS } from './cash-book-sample';

/** The statement was imported on the 7th: bank movements up to the day before are matched. */
const RECONCILED_UP_TO = '2026-10-06';
const LAST_IMPORT_AT = '2026-10-07T03:00:00Z';

const movement = (row: CashReceiptRow | PaymentVoucherRow, direction: 'in' | 'out'): BankTransactionRow => ({
  transaction_id: row.transaction_id,
  account_id: row.account_id,
  account_name: row.account_name,
  account_kind: row.account_kind,
  direction,
  txn_date: row.txn_date,
  amount: row.amount,
  status: row.status,
  number: row.number,
  method: row.method,
  reference: row.reference,
  notes: row.notes,
  party_name: row.party_name,
  kind: row.kind,
  category_name: row.category_name,
  documents: row.documents,
  transfer_id: null,
  other_account_name: null,
  reconciled: row.status === 'posted' && row.account_kind === 'bank' && row.txn_date <= RECONCILED_UP_TO,
  created_at: `${row.txn_date}T02:00:00Z`,
});

const ACCOUNT_NAMES = { bank: 'Main Bank', cash: 'Cash in hand', savings: 'Savings' } as const;
type AccountKey = keyof typeof ACCOUNT_NAMES;

/** Both sides of one transfer, as the two rows they are. */
const transfer = (n: number, txn_date: string, from: AccountKey, to: AccountKey, amount: number, notes: string): BankTransactionRow[] =>
  (['out', 'in'] as const).map((direction) => {
    const here = direction === 'out' ? from : to;
    const there = direction === 'out' ? to : from;
    return {
      transaction_id: `sample-transfer-${n}-${direction}`,
      account_id: here,
      account_name: ACCOUNT_NAMES[here],
      account_kind: here === 'cash' ? 'cash' : 'bank',
      direction,
      txn_date,
      amount,
      status: 'posted',
      number: `TR-${String(n).padStart(4, '0')}`,
      method: from === 'cash' || to === 'cash' ? 'cash' : 'bank_transfer',
      reference: null,
      notes,
      party_name: null,
      kind: 'transfer',
      category_name: null,
      documents: null,
      transfer_id: `sample-transfer-${n}`,
      other_account_name: ACCOUNT_NAMES[there],
      reconciled: here === 'bank' && txn_date <= RECONCILED_UP_TO,
      created_at: `${txn_date}T04:00:00Z`,
    };
  });

/** Newest first, as the real list is. */
export const SAMPLE_BANK_TRANSACTIONS: BankTransactionRow[] = [
  ...SAMPLE_CASH_RECEIPTS.map((row) => movement(row, 'in')),
  ...SAMPLE_PAYMENT_VOUCHERS.map((row) => movement(row, 'out')),
  ...transfer(1, '2026-09-05', 'bank', 'savings', 2000, 'Monthly sweep to savings'),
  ...transfer(2, '2026-10-02', 'cash', 'bank', 1500, 'Counter takings banked'),
  ...transfer(3, '2026-10-07', 'bank', 'savings', 2000, 'Monthly sweep to savings'),
].sort((x, y) => y.txn_date.localeCompare(x.txn_date) || y.created_at.localeCompare(x.created_at));

const account = (
  id: AccountKey,
  kind: 'bank' | 'cash',
  bank_name: string | null,
  opening_balance: number,
  last_import_at: string | null,
  unmatched_lines: number,
): BankAccountRow => {
  const mine = SAMPLE_BANK_TRANSACTIONS.filter((t) => t.account_id === id);
  const posted = mine.filter((t) => t.status === 'posted');
  const net = posted.reduce((total, t) => total + (t.direction === 'in' ? t.amount : -t.amount), 0);
  const toBePaid = mine.filter((t) => t.direction === 'out' && t.status === 'scheduled').reduce((total, t) => total + t.amount, 0);
  return {
    id,
    name: ACCOUNT_NAMES[id],
    kind,
    bank_name,
    opening_balance,
    opening_date: '2026-03-01',
    active: true,
    balance: Math.round((opening_balance + net) * 100) / 100,
    to_be_paid: Math.round(toBePaid * 100) / 100,
    last_import_at,
    unmatched_lines,
  };
};

/** Bank accounts first, then by name, as the real list is. */
export const SAMPLE_BANK_ACCOUNTS: BankAccountRow[] = [
  account('bank', 'bank', 'Maybank', 60000, LAST_IMPORT_AT, 2),
  account('savings', 'bank', 'CIMB Bank', 4100, null, 0),
  account('cash', 'cash', null, 9000, null, 0),
];
