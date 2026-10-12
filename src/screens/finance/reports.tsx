import { ReportsView } from '@/components/finance/reports-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { type LedgerAccount, listLedgerAccounts, listLedgerLines } from '@/lib/finance/ledger';
import { countUnassigned, monthlyTotals } from '@/lib/finance/reports';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_LEDGER_ACCOUNTS, SAMPLE_LEDGER_LINES } from './ledger-sample';
import { SAMPLE_TODAY } from './sales-sample';

/** The view needs only what names an account and says which statement it belongs to. */
const reportAccounts = (accounts: LedgerAccount[]) => accounts.map(({ id, code, name, type }) => ({ id, code, name, type }));

export default async function ReportsScreen() {
  if (!hasSupabaseEnv()) {
    const { totals, unassigned } = monthlyTotals(SAMPLE_LEDGER_LINES);
    return <ReportsView accounts={reportAccounts(SAMPLE_LEDGER_ACCOUNTS)} totals={totals} unassigned={unassigned} today={SAMPLE_TODAY} followClock={false} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  // Every member reads the books; there is nothing here to change. The lines are added up by account and month
  // here, so the browser is sent the totals and not every line of the ledger.
  const [lines, ledgerAccounts] = await Promise.all([listLedgerLines(ctx), listLedgerAccounts(ctx)]);
  const { totals } = monthlyTotals(lines);
  // Lines with no account, and lines whose account the other read did not return, are not in the statements.
  const unassigned = countUnassigned(lines, ledgerAccounts);
  return <ReportsView accounts={reportAccounts(ledgerAccounts)} totals={totals} unassigned={unassigned} today={todayUtc()} />;
}
