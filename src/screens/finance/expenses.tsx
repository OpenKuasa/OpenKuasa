import { ExpensesView } from '@/components/finance/expenses-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { expensesView } from '@/lib/finance/cash-book-views';
import { listExpenses } from '@/lib/finance/expenses';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_EXPENSES } from './cash-book-sample';
import { SAMPLE_TODAY } from './sales-sample';

/** Every expense. Read-only for everyone until the expense form and approval arrive. */
export default async function ExpensesScreen() {
  if (!hasSupabaseEnv()) {
    return <ExpensesView rows={SAMPLE_EXPENSES} view={expensesView(SAMPLE_EXPENSES, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const rows = await listExpenses(ctx);
  return <ExpensesView rows={rows} view={expensesView(rows, todayUtc())} />;
}
