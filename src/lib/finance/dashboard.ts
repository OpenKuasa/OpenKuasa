import type { BankAccountRow, BankTransactionRow } from './banking';
import type { LedgerAccount, LedgerLine } from './ledger';
import type { OpenDocument } from './reports';

/** What the Dashboard and Overview read. A null is a read that failed; the ledger reads never are. */
export type DashboardInputs = {
  lines: LedgerLine[];
  accounts: LedgerAccount[];
  receivables: OpenDocument[] | null;
  payables: OpenDocument[] | null;
  bankAccounts: BankAccountRow[] | null;
  bankTransactions: BankTransactionRow[] | null;
};
