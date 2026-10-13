import type { AccountStandsFor, AccountType, JournalRow, LedgerAccount, LedgerLine } from '@/lib/finance/ledger';
import type { OpenDocument } from '@/lib/finance/reports';
import { round2 } from '@/lib/finance/view-helpers';

/**
 * The ledger of an invented workspace (Rimba Ventures Sdn Bhd), shown by Chart of Accounts, Journals and Reports when no
 * database is connected. The accounts' totals are worked out from the lines, so the books balance by
 * construction: every entry below has equal debits and credits.
 */

type SampleAccount = { id: string; code: string; name: string; type: AccountType; stands_for: AccountStandsFor; active?: boolean };

const BASE_ACCOUNTS: SampleAccount[] = [
  { id: 'acc-1000', code: '1000', name: 'Cash in Hand', type: 'asset', stands_for: 'bank' },
  { id: 'acc-1100', code: '1100', name: 'Main Bank', type: 'asset', stands_for: 'bank' },
  { id: 'acc-1200', code: '1200', name: 'Trade Receivables', type: 'asset', stands_for: 'system' },
  { id: 'acc-1500', code: '1500', name: 'Accumulated Depreciation', type: 'asset', stands_for: 'own' },
  { id: 'acc-2000', code: '2000', name: 'Trade Payables', type: 'liability', stands_for: 'system' },
  { id: 'acc-2050', code: '2050', name: 'Accrued Expenses', type: 'liability', stands_for: 'system' },
  { id: 'acc-2100', code: '2100', name: 'SST Payable', type: 'liability', stands_for: 'system' },
  { id: 'acc-3000', code: '3000', name: 'Owner’s Capital', type: 'equity', stands_for: 'system' },
  { id: 'acc-4000', code: '4000', name: 'Sales', type: 'income', stands_for: 'system' },
  { id: 'acc-5000', code: '5000', name: 'Purchases', type: 'expense', stands_for: 'category' },
  { id: 'acc-6100', code: '6100', name: 'Office Rent', type: 'expense', stands_for: 'category' },
  { id: 'acc-6200', code: '6200', name: 'Depreciation', type: 'expense', stands_for: 'own' },
  { id: 'acc-6300', code: '6300', name: 'Utilities', type: 'expense', stands_for: 'category' },
  { id: 'acc-6900', code: '6900', name: 'Courier (old)', type: 'expense', stands_for: 'own', active: false },
];

const SAMPLE_JOURNAL_ID = '33333333-3333-4333-8333-333333333333';

type Side = { account_id: string; debit: number; credit: number };

function entry(
  key: string,
  date: string,
  source: LedgerLine['source'],
  source_id: string,
  source_no: string | null,
  description: string,
  sides: Side[],
): LedgerLine[] {
  return sides.map((s) => ({ entry_key: key, entry_date: date, source, source_id, source_no, description, ...s }));
}

/**
 * Twelve entries over four months (July to October 2026): an opening balance, three invoices, two bills, a
 * receipt, a payment, an expense (accrued) and its payment, a manual journal and a second receipt, so the Reports screen has months to compare.
 */
