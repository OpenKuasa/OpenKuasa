import { BankingView } from '@/components/finance/banking-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listBankAccounts, listBankTransactions } from '@/lib/finance/banking';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_BANK_ACCOUNTS, SAMPLE_BANK_TRANSACTIONS } from './banking-sample';
import { SAMPLE_TODAY } from './sales-sample';

/** Accounts, balances and every movement of money. Read-only for everyone until the banking forms arrive. */
export default async function BankingScreen() {
  if (!hasSupabaseEnv()) {
    return <BankingView accounts={SAMPLE_BANK_ACCOUNTS} rows={SAMPLE_BANK_TRANSACTIONS} today={SAMPLE_TODAY} followClock={false} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const [accounts, rows] = await Promise.all([listBankAccounts(ctx), listBankTransactions(ctx)]);
  return <BankingView accounts={accounts} rows={rows} today={todayUtc()} />;
}
