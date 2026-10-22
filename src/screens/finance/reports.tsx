import { ReportsView } from '@/components/finance/reports-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { type LedgerAccount, listLedgerAccounts, listLedgerLines } from '@/lib/finance/ledger';
import { cashMovements, countUnassigned, monthlyTotals, openPayables, openReceivables, type OpenDocument } from '@/lib/finance/reports';
import { listOpenBills, listOpenInvoices, readFxBooks } from '@/lib/finance/reports-data';
import { financeSettingsOrDefault } from '@/lib/finance/settings';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_LEDGER_ACCOUNTS, SAMPLE_LEDGER_LINES, SAMPLE_PAYABLES, SAMPLE_RECEIVABLES } from './ledger-sample';
import { SAMPLE_TODAY } from './sales-sample';

/** The view needs only what names an account and says which statement it belongs to. */
const reportAccounts = (accounts: LedgerAccount[]) => accounts.map(({ id, code, name, type }) => ({ id, code, name, type }));

/**
 * The open documents behind an aged table, or what the books hold in foreign currency, or null when they cannot be
 * read: the statements were read, so the page shows without that table (which says it could not be loaded) or
 * without the balance sheet's revaluation note. The ledger reads are not caught; a failure of those is the page's.
 */
async function readOpen<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    console.error(`[finance] ReportsScreen: ${what} could not be read:`, error);
    return null;
  }
}

export default async function ReportsScreen() {
  if (!hasSupabaseEnv()) {
    const { totals, unassigned } = monthlyTotals(SAMPLE_LEDGER_LINES);
    return (
      <ReportsView
        accounts={reportAccounts(SAMPLE_LEDGER_ACCOUNTS)}
        totals={totals}
        cash={cashMovements(SAMPLE_LEDGER_LINES, SAMPLE_LEDGER_ACCOUNTS)}
        receivables={SAMPLE_RECEIVABLES}
        payables={SAMPLE_PAYABLES}
        unassigned={unassigned}
        today={SAMPLE_TODAY}
        followClock={false}
      />
    );
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  // Every member reads the books; there is nothing here to change. The lines are added up by account and month
  // here, so the browser is sent the totals and not every line of the ledger. The open invoices and bills are
  // read from the same views as the Invoices and Supplier Bills screens, which every member and viewer reads, but
  // only the columns and rows an aged table needs.
  const [lines, ledgerAccounts, receivables, payables, fxBooks, settings] = await Promise.all([
    listLedgerLines(ctx),
    listLedgerAccounts(ctx),
    readOpen<OpenDocument[]>('the open invoices', async () => openReceivables(await listOpenInvoices(ctx))),
    readOpen<OpenDocument[]>('the open supplier bills', async () => openPayables(await listOpenBills(ctx))),
    // Whether a balance sheet's month end holds foreign balances that are not revalued (plan decision 16).
    readOpen('what the books hold in foreign currency', () => readFxBooks(ctx)),
    // The month the financial year ends, for "This quarter" and "This year"; December when it cannot be read.
    financeSettingsOrDefault(ctx, 'ReportsScreen'),
  ]);
  const { totals } = monthlyTotals(lines);
  // Lines with no account, and lines whose account the other read did not return, are not in the statements.
  const unassigned = countUnassigned(lines, ledgerAccounts);
  return (
    <ReportsView
      accounts={reportAccounts(ledgerAccounts)}
      totals={totals}
      cash={cashMovements(lines, ledgerAccounts)}
      receivables={receivables}
      payables={payables}
      unassigned={unassigned}
      fxBooks={fxBooks}
      today={todayUtc()}
      yearEndMonth={settings.yearEndMonth}
    />
  );
}
