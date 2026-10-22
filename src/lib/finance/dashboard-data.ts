import { listBankAccounts, listBankTransactions } from './banking';
import type { DashboardInputs } from './dashboard';
import { listLedgerAccounts, listLedgerLines } from './ledger';
import { openPayables, openReceivables } from './reports';
import { listOpenBills, listOpenInvoices } from './reports-data';
import type { FinanceWriteContext } from './result';

/**
 * Runs one read that the dashboards can do without: a failure is logged and becomes null, so the screen shows
 * that figure as unavailable instead of failing whole. The ledger reads are not wrapped; a failure of those is the page's.
 */
async function readOpen<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    console.error(`[finance] dashboard: ${what} could not be read:`, error);
    return null;
  }
}

/**
 * Everything the Bendahara Dashboard and Overview read, in one parallel round: the ledger lines and accounts
 * (a failure rejects), and the open invoices, open supplier bills, bank accounts and bank movements (a failure
 * of any one yields null for it alone).
 */
export async function loadDashboardInputs(ctx: FinanceWriteContext): Promise<DashboardInputs> {
  const [lines, accounts, receivables, payables, bankAccounts, bankTransactions] = await Promise.all([
    listLedgerLines(ctx),
    listLedgerAccounts(ctx),
    readOpen('the open invoices', async () => openReceivables(await listOpenInvoices(ctx))),
    readOpen('the open supplier bills', async () => openPayables(await listOpenBills(ctx))),
    readOpen('the bank accounts', () => listBankAccounts(ctx)),
    readOpen('the bank movements', () => listBankTransactions(ctx)),
  ]);
  return { lines, accounts, receivables, payables, bankAccounts, bankTransactions };
}