export const SAMPLE_LEDGER_LINES: LedgerLine[] = [
  ...entry('opening:bank-1100', '2026-07-01', 'opening', 'bank-1100', null, 'Opening balance of Main Bank', [
    { account_id: 'acc-1100', debit: 50_000, credit: 0 },
    { account_id: 'acc-3000', debit: 0, credit: 50_000 },
  ]),
  ...entry('invoice:inv-1', '2026-07-15', 'invoice', 'inv-1', 'INV-0001', 'Invoice INV-0001 to Aisyah Trading', [
    { account_id: 'acc-1200', debit: 2_120, credit: 0 },
    { account_id: 'acc-4000', debit: 0, credit: 2_000 },
    { account_id: 'acc-2100', debit: 0, credit: 120 },
  ]),
  ...entry('bill:bill-1', '2026-08-05', 'bill', 'bill-1', 'BILL-0001', 'Bill from Kopi Hulu Supplies', [
    { account_id: 'acc-5000', debit: 1_500, credit: 0 },
    { account_id: 'acc-2000', debit: 0, credit: 1_500 },
  ]),
  ...entry('payment_in:rcp-1', '2026-08-20', 'payment_in', 'rcp-1', 'RCP-0001', 'Receipt from Aisyah Trading', [
    { account_id: 'acc-1100', debit: 2_120, credit: 0 },
    { account_id: 'acc-1200', debit: 0, credit: 2_120 },
  ]),
  ...entry('invoice:inv-2', '2026-09-12', 'invoice', 'inv-2', 'INV-0002', 'Invoice INV-0002 to Bunga Raya Cafe', [
    { account_id: 'acc-1200', debit: 3_180, credit: 0 },
    { account_id: 'acc-4000', debit: 0, credit: 3_000 },
    { account_id: 'acc-2100', debit: 0, credit: 180 },
  ]),
  ...entry('bill:bill-2', '2026-09-25', 'bill', 'bill-2', 'BILL-0002', 'Bill from Tenaga Utilities', [
    { account_id: 'acc-6300', debit: 350, credit: 0 },
    { account_id: 'acc-2000', debit: 0, credit: 350 },
  ]),
  ...entry('expense:exp-1', '2026-10-01', 'expense', 'exp-1', 'EXP-0001', 'October office rent', [
    { account_id: 'acc-6100', debit: 1_200, credit: 0 },
    { account_id: 'acc-2050', debit: 0, credit: 1_200 },
  ]),
  ...entry('payment_out:pay-2', '2026-10-01', 'payment_out', 'pay-2', 'PAY-0002', 'Payment of EXP-0001', [
    { account_id: 'acc-2050', debit: 1_200, credit: 0 },
    { account_id: 'acc-1100', debit: 0, credit: 1_200 },
  ]),
  ...entry('payment_out:pay-1', '2026-10-02', 'payment_out', 'pay-1', 'PAY-0001', 'Payment to Kopi Hulu Supplies', [
    { account_id: 'acc-2000', debit: 800, credit: 0 },
    { account_id: 'acc-1100', debit: 0, credit: 800 },
  ]),
  ...entry(`journal:${SAMPLE_JOURNAL_ID}`, '2026-10-05', 'journal', SAMPLE_JOURNAL_ID, 'JNL-0001', 'Depreciation of office equipment', [
    { account_id: 'acc-6200', debit: 400, credit: 0 },
    { account_id: 'acc-1500', debit: 0, credit: 400 },
  ]),
  ...entry('invoice:inv-3', '2026-10-08', 'invoice', 'inv-3', 'INV-0003', 'Invoice INV-0003 to Aisyah Trading', [
    { account_id: 'acc-1200', debit: 4_240, credit: 0 },
    { account_id: 'acc-4000', debit: 0, credit: 4_000 },
    { account_id: 'acc-2100', debit: 0, credit: 240 },
  ]),
  ...entry('payment_in:rcp-2', '2026-10-09', 'payment_in', 'rcp-2', 'RCP-0002', 'Receipt from Bunga Raya Cafe', [
    { account_id: 'acc-1100', debit: 3_180, credit: 0 },
    { account_id: 'acc-1200', debit: 0, credit: 3_180 },
  ]),
];

/**
 * What the sample books above still owe, for the aged tables on Reports: INV-0003 is the 4,240.00 left on
 * Trade Receivables, and the two bills are the 1,050.00 left on Trade Payables (BILL-0001 less its 800.00 payment, and BILL-0002).
 */
export const SAMPLE_RECEIVABLES: OpenDocument[] = [
  { party_id: 'sample-customer-aisyah', party_name: 'Aisyah Trading', due_date: '2026-11-07', balance: 4_240 },
];
export const SAMPLE_PAYABLES: OpenDocument[] = [
  { party_id: 'sample-supplier-kopi-hulu', party_name: 'Kopi Hulu Supplies', due_date: '2026-09-04', balance: 700 },
  { party_id: 'sample-supplier-tenaga', party_name: 'Tenaga Utilities', due_date: '2026-10-25', balance: 350 },
];

/** The sample accounts, each with the totals of its own lines (a debit-normal account reads debit less credit). */
export const SAMPLE_LEDGER_ACCOUNTS: LedgerAccount[] = BASE_ACCOUNTS.map((a) => {
  const mine = SAMPLE_LEDGER_LINES.filter((l) => l.account_id === a.id);
  const debit_total = round2(mine.reduce((total, l) => total + l.debit, 0));
  const credit_total = round2(mine.reduce((total, l) => total + l.credit, 0));
  const debitNormal = a.type === 'asset' || a.type === 'expense';
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    type: a.type,
    active: a.active ?? true,
    stands_for: a.stands_for,
    system_key: null,
    bank_account_id: null,
    category_id: null,
    default_for: null,
    debit_total,
    credit_total,
    balance: round2(debitNormal ? debit_total - credit_total : credit_total - debit_total),
  };
});

/** The one manual journal, posted. */
export const SAMPLE_JOURNALS: JournalRow[] = [
  {
    id: SAMPLE_JOURNAL_ID,
    journal_no: 'JNL-0001',
    journal_date: '2026-10-05',
    description: 'Depreciation of office equipment',
    status: 'posted',
    reverses_journal_id: null,
    reversed: false,
  },
];
