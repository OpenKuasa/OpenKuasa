import { ReportsView } from '@/components/finance/reports-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listBills } from '@/lib/finance/bills';
import { listInvoices } from '@/lib/finance/invoices';
import { type LedgerAccount, listLedgerAccounts, listLedgerLines } from '@/lib/finance/ledger';
import { cashMovements, countUnassigned, monthlyTotals, type OpenDocument } from '@/lib/finance/reports';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_LEDGER_ACCOUNTS, SAMPLE_LEDGER_LINES, SAMPLE_PAYABLES, SAMPLE_RECEIVABLES } from './ledger-sample';
import { SAMPLE_TODAY } from './sales-sample';

/** The view needs only what names an account and says which statement it belongs to. */
const reportAccounts = (accounts: LedgerAccount[]) => accounts.map(({ id, code, name, type }) => ({ id, code, name, type }));

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
  // here, so the browser is sent the totals and not every line of the ledger. The invoices and bills are the
  // same reads the Invoices and Supplier Bills screens make for every member, a viewer included.
  const [lines, ledgerAccounts, invoices, bills] = await Promise.all([
    listLedgerLines(ctx),
    listLedgerAccounts(ctx),
    listInvoices(ctx),
    listBills(ctx),
  ]);
  const { totals } = monthlyTotals(lines);
  // Lines with no account, and lines whose account the other read did not return, are not in the statements.
  const unassigned = countUnassigned(lines, ledgerAccounts);
  // A posted invoice (sent, overdue or paid) can hold a balance: a customer in credit has one below zero, which
  // the view counts apart. A draft or void invoice is owed nothing. Only a bill still to be paid (pending or
  // overdue) is payable; a paid bill has no balance to age.
  const receivables: OpenDocument[] = invoices
    .filter((i) => i.display_status === 'sent' || i.display_status === 'overdue' || i.display_status === 'paid')
    .filter((i) => i.balance !== 0)
    .map((i) => ({ party_id: i.customer_id, party_name: i.customer_name, due_date: i.due_date, balance: i.balance }));
  const payables: OpenDocument[] = bills
    .filter((b) => (b.display_status === 'pending' || b.display_status === 'overdue') && b.balance > 0)
    .map((b) => ({ party_id: b.supplier_id, party_name: b.supplier_name, due_date: b.due_date, balance: b.balance }));
  return (
    <ReportsView
      accounts={reportAccounts(ledgerAccounts)}
      totals={totals}
      cash={cashMovements(lines, ledgerAccounts)}
      receivables={receivables}
      payables={payables}
      unassigned={unassigned}
      today={todayUtc()}
    />
  );
}
